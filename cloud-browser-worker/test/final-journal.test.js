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

test('append-only shoe lifecycle restores active, retired, screen, and source chronology', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-final-shoe-lifecycle-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const journalPath = path.join(dir, 'finals.jsonl')
  const journal = await createFinalJournal({ journalPath, assertSource: () => true })
  const source999 = { mode: 'api', ownerId: 'api-primary', epoch: 4, fence: 'fence-4', sequence: 30 }
  const source1 = { ...source999, sequence: 31 }

  await journal.transitionShoeLifecycle({
    tableId: 'BAG09', activeShoe: 999, round: 70, origin: 'provider', source: source999,
  })
  await journal.transitionShoeLifecycle({
    tableId: 'BAG09', activeShoe: 1, round: 0, origin: 'provider', source: source1,
  })

  assert.deepEqual(journal.shoeLifecycle('BAG09'), {
    tableId: 'BAG09', activeShoe: 1, retiredShoes: [999],
    currentScreen: { shoe: 1, round: 0 }, origin: 'provider', source: source1,
  })
  const restored = await createFinalJournal({ journalPath, assertSource: () => true })
  assert.deepEqual(restored.shoeLifecycle('BAG09'), journal.shoeLifecycle('BAG09'))
  const records = (await readFile(journalPath, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(records.map((record) => record.type), ['shoe_lifecycle', 'shoe_lifecycle'])
})

test('one Final record atomically restores its accepted shoe lifecycle proof', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-final-atomic-lifecycle-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const journalPath = path.join(dir, 'finals.jsonl')
  const source = { mode: 'api', ownerId: 'api-primary', epoch: 4, fence: 'fence-4', sequence: 40 }
  const event = {
    ...finalEvent({ round: 1, sequence: 40 }), shoe: 92, source,
    shoeLifecycle: {
      tableId: 'BAG01', activeShoe: 92, retiredShoes: [],
      currentScreen: { shoe: 92, round: 1 }, origin: 'final', source,
    },
  }
  const journal = await createFinalJournal({ journalPath, assertSource: () => true })

  await journal.append(event)
  assert.deepEqual(journal.shoeLifecycle('BAG01'), event.shoeLifecycle)
  const restored = await createFinalJournal({ journalPath, assertSource: () => true })
  assert.deepEqual(restored.shoeLifecycle('BAG01'), event.shoeLifecycle)
  const records = (await readFile(journalPath, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(records.map((record) => record.type), ['final'])
})

test('cross-shoe Final lifecycle proof is rejected before append when provider transition is absent', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-final-cross-shoe-proof-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const journalPath = path.join(dir, 'finals.jsonl')
  const journal = await createFinalJournal({ journalPath, assertSource: () => true })
  const providerSource = { mode: 'api', ownerId: 'api-primary', epoch: 4, fence: 'fence-4', sequence: 40 }
  await journal.transitionShoeLifecycle({
    tableId: 'BAG01', activeShoe: 92, round: 70, origin: 'provider', source: providerSource,
  })
  const before = await readFile(journalPath, 'utf8')
  const finalSource = { ...providerSource, sequence: 41 }
  const event = {
    ...finalEvent({ round: 1, sequence: 41 }), shoe: 93, source: finalSource,
    shoeLifecycle: {
      tableId: 'BAG01', activeShoe: 93, retiredShoes: [92],
      currentScreen: { shoe: 93, round: 1 }, origin: 'final', source: finalSource,
    },
  }

  await assert.rejects(journal.append(event), /final_shoe_lifecycle_transition_without_provider/)
  assert.equal(await readFile(journalPath, 'utf8'), before, 'rejected Final must append no record')
  assert.equal(journal.pending().length, 0)
  assert.equal(journal.shoeLifecycle('BAG01').activeShoe, 92)
  const restored = await createFinalJournal({ journalPath, assertSource: () => true })
  assert.equal(restored.shoeLifecycle('BAG01').activeShoe, 92)
})

test('batch ACK validates every Final before one durable append and restores all acknowledgements', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-final-batch-ack-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const journalPath = path.join(dir, 'finals.jsonl')
  const journal = await createFinalJournal({ journalPath, assertSource: () => true })
  const appended = []
  for (const round of [1, 2, 3]) appended.push(await journal.append(finalEvent({ round, sequence: round })))

  await assert.rejects(journal.ackMany([
    { identity: appended[0].identity, hash: appended[0].hash },
    { identity: appended[1].identity, hash: 'wrong-hash' },
  ]), /final_ack_mismatch/)
  assert.equal(journal.pending().length, 3, 'validation failure must append no partial ACK')

  const result = await journal.ackMany(appended.map(({ identity, hash }) => ({ identity, hash })))
  assert.equal(result.acknowledged, 3)
  assert.equal(journal.pending().length, 0)
  const restored = await createFinalJournal({ journalPath, assertSource: () => true })
  assert.equal(restored.pending().length, 0)
  const records = (await readFile(journalPath, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(records.map((record) => record.type), ['final', 'final', 'final', 'ack', 'ack', 'ack'])
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
  const older = await journal.append({ ...finalEvent({ round: 70, sequence: 19 }), shoe: 91 })
  const newer = await journal.append({ ...finalEvent({ round: 1, sequence: 20 }), shoe: 92 })
  await journal.ack(newer.identity, newer.hash)
  await journal.ack(older.identity, older.hash)
  assert.deepEqual(journal.cursor('BAG01'), { shoe: 92, round: 1, identity: 'BAG01:92:1', hash: newer.hash })
})

test('late ACK with an incomparable prior owner cannot regress append chronology', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-final-owner-order-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const journal = await createFinalJournal({ journalPath: path.join(dir, 'finals.jsonl'), assertSource: () => true })
  const older = await journal.append({
    ...finalEvent({ round: 70, sequence: 19 }), shoe: 91,
    source: { mode: 'api', ownerId: 'old-owner', epoch: 1, fence: 'old-fence', sequence: 19 },
  })
  const newer = await journal.append({
    ...finalEvent({ round: 1, sequence: 1 }), shoe: 92,
    source: { mode: 'api', ownerId: 'new-owner', epoch: 2, fence: 'new-fence', sequence: 1 },
  })

  await journal.ack(newer.identity, newer.hash)
  await journal.ack(older.identity, older.hash)

  assert.deepEqual(journal.cursor('BAG01'), { shoe: 92, round: 1, identity: 'BAG01:92:1', hash: newer.hash })
})

test('a historical Final appended after a newer Final cannot regress the cursor', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-final-late-append-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const journal = await createFinalJournal({ journalPath: path.join(dir, 'finals.jsonl'), assertSource: () => true })
  const newer = await journal.append({ ...finalEvent({ round: 1, sequence: 20 }), shoe: 92 })
  await journal.ack(newer.identity, newer.hash)
  const historical = await journal.append({ ...finalEvent({ round: 70, sequence: 19 }), shoe: 91 })
  await journal.ack(historical.identity, historical.hash)
  assert.deepEqual(journal.cursor('BAG01'), { shoe: 92, round: 1, identity: 'BAG01:92:1', hash: newer.hash })
})

