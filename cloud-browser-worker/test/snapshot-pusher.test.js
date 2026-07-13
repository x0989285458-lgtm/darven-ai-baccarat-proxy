import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createSnapshotPusher } from '../src/snapshot-pusher.js'

test('pusher preserves and retries the exact unacknowledged envelope', async (t) => {
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
  assert.equal(JSON.parse(await readFile(queuePath, 'utf8')).snapshot.tables[0].round, 1, 'pending envelope is not replaced before ack')

  clock = 2000
  assert.equal(await pusher.tick(), true)
  assert.equal(attempts, 2)
  assert.deepEqual(sent[1], sent[0], 'retry sends the complete original envelope unchanged')
  await assert.rejects(readFile(queuePath, 'utf8'), { code: 'ENOENT' })
})

test('pusher restores the queued envelope before collecting a new snapshot and only 2xx acknowledges it', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-push-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const queuePath = path.join(dir, 'latest.json')
  let snapshotCalls = 0
  const original = {
    timestamp: 1000,
    sequence: 1000,
    snapshot: { sessionId: 'vm', tables: [], rounds: [{ tableId: 'BAG01', shoe: 8, round: 9, winner: 'banker' }] },
  }
  await import('node:fs/promises').then(({ writeFile }) => writeFile(queuePath, JSON.stringify(original)))
  const statuses = [302, 204]
  const sent = []
  const pusher = createSnapshotPusher({
    targetUrl: 'https://render.example/api/cloud-ingest/snapshot', key: 'worker-key', queuePath,
    getSnapshot: async () => { snapshotCalls += 1; return { sessionId: 'vm', tables: [], rounds: [] } },
    fetchImpl: async (_url, options) => {
      assert.equal(options.redirect, 'error', 'authenticated push must not follow redirects')
      sent.push(JSON.parse(options.body))
      const status = statuses.shift()
      return { ok: status < 400, status }
    },
    baseBackoffMs: 0,
  })

  assert.equal(await pusher.tick(), false, 'redirect is not an acknowledgement')
  assert.equal(snapshotCalls, 0)
  assert.deepEqual(sent[0], original)
  assert.deepEqual(JSON.parse(await readFile(queuePath, 'utf8')), original)
  assert.equal(await pusher.tick(), true)
  assert.equal(snapshotCalls, 0)
  assert.deepEqual(sent[1], original)
  await assert.rejects(readFile(queuePath, 'utf8'), { code: 'ENOENT' })
})

test('pusher does not forward the worker key to an HTTP redirect target', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-push-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  let redirectTargetRequests = 0
  let forwardedWorkerKey = null
  const redirectTarget = createServer((request, response) => {
    redirectTargetRequests += 1
    forwardedWorkerKey = request.headers['x-worker-key'] ?? null
    response.writeHead(204).end()
  })
  await listen(redirectTarget)
  t.after(() => redirectTarget.close())

  const redirector = createServer((_request, response) => {
    response.writeHead(307, { location: serverUrl(redirectTarget) }).end()
  })
  await listen(redirector)
  t.after(() => redirector.close())

  const queuePath = path.join(dir, 'latest.json')
  const pusher = createSnapshotPusher({
    targetUrl: serverUrl(redirector), key: 'worker-key', queuePath,
    getSnapshot: async () => ({ sessionId: 'vm', tables: [], rounds: [] }),
    baseBackoffMs: 0,
  })

  assert.equal(await pusher.tick(), false, 'redirect is not an acknowledgement')
  assert.equal(redirectTargetRequests, 0)
  assert.equal(forwardedWorkerKey, null)
  assert.ok(JSON.parse(await readFile(queuePath, 'utf8')).snapshot)
})

