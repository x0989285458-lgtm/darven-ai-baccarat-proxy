import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  RECORD_PROTOCOL_EVIDENCE,
  buildRecordRequest,
  createAuthoritativeReplayProvider,
  createIndependentSessionTokenGate,
  parseRecordResponse,
  sessionTokenFingerprint,
} from '../src/record-replay.js'
import { createGapDetector } from '../src/gap-detector.js'
import { createFinalJournal } from '../src/final-journal.js'
import { createBackupJournalReplayProvider } from '../src/backup-journal-replay.js'

test('Record evidence stays fail-closed until endpoint payload and prerequisite are verified', () => {
  assert.equal(RECORD_PROTOCOL_EVIDENCE.action, '/api/v1/gametype/*/game/*/record')
  assert.equal(RECORD_PROTOCOL_EVIDENCE.observed.err, 0)
  assert.equal(RECORD_PROTOCOL_EVIDENCE.observed.nonempty, 0)
  assert.equal(RECORD_PROTOCOL_EVIDENCE.contractStatus, 'unverified')
  assert.throws(() => buildRecordRequest({ tableId: 'BAG01', roomId: 29, shoe: 91, round: 8 }), /record_contract_unverified/)
})

test('offline Record parser accepts only validator-clean summary Finals', () => {
  const response = {
    err: 0,
    msg: { game: [
      { table_id: 'BAG01', room_id: 29, shoe: 91, round: 8, action: 'summary', result: '1,2,3,4,0,0,0,0,4,6' },
      { table_id: 'BAG01', room_id: 29, shoe: 91, round: 9, action: 'show_poker', result: '1,2,3,4,0,0,0,0,4,6' },
      { table_id: 'BAG01', room_id: 29, shoe: 91, round: 10, action: 'show_win', result: '1,2,3,4,0,0,0,0,7,6' },
      { table_id: 'BAG01', room_id: 29, shoe: 91, round: 11, action: 'summary', result: '1,2,3' },
    ] },
  }
  const events = parseRecordResponse(response)
  assert.deepEqual(events.map((event) => [event.round, event.sourceAction, event.winner]), [
    [8, 'summary', 'banker'],
  ])
})

test('gap detector reports exact same-shoe missing rounds and fail-closed cross-shoe gap', () => {
  const detector = createGapDetector()
  const sameShoe = detector.detect({
    tables: [{ tableId: 'BAG01', shoe: 91, round: 11 }],
    cursors: new Map([['BAG01', { shoe: 91, round: 7 }]]),
  })
  assert.deepEqual(sameShoe, [{ type: 'same_shoe', tableId: 'BAG01', shoe: 91, rounds: [8, 9, 10] }])

  const crossShoe = detector.detect({
    tables: [{ tableId: 'BAG01', shoe: 92, round: 3 }],
    cursors: new Map([['BAG01', { shoe: 91, round: 70 }]]),
  })
  assert.deepEqual(crossShoe, [{ type: 'cross_shoe', tableId: 'BAG01', from: { shoe: 91, round: 70 }, to: { shoe: 92, round: 3 } }])
  assert.equal(detector.liveAckAllowed(crossShoe), false)
})

test('fallback replay provider preserves a second independent token Live Gate', async () => {
  const recordProvider = { available: false, reason: 'record_contract_unverified' }
  const backupProvider = { replay: async () => [finalEvent(8)] }
  const blocked = createAuthoritativeReplayProvider({ recordProvider, backupProvider })
  assert.deepEqual(await blocked.replay({ tableId: 'BAG01' }), {
    ok: false, events: [], liveGate: 'second_independent_session_token_required',
  })

  const enabled = createAuthoritativeReplayProvider({
    recordProvider, backupProvider,
    verifyBackupSession: async () => ({ ok: true, backupFingerprint: sessionTokenFingerprint('backup-token') }),
  })
  assert.deepEqual(await enabled.replay({ tableId: 'BAG01' }), { ok: true, events: [finalEvent(8)], provider: 'backup_journal' })
})

test('deprecated second-token boolean cannot bypass failed actual token fingerprint verification', async () => {
  const replayProvider = createAuthoritativeReplayProvider({
    recordProvider: { available: false, reason: 'record_contract_unverified' },
    backupProvider: { replay: async () => [finalEvent(8)] },
    secondTokenAvailable: true,
    verifyBackupSession: async () => ({ ok: false, liveGate: 'second_independent_session_token_required' }),
  })

  assert.deepEqual(await replayProvider.replay({ tableId: 'BAG01' }), {
    ok: false, events: [], liveGate: 'second_independent_session_token_required',
  })
})

