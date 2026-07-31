import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createFinalJournal } from '../src/final-journal.js'

test('append-only journal recovers Final, durable ACK, and per-table cursor across restart', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-final-journal-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const journalPath = path.join(dir, 'finals.jsonl')
  const event = finalEvent({ round: 7, sequence: 11 })
  const journal = await createFinalJournal({ journalPath, assertSource: () => true })

  const appended = await journal.append(event)
  assert.equal(appended.status, 'appended')
  assert.equal((await journal.append(structuredClone(event))).status, 'duplicate')
  assert.equal(journal.pending().length, 1)
  await journal.ack(appended.identity, appended.hash)
  assert.deepEqual(journal.cursor('BAG01'), { shoe: 91, round: 7, identity: 'BAG01:91:7', hash: appended.hash })
  assert.equal(journal.pending().length, 0)

  const restored = await createFinalJournal({ journalPath, assertSource: () => true })
  assert.deepEqual(restored.cursor('BAG01'), journal.cursor('BAG01'))
  assert.equal(restored.pending().length, 0)
  const records = (await readFile(journalPath, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(records.map((record) => record.type), ['final', 'ack'])
})

test('same identity with a different payload or hash fails closed', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-final-conflict-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const journal = await createFinalJournal({ journalPath: path.join(dir, 'finals.jsonl'), assertSource: () => true })
  await journal.append(finalEvent({ round: 8, sequence: 12 }))
  const conflict = finalEvent({ round: 8, sequence: 13 })
  conflict.rawResult = [5, 2, 3, 4, 0, 0, 0, 0, 8, 6]
  conflict.winner = 'player'
  await assert.rejects(journal.append(conflict), /final_identity_payload_conflict/)
})

test('journal rejects an event after its source fence is stale', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-final-fence-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const journal = await createFinalJournal({
    journalPath: path.join(dir, 'finals.jsonl'),
    assertSource: (source) => { if (source.fence !== 'current-fence') throw new Error('stale_source_fence') },
  })
  await assert.rejects(journal.append(finalEvent({ fence: 'old-fence' })), /stale_source_fence/)
})

test('late ACK from an older shoe never regresses the last durable cursor', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-final-cursor-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const journal = await createFinalJournal({ journalPath: path.join(dir, 'finals.jsonl'), assertSource: () => true })
  const newer = await journal.append({ ...finalEvent({ round: 1, sequence: 20 }), shoe: 92 })
  await journal.ack(newer.identity, newer.hash)
  const older = await journal.append({ ...finalEvent({ round: 70, sequence: 21 }), shoe: 91 })
  await journal.ack(older.identity, older.hash)
  assert.deepEqual(journal.cursor('BAG01'), { shoe: 92, round: 1, identity: 'BAG01:92:1', hash: newer.hash })
})

test('append-only rebind survives restart without changing Final identity or payload hash', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-final-rebind-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const journalPath = path.join(dir, 'finals.jsonl')
  const journal = await createFinalJournal({ journalPath, assertSource: () => true })
  const original = await journal.append(finalEvent({ round: 9, sequence: 7, fence: 'old-fence' }))
  const newSource = { mode: 'api', ownerId: 'api-primary', epoch: 3, fence: 'new-fence', sequence: 1 }

  const rebound = await journal.rebindPending(async () => newSource, { mode: 'api', ownerId: 'api-primary', epoch: 3, fence: 'new-fence' })
  assert.equal(rebound[0].identity, original.identity)
  assert.equal(rebound[0].hash, original.hash)
  assert.deepEqual(rebound[0].event.capturedSource, original.event.source)
  assert.deepEqual(rebound[0].event.source, newSource)

  const restored = await createFinalJournal({ journalPath, assertSource: () => true })
  assert.equal(restored.pending()[0].identity, original.identity)
  assert.equal(restored.pending()[0].hash, original.hash)
  assert.deepEqual(restored.pending()[0].event.source, newSource)
  assert.deepEqual((await readFile(journalPath, 'utf8')).trim().split('\n').map(JSON.parse).map((record) => record.type), ['final', 'rebind'])
})

function finalEvent({ round = 7, sequence = 11, fence = 'current-fence' } = {}) {
  return {
    tableId: 'BAG01', shoe: 91, round, winner: 'banker', sourceAction: 'summary', final: true,
    rawResult: [1, 2, 3, 4, 0, 0, 0, 0, 4, 6], playerPoint: 4, bankerPoint: 6,
    source: { mode: 'api', ownerId: 'api-primary', epoch: 2, fence, sequence },
  }
}