test('pusher baselines retained rounds then sends only newly completed rounds across restarts', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-push-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const queuePath = path.join(dir, 'latest.json')
  const snapshots = [
    { sessionId: 'vm', tables: [], rounds: [round(1), round(2)] },
    { sessionId: 'vm', tables: [], rounds: [round(1), round(2), round(3)] },
  ]
  const sent = []
  const create = (getSnapshot) => createSnapshotPusher({
    targetUrl: 'https://render.example/api/cloud-ingest/snapshot', key: 'worker-key', queuePath,
    getSnapshot,
    fetchImpl: async (_url, options) => { sent.push(JSON.parse(options.body)); return { status: 200 } },
  })

  const first = create(async () => snapshots.shift())
  assert.equal(await first.tick(), true)
  assert.deepEqual(sent[0].snapshot.rounds, [], 'retained history is a baseline, not a new completion')
  assert.equal(await first.tick(), true)
  assert.deepEqual(sent[1].snapshot.rounds.map((item) => item.round), [3])

  const restarted = create(async () => ({ sessionId: 'vm', tables: [], rounds: [round(1), round(2), round(3), round(4)] }))
  assert.equal(await restarted.tick(), true)
  assert.deepEqual(sent[2].snapshot.rounds.map((item) => item.round), [4], 'ack cursor survives restart')

  function round(number) {
    return { tableId: 'BAG01', shoe: 8, round: number, winner: 'banker' }
  }
})

test('pusher uses the table shoe cursor when completed rounds omit shoe', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-push-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const sent = []
  const snapshots = [snapshot(8), snapshot(9)]
  const pusher = createSnapshotPusher({
    targetUrl: 'https://render.example/api/cloud-ingest/snapshot', key: 'worker-key',
    queuePath: path.join(dir, 'latest.json'),
    getSnapshot: async () => snapshots.shift(),
    fetchImpl: async (_url, options) => { sent.push(JSON.parse(options.body)); return { status: 200 } },
  })

  assert.equal(await pusher.tick(), true)
  assert.deepEqual(sent[0].snapshot.rounds, [])
  assert.equal(await pusher.tick(), true)
  assert.deepEqual(sent[1].snapshot.rounds.map((item) => item.round), [1], 'same round number in a new shoe is new')

  function snapshot(shoe) {
    return {
      sessionId: 'vm',
      tables: [{ tableId: 'BAG01', shoe, round: 1 }],
      rounds: [{ tableId: 'BAG01', shoe: null, round: 1, winner: 'banker' }],
    }
  }
})

test('pusher matches BAG1 rounds to the canonical BAG01 table shoe across rollover', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-push-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const sent = []
  const snapshots = [snapshot(8), snapshot(9)]
  const pusher = createSnapshotPusher({
    targetUrl: 'https://render.example/api/cloud-ingest/snapshot', key: 'worker-key',
    queuePath: path.join(dir, 'latest.json'),
    getSnapshot: async () => snapshots.shift(),
    fetchImpl: async (_url, options) => { sent.push(JSON.parse(options.body)); return { status: 200 } },
  })

  assert.equal(await pusher.tick(), true)
  assert.deepEqual(sent[0].snapshot.rounds, [])
  assert.equal(await pusher.tick(), true)
  assert.deepEqual(sent[1].snapshot.rounds.map((item) => item.round), [1])

  function snapshot(shoe) {
    return {
      sessionId: 'vm',
      tables: [{ tableId: 'BAG01', shoe, round: 1 }],
      rounds: [{ tableId: 'BAG1', shoe: null, round: 1, winner: 'banker' }],
    }
  }
})

test('pusher matches BAG1A rounds to the canonical BAG01A table shoe', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-push-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const sent = []
  const snapshots = [snapshot(8), snapshot(9)]
  const pusher = createSnapshotPusher({
    targetUrl: 'https://render.example/api/cloud-ingest/snapshot', key: 'worker-key',
    queuePath: path.join(dir, 'latest.json'),
    getSnapshot: async () => snapshots.shift(),
    fetchImpl: async (_url, options) => { sent.push(JSON.parse(options.body)); return { status: 200 } },
  })

  assert.equal(await pusher.tick(), true)
  assert.equal(await pusher.tick(), true)
  assert.deepEqual(sent[1].snapshot.rounds.map((item) => item.round), [1])

  function snapshot(shoe) {
    return {
      sessionId: 'vm',
      tables: [{ tableId: 'BAG01A', shoe, round: 1 }],
      rounds: [{ tableId: 'BAG1A', shoe: null, round: 1, winner: 'banker' }],
    }
  }
})