test('backup replay reads only an independent owner journal and returns exact requested gap identities', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-backup-replay-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const journalPath = path.join(dir, 'backup-finals.jsonl')
  const journal = await createFinalJournal({ journalPath, assertSource: () => true })
  const backupFingerprint = sessionTokenFingerprint('backup-token')
  await journal.writeHeader({ sessionFingerprint: backupFingerprint, ownerId: 'independent-backup' })
  for (const round of [8, 9, 10]) await journal.append({
    ...finalEvent(round),
    source: { mode: 'api', ownerId: 'independent-backup', epoch: 1, fence: 'backup-fence', sequence: round },
  })

  const provider = createBackupJournalReplayProvider({ journalPath, primaryOwnerId: 'api-primary' })
  const context = { sessionFingerprint: backupFingerprint }
  assert.deepEqual((await provider.replay({ type: 'same_shoe', tableId: 'BAG01', shoe: 91, rounds: [8, 9, 10] }, context)).events.map((event) => event.round), [8, 9, 10])
  await assert.rejects(provider.replay({ type: 'same_shoe', tableId: 'BAG01', shoe: 91, rounds: [8, 9, 10, 11] }, context), /backup_journal_incomplete/)
  const blocked = createBackupJournalReplayProvider({ journalPath, primaryOwnerId: 'independent-backup' })
  await assert.rejects(blocked.replay({ type: 'same_shoe', tableId: 'BAG01', shoe: 91, rounds: [8] }, context), /second_independent_session_token_required/)
})

test('cross-shoe replay rejects a lone pending new-shoe Final without closed-tail and contiguous coverage proof', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-backup-cross-shoe-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const journalPath = path.join(dir, 'backup-finals.jsonl')
  const journal = await createFinalJournal({ journalPath, assertSource: () => true })
  const backupFingerprint = sessionTokenFingerprint('backup-cross-token')
  await journal.writeHeader({ sessionFingerprint: backupFingerprint, ownerId: 'independent-backup' })
  await journal.append({
    ...finalEvent(2), shoe: 92,
    source: { mode: 'api', ownerId: 'independent-backup', epoch: 1, fence: 'backup-fence', sequence: 2 },
  })
  const provider = createBackupJournalReplayProvider({ journalPath, primaryOwnerId: 'api-primary' })

  await assert.rejects(
    provider.replay({ type: 'cross_shoe', tableId: 'BAG01', from: { shoe: 91, round: 70 }, to: { shoe: 92, round: 3 } }, { sessionFingerprint: backupFingerprint }),
    /backup_journal_incomplete/,
  )

  await journal.append({
    ...finalEvent(1), shoe: 92,
    source: { mode: 'api', ownerId: 'independent-backup', epoch: 1, fence: 'backup-fence', sequence: 1 },
  })
  await journal.closeShoe({ tableId: 'BAG01', shoe: 91, finalRound: 70 })
  const complete = await provider.replay({ type: 'cross_shoe', tableId: 'BAG01', from: { shoe: 91, round: 70 }, to: { shoe: 92, round: 3 } }, { sessionFingerprint: backupFingerprint })
  assert.deepEqual(complete.events.map((event) => [event.shoe, event.round]), [[92, 1], [92, 2]])
  assert.deepEqual(complete.coverage, {
    type: 'cross_shoe', tableId: 'BAG01', from: { shoe: 91, round: 70 }, to: { shoe: 92, round: 3 },
  })
})

test('actual token gate hashes distinct values and rejects missing or equal backup values without exposing tokens', async () => {
  const distinct = createIndependentSessionTokenGate({
    readPrimaryToken: async () => 'primary-secret', readBackupToken: async () => 'backup-secret',
  })
  assert.deepEqual(await distinct(), {
    ok: true,
    primaryFingerprint: sessionTokenFingerprint('primary-secret'),
    backupFingerprint: sessionTokenFingerprint('backup-secret'),
  })
  for (const readBackupToken of [async () => '', async () => 'primary-secret', async () => { throw new Error('missing') }]) {
    const blocked = createIndependentSessionTokenGate({ readPrimaryToken: async () => 'primary-secret', readBackupToken })
    assert.deepEqual(await blocked(), { ok: false, liveGate: 'second_independent_session_token_required' })
  }
})

function finalEvent(round) {
  return {
    tableId: 'BAG01', shoe: 91, round, winner: 'banker', sourceAction: 'summary', final: true,
    rawResult: [1, 2, 3, 4, 0, 0, 0, 0, 4, 6], playerPoint: 4, bankerPoint: 6,
  }
}
