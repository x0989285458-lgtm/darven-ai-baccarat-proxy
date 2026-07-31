import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import path from 'node:path'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createFinalJournal } from '../src/final-journal.js'
import { createBackupJournalRuntime } from '../src/backup-journal-runtime.js'

test('backup-journal role fails closed before opening sockets when the second token file is absent', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-backup-runtime-missing-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  let clientCreations = 0
  const journal = await createFinalJournal({ journalPath: path.join(dir, 'backup.jsonl') })
  const runtime = createBackupJournalRuntime({
    tokenFile: path.join(dir, 'missing-token'), journal, ownerId: 'backup-owner',
    createApiClient: () => { clientCreations += 1; return { start: async () => {} } },
  })
  await assert.rejects(runtime.start(), /second_independent_session_token_required/)
  assert.equal(clientCreations, 0)
  assert.deepEqual(runtime.snapshot(), {
    role: 'backup-journal', started: false, connected: false, authenticated: false, joined: false,
    tableCount: 0, lastMessageAt: null, lastFinalAt: null, lastError: 'second_independent_session_token_required',
  })
})

test('backup-journal role fingerprints the real token, writes header/finals, and closes only a continuous observed shoe', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-backup-runtime-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const token = 'test-token-a'
  const tokenFile = path.join(dir, 'backup.token')
  const journalPath = path.join(dir, 'backup.jsonl')
  await writeFile(tokenFile, token, { mode: 0o600 })
  const journal = await createFinalJournal({ journalPath })
  let handlers
  let apiState = { connected: true, authenticated: true, joined: true, lastMessageAt: '2026-07-31T02:00:00.000Z' }
  const runtime = createBackupJournalRuntime({
    tokenFile, journal, ownerId: 'backup-owner', now: () => '2026-07-31T02:00:00.000Z',
    createApiClient: (options) => {
      handlers = options
      return { start: async () => {}, stop: () => {}, snapshot: () => structuredClone(apiState) }
    },
  })
  await runtime.start()
  const expectedFingerprint = crypto.createHash('sha256').update(token).digest('hex')
  assert.deepEqual(journal.header(), { sessionFingerprint: expectedFingerprint, ownerId: 'backup-owner' })

  await handlers.onTables([{ table_id: 'BAG01', shoe: 10, round: 1 }])
  await handlers.onFinal(finalEvent(1))
  await handlers.onFinal(finalEvent(3))
  await handlers.onTables([{ table_id: 'BAG01', shoe: 10, round: 3 }])
  await handlers.onTables([{ table_id: 'BAG01', shoe: 11, round: 1 }])
  let records = (await readFile(journalPath, 'utf8')).trim().split(/\r?\n/).map(JSON.parse)
  assert.equal(records.some((record) => record.type === 'shoe_closed'), false, 'round 2 gap forbids a shoe marker')

  await handlers.onFinal(finalEvent(2))
  await handlers.onTables([{ table_id: 'BAG01', shoe: 11, round: 1 }])
  records = (await readFile(journalPath, 'utf8')).trim().split(/\r?\n/).map(JSON.parse)
  const markers = records.filter((record) => record.type === 'shoe_closed')
  assert.equal(markers.length, 1)
  assert.deepEqual({ tableId: markers[0].tableId, shoe: markers[0].shoe, finalRound: markers[0].finalRound }, { tableId: 'BAG01', shoe: 10, finalRound: 3 })
  assert.equal(runtime.snapshot().tableCount, 1)
  assert.equal(runtime.snapshot().lastFinalAt, '2026-07-31T02:00:00.000Z')
  await runtime.stop()
})

function finalEvent(round) {
  return {
    tableId: 'BAG01', shoe: 10, round, winner: 'banker', sourceAction: 'summary', final: true,
    rawResult: [1, 2, 3, 4, 0, 0, 0, 0, 4, 6], playerPoint: 4, bankerPoint: 6,
  }
}