test('pusher does not replay a retained missing-shoe event after rollover but sends the new event', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-push-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const queuePath = path.join(dir, 'latest.json')
  const oldRound = { tableId: 'BAG01', shoe: null, round: 1, winner: 'banker', rawResult: [1, 2, 3] }
  const newRound = { tableId: 'BAG01', shoe: null, round: 1, winner: 'player', rawResult: [4, 5, 6] }
  const snapshots = [
    { sessionId: 'vm', tables: [{ tableId: 'BAG01', shoe: 8, round: 1 }], rounds: [oldRound] },
    { sessionId: 'vm', tables: [{ tableId: 'BAG01', shoe: 9, round: 1 }], rounds: [oldRound, newRound] },
  ]
  const sent = []
  const create = () => createSnapshotPusher({
    targetUrl: 'https://render.example/api/cloud-ingest/snapshot', key: 'worker-key', queuePath,
    getSnapshot: async () => snapshots.shift(),
    fetchImpl: async (_url, options) => { sent.push(JSON.parse(options.body)); return { status: 200 } },
  })

  assert.equal(await create().tick(), true)
  assert.deepEqual(sent[0].snapshot.rounds, [])
  assert.equal(await create().tick(), true, 'first-seen shoe identity survives a restart')
  assert.deepEqual(sent[1].snapshot.rounds, [newRound])
})

test('pusher treats the same missing-shoe round number in a new capture session as new', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-push-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const sent = []
  const snapshots = [snapshot('capture-1'), snapshot('capture-2')]
  const pusher = createSnapshotPusher({
    targetUrl: 'https://render.example/api/cloud-ingest/snapshot', key: 'worker-key',
    queuePath: path.join(dir, 'latest.json'),
    getSnapshot: async () => snapshots.shift(),
    fetchImpl: async (_url, options) => { sent.push(JSON.parse(options.body)); return { status: 200 } },
  })

  assert.equal(await pusher.tick(), true)
  assert.deepEqual(sent[0].snapshot.rounds, [])
  assert.equal(await pusher.tick(), true)
  assert.deepEqual(sent[1].snapshot.rounds.map((item) => item.round), [1])

  function snapshot(sessionId) {
    return {
      sessionId,
      tables: [{ tableId: 'BAG01', shoe: null, round: 1 }],
      rounds: [{ tableId: 'BAG01', shoe: null, round: 1, winner: 'banker', rawResult: [1, 2, 3] }],
    }
  }
})

test('pusher sends an identical missing-shoe event after both capture session and shoe roll over', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-push-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const sent = []
  const result = { tableId: 'BAG01', shoe: null, round: 1, winner: 'banker', rawResult: [1, 2, 3] }
  const oldEvent = { ...result, sourceEventId: 'capture-1:1' }
  const newEvent = { ...result, sourceEventId: 'capture-2:2' }
  const snapshots = [
    { sessionId: 'capture-1', tables: [{ tableId: 'BAG01', shoe: 8, round: 1 }], rounds: [oldEvent] },
    { sessionId: 'capture-2', tables: [{ tableId: 'BAG01', shoe: 9, round: 1 }], rounds: [oldEvent, newEvent] },
  ]
  const queuePath = path.join(dir, 'latest.json')
  const create = () => createSnapshotPusher({
    targetUrl: 'https://render.example/api/cloud-ingest/snapshot', key: 'worker-key',
    queuePath,
    getSnapshot: async () => snapshots.shift(),
    fetchImpl: async (_url, options) => { sent.push(JSON.parse(options.body)); return { status: 200 } },
  })

  assert.equal(await create().tick(), true)
  assert.deepEqual(sent[0].snapshot.rounds, [])
  assert.equal(await create().tick(), true)
  assert.deepEqual(sent[1].snapshot.rounds, [newEvent])
})

