import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createSnapshotPusher } from '../src/snapshot-pusher.js'
import { createFinalJournal } from '../src/final-journal.js'

test('delivery binds owner epoch fence to envelope and only ACKs after exact fenced response', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-fenced-push-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const acknowledged = []
  const source = { mode: 'api', ownerId: 'api-primary', epoch: 5, fence: 'fence-5' }
  const round = {
    tableId: 'BAG01', shoe: 100, round: 4, winner: 'banker', sourceAction: 'summary', final: true,
    rawResult: [1, 2, 3, 4, 0, 0, 0, 0, 4, 6],
    source: { ...source, sequence: 9 },
  }
  let attempts = 0
  const pusher = createSnapshotPusher({
    targetUrl: 'https://render.example/api/cloud-ingest/snapshot', key: 'worker-key',
    queuePath: path.join(dir, 'queue.json'), now: () => 10_000,
    isRoundDeliverable: () => true,
    getSnapshot: async () => ({ sessionId: 'api-owner', buildVersion: '105', source, tables: [], rounds: [round] }),
    onAcknowledged: async (receipt) => acknowledged.push(receipt),
    fetchImpl: async (_url, options) => {
      attempts += 1
      const envelope = JSON.parse(options.body)
      assert.deepEqual(envelope.source, source)
      assert.deepEqual(envelope.snapshot.rounds[0].source, round.source)
      return {
        status: 200, ok: true,
        json: async () => ({ ok: true, accepted: true, sessionId: envelope.sessionId, sequence: envelope.sequence, acceptedRoundKeys: envelope.roundKeys, source }),
      }
    },
  })

  assert.equal(await pusher.tick(), true)
  assert.equal(attempts, 1)
  assert.deepEqual(acknowledged, [{ sessionId: 'api-owner', sequence: 10_000, acceptedRoundKeys: ['BAG01:100:4'], source }])
})

test('epoch2 restart atomically rebinds every persisted queue round before any delivery', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-fenced-restart-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const queuePath = path.join(dir, 'queue.json')
  const cursorPath = `${queuePath}.cursor.json`
  const epoch1 = { mode: 'api', ownerId: 'api-primary', epoch: 1, fence: 'fence-1' }
  const epoch2 = { mode: 'api', ownerId: 'api-primary', epoch: 2, fence: 'fence-2' }
  const captured = { ...epoch1, sequence: 7 }
  const baseRound = {
    tableId: 'BAG01', shoe: 100, round: 4, winner: 'banker', sourceAction: 'summary', final: true,
    rawResult: [1, 2, 3, 4, 0, 0, 0, 0, 4, 6], source: captured,
  }
  const first = createSnapshotPusher({
    targetUrl: 'https://render.example/api/cloud-ingest/snapshot', key: 'worker-key', queuePath,
    now: () => 10_000, isRoundDeliverable: () => true,
    getSnapshot: async () => ({ sessionId: 'worker-api-primary-1', buildVersion: '105', source: epoch1, tables: [], rounds: [baseRound] }),
    fetchImpl: async () => { throw new Error('offline') },
  })
  assert.equal(await first.tick(), false)

  const reboundRound = { ...baseRound, capturedSource: captured, source: { ...epoch2, sequence: 101 } }
  let delivered = null
  const currentTables = [{ tableId: 'BAG01', shoe: 100, round: 5 }]
  const second = createSnapshotPusher({
    targetUrl: 'https://render.example/api/cloud-ingest/snapshot', key: 'worker-key', queuePath,
    now: () => 20_000, isRoundDeliverable: () => true,
    getSnapshot: async () => ({ sessionId: 'worker-api-primary-2', buildVersion: '105', source: epoch2, connected: true, authenticated: true, tables: currentTables, rounds: [reboundRound] }),
    onRebindQueue: async ({ roundKeys }) => {
      assert.deepEqual(roundKeys, ['BAG01:100:4'])
      return [reboundRound]
    },
    fetchImpl: async (_url, options) => {
      delivered = JSON.parse(options.body)
      const diskQueue = JSON.parse(await readFile(queuePath, 'utf8'))
      const diskCursor = JSON.parse(await readFile(cursorPath, 'utf8'))
      assert.equal(diskQueue.entries[0].source.epoch, 2, 'queue rewrite must complete before fetch')
      assert.equal(diskQueue.entries[0].snapshot.rounds[0].source.sequence, 101)
      assert.ok(diskCursor.lastSequence >= diskQueue.entries[0].sequence, 'checkpoint must be durable before fetch')
      return {
        status: 200, ok: true,
        json: async () => ({ accepted: true, sessionId: delivered.sessionId, sequence: delivered.sequence, acceptedRoundKeys: delivered.roundKeys, source: epoch2 }),
      }
    },
  })
  assert.equal(await second.tick(), true)
  assert.deepEqual(delivered.source, epoch2)
  assert.equal(delivered.sessionId, 'worker-api-primary-2')
  assert.notEqual(delivered.sequence, 10_000)
  assert.deepEqual(delivered.snapshot.rounds[0].capturedSource, captured)
  assert.deepEqual(delivered.snapshot.rounds[0].source, { ...epoch2, sequence: 101 })
  assert.deepEqual(delivered.snapshot.tables, currentTables, 'rebound backlog must carry the fresh current table snapshot')
  assert.equal(delivered.snapshot.connected, true)
  assert.equal(delivered.snapshot.authenticated, true)
  assert.equal(delivered.snapshot.rounds[0].winner, baseRound.winner)
  assert.deepEqual(delivered.snapshot.rounds[0].rawResult, baseRound.rawResult)
})

