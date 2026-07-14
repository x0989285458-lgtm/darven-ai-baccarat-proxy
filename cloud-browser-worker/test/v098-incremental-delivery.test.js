import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createSnapshotPusher } from '../src/snapshot-pusher.js'

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