test('a retired shoe cannot return through a delayed higher-sequence Final', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-final-retired-shoe-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const journal = await createFinalJournal({ journalPath: path.join(dir, 'finals.jsonl'), assertSource: () => true })
  const older = await journal.append({ ...finalEvent({ round: 70, sequence: 19 }), shoe: 91 })
  await journal.ack(older.identity, older.hash)
  const newer = await journal.append({ ...finalEvent({ round: 1, sequence: 20 }), shoe: 92 })
  await journal.ack(newer.identity, newer.hash)
  const delayed = await journal.append({ ...finalEvent({ round: 71, sequence: 21 }), shoe: 91 })
  await journal.ack(delayed.identity, delayed.hash)
  assert.deepEqual(journal.cursor('BAG01'), { shoe: 92, round: 1, identity: 'BAG01:92:1', hash: newer.hash })
})

test('durable Final chronology advances cursor across numeric shoe wrap and survives restart', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-final-wrap-cursor-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const journalPath = path.join(dir, 'finals.jsonl')
  const journal = await createFinalJournal({ journalPath, assertSource: () => true })
  const beforeWrap = await journal.append({ ...finalEvent({ round: 70, sequence: 20 }), tableId: 'BAG09', shoe: 997 })
  const afterWrap = await journal.append({ ...finalEvent({ round: 1, sequence: 21 }), tableId: 'BAG09', shoe: 1 })
  await journal.ackMany([
    { identity: beforeWrap.identity, hash: beforeWrap.hash },
    { identity: afterWrap.identity, hash: afterWrap.hash },
  ])
  assert.deepEqual(journal.cursor('BAG09'), { shoe: 1, round: 1, identity: 'BAG09:1:1', hash: afterWrap.hash })

  const restored = await createFinalJournal({ journalPath, assertSource: () => true })
  assert.deepEqual(restored.cursor('BAG09'), journal.cursor('BAG09'))
})

test('pending rebind preserves Final chronology so a newer wrapped shoe advances the cursor', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-final-rebind-order-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const journal = await createFinalJournal({ journalPath: path.join(dir, 'finals.jsonl'), assertSource: () => true })
  const beforeWrap = await journal.append({ ...finalEvent({ round: 70, sequence: 20 }), tableId: 'BAG09', shoe: 997 })
  await journal.ack(beforeWrap.identity, beforeWrap.hash)
  const afterWrap = await journal.append({ ...finalEvent({ round: 1, sequence: 21 }), tableId: 'BAG09', shoe: 1 })
  const target = { mode: 'api', ownerId: 'api-primary', epoch: 3, fence: 'new-fence' }
  await journal.rebindPending(async () => ({ ...target, sequence: 1 }), target)

  await journal.ack(afterWrap.identity, afterWrap.hash)
  assert.deepEqual(journal.cursor('BAG09'), {
    shoe: 1, round: 1, identity: 'BAG09:1:1', hash: afterWrap.hash,
  })
})