test('Reviewer P1 ACK crash: checkpoint after exact remote ACK recovers journal ACK before any rebind or re-push', async (t) => {
  await assertRemoteAckCrashRecovery(t, 'after_remote_ack_checkpoint')
})

test('Reviewer P1 ACK crash: journal ACK before queue delete recovers idempotently without duplicate or stateInvalid', async (t) => {
  await assertRemoteAckCrashRecovery(t, 'after_journal_ack')
})

async function assertRemoteAckCrashRecovery(t, crashPhase) {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-ack-crash-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const queuePath = path.join(dir, 'queue.json')
  const journalPath = path.join(dir, 'finals.jsonl')
  const source = { mode: 'api', ownerId: 'api-primary', epoch: 5, fence: 'fence-5' }
  const round = {
    tableId: 'BAG01', shoe: 100, round: 4, winner: 'banker', sourceAction: 'summary', final: true,
    rawResult: [1, 2, 3, 4, 0, 0, 0, 0, 4, 6], source: { ...source, sequence: 9 },
  }
  const journal = await createFinalJournal({ journalPath, assertSource: () => true })
  await journal.append(round)
  let remotePushes = 0
  let rebinds = 0
  const acknowledgeJournal = async ({ acceptedRoundKeys }) => {
    const accepted = new Set(acceptedRoundKeys)
    for (const entry of journal.pending()) if (accepted.has(entry.identity)) await journal.ack(entry.identity, entry.hash)
  }
  const snapshot = async () => ({ sessionId: 'api-owner', buildVersion: '105', source, tables: [], rounds: [round] })
  const first = createSnapshotPusher({
    targetUrl: 'https://render.example/api/cloud-ingest/snapshot', key: 'worker-key', queuePath,
    now: () => 10_000, isRoundDeliverable: () => true, getSnapshot: snapshot,
    onAcknowledged: acknowledgeJournal,
    onRebindQueue: async () => { rebinds += 1; return [round] },
    faultInjector: async (phase) => { if (phase === crashPhase) throw new Error(`injected_crash:${phase}`) },
    fetchImpl: async (_url, options) => {
      remotePushes += 1
      const envelope = JSON.parse(options.body)
      return {
        status: 200,
        json: async () => ({ accepted: true, sessionId: envelope.sessionId, sequence: envelope.sequence, acceptedRoundKeys: envelope.roundKeys, source }),
      }
    },
  })

  assert.equal(await first.tick(), false)
  const checkpoint = JSON.parse(await readFile(queuePath, 'utf8'))
  assert.equal(checkpoint.entries[0].deliveryState, 'remote_ack_pending')
  assert.deepEqual(checkpoint.entries[0].remoteAckReceipt.acceptedRoundKeys, ['BAG01:100:4'])
  assert.equal(journal.cursor('BAG01')?.round ?? null, crashPhase === 'after_journal_ack' ? 4 : null)

  const second = createSnapshotPusher({
    targetUrl: 'https://render.example/api/cloud-ingest/snapshot', key: 'worker-key', queuePath,
    now: () => 20_000, isRoundDeliverable: () => true,
    getSnapshot: async () => { throw new Error('recovery_must_precede_source_read') },
    onAcknowledged: acknowledgeJournal,
    onRebindQueue: async () => { rebinds += 1; throw new Error('recovery_must_not_rebind') },
    fetchImpl: async () => { remotePushes += 1; throw new Error('recovery_must_not_repush') },
  })
  assert.equal(await second.tick(), true)
  assert.equal(journal.cursor('BAG01').round, 4)
  assert.equal(remotePushes, 1)
  assert.equal(rebinds, 0)
  assert.equal(second.snapshot().stateInvalid, false)
  await assert.rejects(readFile(queuePath, 'utf8'), { code: 'ENOENT' })
  const ackRecords = (await readFile(journalPath, 'utf8')).split(/\r?\n/).filter(Boolean)
    .map((line) => JSON.parse(line)).filter((record) => record.type === 'ack')
  assert.equal(ackRecords.length, 1)
}
