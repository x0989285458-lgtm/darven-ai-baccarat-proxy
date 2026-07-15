import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createSnapshotPusher } from '../src/snapshot-pusher.js'
import { hasRealCardCodes, isRoundPayload } from '../src/snapshot.js'

test('v098 durable FIFO retains a failed head while collecting the next round', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'v098-fifo-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const queuePath = path.join(dir, 'queue.json')
  const snapshots = [snapshot([1]), snapshot([1, 2]), snapshot([1, 2, 3])]
  let attempt = 0
  const pusher = createSnapshotPusher({ targetUrl: 'https://proxy.example/ingest', key: 'worker-key', queuePath, baseBackoffMs: 0,
    getSnapshot: async () => snapshots.shift(),
    fetchImpl: async (_url, options) => { attempt += 1; if (attempt === 2) throw new Error('offline'); const body = JSON.parse(options.body); return { ok: true, status: 200, json: async () => ({ accepted: true, sessionId: body.sessionId, sequence: body.sequence, acceptedRoundKeys: body.roundKeys }) } },
  })
  assert.equal(await pusher.tick(), true)
  assert.equal(await pusher.tick(), false)
  assert.equal(await pusher.tick(), true)
  const queue = JSON.parse(await readFile(queuePath, 'utf8'))
  assert.deepEqual(queue.entries.flatMap((entry) => entry.roundKeys), ['BAG01:8:3'])
  function snapshot(rounds) { return { sessionId: 'vm', tables: [], rounds: rounds.map((round) => ({ tableId: 'BAG01', shoe: 8, round, winner: 'banker' })) } }
})

test('v098.8 waits for real summary cards before observing queueing or ACKing a round identity', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'v098-real-cards-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const queuePath = path.join(dir, 'queue.json')
  const placeholder = [0, 0, 0, 0, 0, 0, -1, -1, 0, 0]
  const real = [11, 25, 7, 19, -1, -1, -1, -1, 4, 6]
  const snapshots = [snapshot(placeholder, 'show_poker'), snapshot(real, 'summary')]
  const sent = []
  const pusher = createSnapshotPusher({
    targetUrl: 'https://proxy.example/ingest', key: 'worker-key', queuePath,
    isRoundDeliverable: hasRealCardCodes,
    getSnapshot: async () => snapshots.shift(),
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body)
      sent.push(body)
      return { ok: true, status: 200, json: async () => ({ accepted: true, sessionId: body.sessionId, sequence: body.sequence, acceptedRoundKeys: body.roundKeys }) }
    },
  })

  assert.equal(await pusher.tick(), true)
  assert.equal(await pusher.tick(), true)
  assert.deepEqual(sent[0].roundKeys, [])
  assert.deepEqual(sent[1].roundKeys, ['BAG01:8:1'])
  assert.deepEqual(sent[1].snapshot.rounds[0].rawResult, real)

  function snapshot(rawResult, sourceAction) {
    return { sessionId: 'vm', tables: [{ tableId: 'BAG01', shoe: 8, round: 1 }], rounds: [{ tableId: 'BAG01', shoe: 8, round: 1, winner: 'banker', rawResult, sourceAction }] }
  }
})

test('v098.14 retains every recognized MT card-result action in the durable round buffer', () => {
  for (const actionName of ['show_poker', 'summary', 'show_win', 'roundResult', 'round_result']) {
    const payload = JSON.stringify({
      action: { name: `/api/v1/gametype/*/game/*/room/*/table/*/${actionName}` },
      body: { table_id: 'BAG07', shoe: 18707, round: 53, result: [11, 25, 7, 19, -1, -1, -1, -1, 4, 6] },
    })
    assert.equal(isRoundPayload(payload), true, actionName)
  }
})

test('v098.14 excludes card-shaped payloads without a recognized MT round action', () => {
  const payload = JSON.stringify({
    action: { name: '/api/v1/gametype/*/game/*/room/*/table/*/road_update' },
    body: { table_id: 'BAG07', shoe: 18707, round: 53, result: [11, 25, 7, 19, -1, -1, -1, -1, 4, 6] },
  })

  assert.equal(isRoundPayload(payload), false)
})

test('v098 coalesces unsent backlog into the tail while preserving the failed FIFO head', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'v098-coalesce-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const queuePath = path.join(dir, 'queue.json')
  const snapshot = (rounds) => ({
    sessionId: 'vm',
    tables: [{ tableId: 'BAG01', round: rounds.at(-1) }],
    rounds: rounds.map((round) => ({ tableId: 'BAG01', shoe: 8, round, winner: 'banker' })),
  })
  const snapshots = [snapshot([1]), snapshot([1, 2]), snapshot([1, 2, 3])]
  let clock = 1000
  const pusher = createSnapshotPusher({
    targetUrl: 'https://proxy.example/ingest', key: 'worker-key', queuePath,
    baseBackoffMs: 0, now: () => clock++,
    getSnapshot: async () => snapshots.shift(),
    fetchImpl: async () => { throw new Error('offline') },
  })

  assert.equal(await pusher.tick(), false)
  assert.equal(await pusher.tick(), false)
  assert.equal(await pusher.tick(), false)

  const queue = JSON.parse(await readFile(queuePath, 'utf8')).entries
  assert.equal(queue.length, 2)
  assert.deepEqual(queue[0].roundKeys, ['BAG01:8:1'])
  assert.deepEqual(queue[1].roundKeys, ['BAG01:8:2', 'BAG01:8:3'])
  assert.equal(queue[1].snapshot.tables[0].round, 3)
})