test('snapshot ACK cursor bootstrap follows acknowledged chronology instead of numeric shoe max', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-bootstrap-wrap-cursor-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const journal = await createFinalJournal({ journalPath: path.join(dir, 'finals.jsonl'), assertSource: () => true })
  await journal.bootstrapFromSnapshotPusherCursor({
    version: 3, initialized: true, lastSequence: 22,
    observedRoundKeys: ['BAG09:997:70', 'BAG09:1:1'],
    acknowledgedRoundKeys: ['BAG09:997:70', 'BAG09:1:1'],
  })
  assert.deepEqual(journal.cursor('BAG09'), {
    shoe: 1, round: 1, identity: 'BAG09:1:1', origin: 'snapshot-pusher-exact-ack-cursor',
  })
})

test('snapshot ACK cursor bootstrap cannot be replaced by a delayed unknown-shoe acknowledgement', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-bootstrap-delayed-old-shoe-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const journal = await createFinalJournal({ journalPath: path.join(dir, 'finals.jsonl'), assertSource: () => true })
  await journal.bootstrapFromSnapshotPusherCursor({
    version: 3, initialized: true, lastSequence: 22,
    observedRoundKeys: ['BAG01:92:1'],
    acknowledgedRoundKeys: ['BAG01:92:1'],
  })
  const delayed = await journal.append({ ...finalEvent({ round: 70, sequence: 20 }), tableId: 'BAG01', shoe: 91 })

  await journal.ack(delayed.identity, delayed.hash)

  assert.deepEqual(journal.cursor('BAG01'), {
    shoe: 92, round: 1, identity: 'BAG01:92:1', origin: 'snapshot-pusher-exact-ack-cursor',
  })
})

test('snapshot ACK cursor bootstrap advances to a newly acknowledged round-one shoe', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-bootstrap-next-shoe-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const journal = await createFinalJournal({ journalPath: path.join(dir, 'finals.jsonl'), assertSource: () => true })
  await journal.bootstrapFromSnapshotPusherCursor({
    version: 3, initialized: true, lastSequence: 22,
    observedRoundKeys: ['BAG01:92:70'],
    acknowledgedRoundKeys: ['BAG01:92:70'],
  })
  const nextShoe = await journal.append({ ...finalEvent({ round: 1, sequence: 23 }), tableId: 'BAG01', shoe: 93 })

  await journal.ack(nextShoe.identity, nextShoe.hash)

  assert.deepEqual(journal.cursor('BAG01'), {
    shoe: 93, round: 1, identity: 'BAG01:93:1', hash: nextShoe.hash,
  })
})

test('append-only rebind survives restart without changing Final identity or payload hash', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-final-rebind-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const journalPath = path.join(dir, 'finals.jsonl')
  const journal = await createFinalJournal({ journalPath, assertSource: () => true })
  const event = finalEvent({ round: 9, sequence: 7, fence: 'old-fence' })
  event.shoeLifecycle = {
    tableId: event.tableId, activeShoe: event.shoe, retiredShoes: [],
    currentScreen: { shoe: event.shoe, round: event.round }, origin: 'final', source: event.source,
  }
  const original = await journal.append(event)
  const newSource = { mode: 'api', ownerId: 'api-primary', epoch: 3, fence: 'new-fence', sequence: 1 }

  const rebound = await journal.rebindPending(async () => newSource, { mode: 'api', ownerId: 'api-primary', epoch: 3, fence: 'new-fence' })
  assert.equal(rebound[0].identity, original.identity)
  assert.equal(rebound[0].hash, original.hash)
  assert.deepEqual(rebound[0].event.capturedSource, original.event.source)
  assert.deepEqual(rebound[0].event.source, newSource)
  assert.deepEqual(rebound[0].event.shoeLifecycle.source, original.event.source)

  const restored = await createFinalJournal({ journalPath, assertSource: () => true })
  assert.equal(restored.pending()[0].identity, original.identity)
  assert.equal(restored.pending()[0].hash, original.hash)
  assert.deepEqual(restored.pending()[0].event.source, newSource)
  assert.deepEqual(restored.shoeLifecycle('BAG01'), original.event.shoeLifecycle)
  assert.deepEqual((await readFile(journalPath, 'utf8')).trim().split('\n').map(JSON.parse).map((record) => record.type), ['final', 'rebind'])
})

function finalEvent({ round = 7, sequence = 11, fence = 'current-fence' } = {}) {
  return {
    tableId: 'BAG01', shoe: 91, round, winner: 'banker', sourceAction: 'summary', final: true,
    rawResult: [1, 2, 3, 4, 0, 0, 0, 0, 4, 6], playerPoint: 4, bankerPoint: 6,
    source: { mode: 'api', ownerId: 'api-primary', epoch: 2, fence, sequence },
  }
}
