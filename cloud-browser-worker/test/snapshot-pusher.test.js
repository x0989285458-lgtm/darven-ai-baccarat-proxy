import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createSnapshotPusher } from '../src/snapshot-pusher.js'

test('pusher retries with exponential backoff and preserves latest snapshot on disk', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-push-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const queuePath = path.join(dir, 'latest.json')
  let clock = 1000
  let round = 1
  const sent = []
  let attempts = 0
  const pusher = createSnapshotPusher({
    targetUrl: 'https://example.invalid/api/cloud-ingest/snapshot',
    key: 'test-key', queuePath, now: () => clock,
    getSnapshot: async () => ({ sessionId: 'vm', tables: [{ tableId: 'BAG01', round }], rounds: [] }),
    fetchImpl: async (_url, options) => {
      attempts += 1
      sent.push(JSON.parse(options.body))
      if (attempts === 1) throw new Error('network failed')
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    },
    baseBackoffMs: 1000,
  })

  assert.equal(await pusher.tick(), false)
  assert.equal(attempts, 1)
  round = 2
  clock = 1500
  assert.equal(await pusher.tick(), false)
  assert.equal(attempts, 1, 'backoff suppresses an early retry')
  assert.equal(JSON.parse(await readFile(queuePath, 'utf8')).snapshot.tables[0].round, 2, 'disk queue coalesces to latest')

  clock = 2000
  assert.equal(await pusher.tick(), true)
  assert.equal(attempts, 2)
  assert.equal(sent[1].snapshot.tables[0].round, 2)
  await assert.rejects(readFile(queuePath, 'utf8'), { code: 'ENOENT' })
})

test('pusher sends required headers and monotonically increasing sequence', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-push-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const requests = []
  let clock = 5000
  const pusher = createSnapshotPusher({
    targetUrl: 'https://render.example/api/cloud-ingest/snapshot', key: 'worker-key',
    queuePath: path.join(dir, 'latest.json'), now: () => clock,
    getSnapshot: async () => ({ sessionId: 'vm', tables: [], rounds: [] }),
    fetchImpl: async (url, options) => { requests.push({ url, options }); return { ok: true, status: 200 } },
  })
  assert.equal(await pusher.tick(), true)
  clock += 5000
  assert.equal(await pusher.tick(), true)
  assert.equal(requests[0].options.headers['x-worker-key'], 'worker-key')
  assert.equal(JSON.parse(requests[0].options.body).timestamp, 5000)
  assert.ok(JSON.parse(requests[1].options.body).sequence > JSON.parse(requests[0].options.body).sequence)
})