test('pusher canonicalizes A-suffix table ids and never replays the retained old event after rollover', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-push-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const sent = []
  const oldEvent = { tableId: 'BAG1A', shoe: null, round: 1, winner: 'banker', rawResult: [1, 2, 3], sourceEventId: 'capture-1:1' }
  const newEvent = { tableId: 'BAG1A', shoe: null, round: 1, winner: 'player', rawResult: [4, 5, 6], sourceEventId: 'capture-2:2' }
  const snapshots = [
    { sessionId: 'capture-1', tables: [{ tableId: 'BAG01A', shoe: 8, round: 1 }], rounds: [oldEvent] },
    { sessionId: 'capture-2', tables: [{ tableId: 'BAG01A', shoe: 9, round: 1 }], rounds: [oldEvent, newEvent] },
  ]
  const queuePath = path.join(dir, 'latest.json')
  const create = () => createSnapshotPusher({
    targetUrl: 'https://render.example/api/cloud-ingest/snapshot', key: 'worker-key', queuePath,
    getSnapshot: async () => snapshots.shift(),
    fetchImpl: async (_url, options) => { sent.push(JSON.parse(options.body)); return { status: 200 } },
  })

  assert.equal(await create().tick(), true)
  assert.deepEqual(sent[0].snapshot.rounds, [])
  assert.equal(await create().tick(), true)
  assert.deepEqual(sent[1].snapshot.rounds, [newEvent])
})

test('pusher uses an event fingerprint to preserve distinct missing-shoe rounds in one session', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-push-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const sent = []
  const snapshots = [snapshot([1, 2, 3]), snapshot([4, 5, 6]), snapshot([4, 5, 6])]
  const pusher = createSnapshotPusher({
    targetUrl: 'https://render.example/api/cloud-ingest/snapshot', key: 'worker-key',
    queuePath: path.join(dir, 'latest.json'),
    getSnapshot: async () => snapshots.shift(),
    fetchImpl: async (_url, options) => { sent.push(JSON.parse(options.body)); return { status: 200 } },
  })

  assert.equal(await pusher.tick(), true)
  assert.deepEqual(sent[0].snapshot.rounds, [])
  assert.equal(await pusher.tick(), true)
  assert.deepEqual(sent[1].snapshot.rounds.map((item) => item.rawResult), [[4, 5, 6]])
  assert.equal(await pusher.tick(), true)
  assert.deepEqual(sent[2].snapshot.rounds, [], 'the same retained event remains acknowledged')

  function snapshot(rawResult) {
    return {
      sessionId: 'capture-1',
      tables: [{ tableId: 'BAG01', shoe: null, round: 1 }],
      rounds: [{ tableId: 'BAG01', shoe: null, round: 1, winner: 'banker', rawResult }],
    }
  }
})

test('pusher preserves an identical missing-shoe result when its capture event id is new', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-push-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const sent = []
  const snapshots = [snapshot('capture-1:1'), snapshot('capture-1:2')]
  const pusher = createSnapshotPusher({
    targetUrl: 'https://render.example/api/cloud-ingest/snapshot', key: 'worker-key',
    queuePath: path.join(dir, 'latest.json'),
    getSnapshot: async () => snapshots.shift(),
    fetchImpl: async (_url, options) => { sent.push(JSON.parse(options.body)); return { status: 200 } },
  })

  assert.equal(await pusher.tick(), true)
  assert.deepEqual(sent[0].snapshot.rounds, [])
  assert.equal(await pusher.tick(), true)
  assert.deepEqual(sent[1].snapshot.rounds.map((item) => item.sourceEventId), ['capture-1:2'])

  function snapshot(sourceEventId) {
    return {
      sessionId: 'capture-1',
      tables: [],
      rounds: [{ tableId: 'BAG01', shoe: null, round: 1, winner: 'banker', rawResult: [1, 2, 3], sourceEventId }],
    }
  }
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

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
}

function serverUrl(server) {
  const address = server.address()
  return `http://127.0.0.1:${address.port}/snapshot`
}
