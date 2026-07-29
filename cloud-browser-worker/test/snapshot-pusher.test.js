import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createSnapshotPusher } from '../src/snapshot-pusher.js'

test('formal backlog delivery preserves the stable five-second cadence with bounded payload and request limits', async () => {
  const server = await readFile(new URL('../src/server.js', import.meta.url), 'utf8')
  assert.match(server, /PUSH_INTERVAL_MS\s*\?\?\s*5000/)
  assert.match(server, /PUSH_REQUEST_TIMEOUT_MS\s*\?\?\s*120000/)
  assert.match(server, /PUSH_MAX_ROUNDS_PER_DELIVERY\s*\?\?\s*5/)
  assert.match(server, /PUSH_MAX_DRAIN_PER_TICK\s*\?\?\s*5/)
})

test('one tick re-collects after a slow ACK before continuing the bounded FIFO drain', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-bounded-drain-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const queuePath = path.join(dir, 'latest.json')
  const entries = [1000, 1001, 1002].map((sequence) => ({
    protocolVersion: 'v101', sessionId: 'vm', timestamp: sequence, captureTimestamp: sequence,
    sequence, roundKeys: [], snapshot: { sessionId: 'vm', buildVersion: '101', tables: [], rounds: [] },
  }))
  await writeFile(queuePath, JSON.stringify({ version: 3, entries }))
  await writeFile(`${queuePath}.cursor.json`, JSON.stringify({
    version: 3, initialized: true, lastSequence: 1002,
    observedRoundKeys: [], acknowledgedRoundKeys: [],
  }))
  const sent = []
  let captureCalls = 0
  let clock = 2000
  const pusher = createSnapshotPusher({
    targetUrl: 'https://render.example/api/cloud-ingest/snapshot', key: 'worker-key', queuePath,
    maxDrainPerTick: 3,
    now: () => clock,
    getSnapshot: async () => {
      captureCalls += 1
      return { sessionId: 'vm', buildVersion: '101', tables: [], rounds: [] }
    },
    fetchImpl: async (_url, options) => {
      sent.push(JSON.parse(options.body))
      clock += 6 * 60 * 1000
      return acceptedResponse(options)
    },
  })

  assert.equal(await pusher.tick(), true)
  assert.deepEqual(sent.map((entry) => entry.sequence), [1000, 1001, 1002])
  assert.deepEqual(sent.map((entry) => entry.timestamp), [2000, 362000, 722000])
  assert.equal(captureCalls, 3)
  await assert.rejects(readFile(queuePath, 'utf8'), { code: 'ENOENT' })
})

test('a later drain failure preserves its FIFO head and backs off from failure time', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-drain-backoff-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const queuePath = path.join(dir, 'latest.json')
  const entries = [1000, 1001, 1002].map((sequence) => ({
    protocolVersion: 'v101', sessionId: 'vm', timestamp: sequence, captureTimestamp: sequence,
    sequence, roundKeys: [], snapshot: { sessionId: 'vm', buildVersion: '101', tables: [], rounds: [] },
  }))
  await writeFile(queuePath, JSON.stringify({ version: 3, entries }))
  await writeFile(`${queuePath}.cursor.json`, JSON.stringify({
    version: 3, initialized: true, lastSequence: 1002,
    observedRoundKeys: [], acknowledgedRoundKeys: [],
  }))
  let clock = 2000
  let secondAttempts = 0
  const sent = []
  const pusher = createSnapshotPusher({
    targetUrl: 'https://render.example/api/cloud-ingest/snapshot', key: 'worker-key', queuePath,
    maxDrainPerTick: 3, baseBackoffMs: 60000, maxBackoffMs: 60000,
    now: () => clock,
    getSnapshot: async () => ({ sessionId: 'vm', buildVersion: '101', tables: [], rounds: [] }),
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body)
      sent.push(body.sequence)
      if (body.sequence === 1001 && secondAttempts++ === 0) {
        clock = 122000
        throw new Error('slow durable ingest failed')
      }
      return acceptedResponse(options)
    },
  })

  assert.equal(await pusher.tick(), true)
  assert.deepEqual(sent, [1000, 1001])
  let queue = JSON.parse(await readFile(queuePath, 'utf8'))
  assert.deepEqual(queue.entries.map((entry) => entry.sequence), [1001, 1002])

  clock = 122001
  assert.equal(await pusher.tick(), false)
  assert.deepEqual(sent, [1000, 1001], 'retry must wait from the actual failure time')
  queue = JSON.parse(await readFile(queuePath, 'utf8'))
  assert.equal(queue.entries[0].sequence, 1001)

  clock = 182000
  assert.equal(await pusher.tick(), true)
  assert.deepEqual(sent, [1000, 1001, 1001, 1002])
  await assert.rejects(readFile(queuePath, 'utf8'), { code: 'ENOENT' })
})

test('v104 migration restamps retained v098 and v102 snapshots so an empty head cannot block the v104 FIFO', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-v100-build-migration-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const queuePath = path.join(dir, 'latest.json')
  const key = 'BAG01:8:1'
  const final = {
    tableId: 'BAG01', shoe: 8, round: 1, winner: 'banker',
    rawResult: [11, 25, 7, 19, -1, -1, -1, -1, 4, 6],
    sourceAction: '/api/v1/gametype/*/game/*/room/*/table/*/summary',
  }
  await writeFile(queuePath, JSON.stringify({ version: 2, entries: [
    {
      protocolVersion: 'v098', sessionId: 'vm', timestamp: 1000, captureTimestamp: 1000,
      sequence: 1000, roundKeys: [], snapshot: { sessionId: 'vm', buildVersion: '098', tables: [], rounds: [] },
    },
    {
      protocolVersion: 'v102', sessionId: 'vm', timestamp: 1001, captureTimestamp: 1001,
      sequence: 1001, roundKeys: [key], snapshot: { sessionId: 'vm', buildVersion: '102', tables: [], rounds: [final] },
    },
  ] }))
  await writeFile(`${queuePath}.cursor.json`, JSON.stringify({
    version: 3, initialized: true, lastSequence: 1001,
    observedRoundKeys: [key], acknowledgedRoundKeys: [],
  }))
  const sent = []
  const pusher = createSnapshotPusher({
    targetUrl: 'https://render.example/api/cloud-ingest/snapshot', key: 'worker-key', queuePath,
    now: () => 3000,
    getSnapshot: async () => ({ sessionId: 'vm', buildVersion: '102', tables: [], rounds: [final] }),
    isRoundDeliverable: () => true,
    fetchImpl: async (_url, options) => { sent.push(JSON.parse(options.body)); return acceptedResponse(options) },
  })

  assert.equal(await pusher.tick(), true)
  assert.equal(sent[0].protocolVersion, 'v105')
  assert.equal(sent[0].sequence, 1000)
  assert.equal(sent[0].snapshot.buildVersion, '105')
  assert.deepEqual(sent[0].roundKeys, [])
  assert.equal(await pusher.tick(), true)
  assert.equal(sent[1].sequence, 1001)
  assert.equal(sent[1].snapshot.buildVersion, '105')
  assert.deepEqual(sent[1].roundKeys, [key])
  await assert.rejects(readFile(queuePath, 'utf8'), { code: 'ENOENT' })
})

test('pusher sanitizes tables and rounds before durable queue persistence', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-push-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const sent = []
  const pusher = createSnapshotPusher({
    targetUrl: 'https://render.example/api/cloud-ingest/snapshot', key: 'worker-key',
    queuePath: path.join(dir, 'latest.json'),
    getSnapshot: async () => ({
      sessionId: 'vm',
      tables: [{ tableId: 'BAG11' }, { tableId: 'BAG3A' }, { tableId: 'BAG01' }],
      rounds: [round('BAG01'), round('BAG11'), round('BAG3A')],
    }),
    fetchImpl: async (_url, options) => { sent.push(JSON.parse(options.body)); return acceptedResponse(options) },
  })

  assert.equal(await pusher.tick(), true)
  assert.deepEqual(sent[0].snapshot.tables.map((table) => table.tableId), ['BAG01', 'BAG03A'])
  assert.deepEqual(sent[0].snapshot.rounds.map((item) => item.tableId), ['BAG01', 'BAG03A'])
  assert.deepEqual(sent[0].roundKeys, ['BAG01:8:1', 'BAG03A:8:1'])

  function round(tableId) {
    return { tableId, shoe: 8, round: 1, winner: 'banker' }
  }
})

test('seeds v3 observed identities from retained verified-final v2 queue entries', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-final-cursor-migration-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const queuePath = path.join(dir, 'latest.json')
  const key = 'BAG01:8:3'
  const final = {
    tableId: 'BAG01', shoe: 8, round: 3, winner: 'banker',
    rawResult: [11, 25, 7, 19, -1, -1, -1, -1, 4, 6],
    sourceAction: '/api/v1/gametype/*/game/*/room/*/table/*/summary',
  }
  await writeFile(queuePath, JSON.stringify({ version: 2, entries: [{
    protocolVersion: 'v098', sessionId: 'vm', timestamp: 1000, captureTimestamp: 1000,
    sequence: 1000, roundKeys: [key], snapshot: { sessionId: 'vm', tables: [], rounds: [final] },
  }] }))
  await writeFile(`${queuePath}.cursor.json`, JSON.stringify({
    version: 2, initialized: true, lastSequence: 1000,
    observedRoundKeys: [key], acknowledgedRoundKeys: [],
  }))
  const pusher = createSnapshotPusher({
    targetUrl: 'https://render.example/api/cloud-ingest/snapshot', key: 'worker-key', queuePath,
    getSnapshot: async () => ({ sessionId: 'vm', tables: [], rounds: [] }),
    isRoundDeliverable: (round) => String(round.sourceAction).endsWith('/summary'),
    fetchImpl: async () => { throw new Error('network unavailable') },
    baseBackoffMs: 0,
    now: () => 2000,
  })

  assert.equal(await pusher.tick(), false)
  const cursor = JSON.parse(await readFile(`${queuePath}.cursor.json`, 'utf8'))
  assert.equal(cursor.version, 3)
  assert.deepEqual(cursor.observedRoundKeys, [key])
  const queued = JSON.parse(await readFile(queuePath, 'utf8'))
  assert.deepEqual(queued.entries.flatMap((entry) => entry.roundKeys), [key])
})

test('migrates a provisional v2 queue head and observed-only cursor so the same-identity final can ACK', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-final-migration-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const queuePath = path.join(dir, 'latest.json')
  const key = 'BAG01:8:3'
  const provisional = {
    tableId: 'BAG01', shoe: 8, round: 3, winner: 'player',
    rawResult: [31, 51, 25, 52, 0, 0, -1, -1, 5, 0],
    sourceAction: '/api/v1/gametype/*/game/*/room/*/table/*/show_poker',
  }
  const final = {
    tableId: 'BAG01', shoe: 8, round: 3, winner: 'banker',
    rawResult: [11, 25, 7, 19, -1, -1, -1, -1, 4, 6],
    sourceAction: '/api/v1/gametype/*/game/*/room/*/table/*/summary',
  }
  await writeFile(queuePath, JSON.stringify({ version: 2, entries: [{
    protocolVersion: 'v098', sessionId: 'vm', timestamp: 1000, captureTimestamp: 1000,
    sequence: 1000, roundKeys: [key], snapshot: { sessionId: 'vm', tables: [], rounds: [provisional] },
  }] }))
  await writeFile(`${queuePath}.cursor.json`, JSON.stringify({
    version: 2, initialized: true, lastSequence: 1000,
    observedRoundKeys: [key], acknowledgedRoundKeys: [],
  }))

  const sent = []
  const pusher = createSnapshotPusher({
    targetUrl: 'https://render.example/api/cloud-ingest/snapshot', key: 'worker-key', queuePath,
    getSnapshot: async () => ({ sessionId: 'vm', tables: [], rounds: [final] }),
    isRoundDeliverable: (round) => String(round.sourceAction).endsWith('/summary'),
    fetchImpl: async (_url, options) => { sent.push(JSON.parse(options.body)); return acceptedResponse(options) },
    now: () => 2000,
  })

  assert.equal(await pusher.tick(), true)
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0].roundKeys, [key])
  assert.match(sent[0].snapshot.rounds[0].sourceAction, /\/summary$/)
  const cursor = JSON.parse(await readFile(`${queuePath}.cursor.json`, 'utf8'))
  assert.equal(cursor.version, 3)
  assert.deepEqual(cursor.acknowledgedRoundKeys, [key])
})

test('pusher sanitizes legacy restored queue envelopes before replay', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-push-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const queuePath = path.join(dir, 'latest.json')
  await writeFile(queuePath, JSON.stringify({
    timestamp: 1000,
    sequence: 1000,
    snapshot: {
      sessionId: 'vm',
      tables: [{ tableId: 'BAG11' }, { tableId: 'BAG01' }],
      rounds: [
        { tableId: 'BAG11', shoe: 8, round: 1, winner: 'banker' },
        { tableId: 'BAG01', shoe: 8, round: 1, winner: 'player' },
      ],
    },
  }))
  const sent = []
  const pusher = createSnapshotPusher({
    targetUrl: 'https://render.example/api/cloud-ingest/snapshot', key: 'worker-key', queuePath,
    getSnapshot: async () => ({ sessionId: 'vm', tables: [], rounds: [] }),
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body)
      sent.push(body)
      if (body.sequence === 1000) return {
        status: 200,
        json: async () => ({ accepted: true, sessionId: 'vm', sequence: 1000, acceptedRoundKeys: ['BAG11:8:1', 'BAG01:8:1'] }),
      }
      return acceptedResponse(options)
    },
  })

  assert.equal(await pusher.tick(), true)
  assert.ok(sent[0].sequence > 1000, 'sanitized legacy envelope must receive a fresh sequence')
  assert.deepEqual(sent[0].snapshot.tables.map((table) => table.tableId), ['BAG01'])
  assert.deepEqual(sent[0].snapshot.rounds.map((round) => round.tableId), ['BAG01'])
  assert.deepEqual(sent[0].roundKeys, ['BAG01:8:1'])
})

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
      return acceptedResponse(options)
    },
    baseBackoffMs: 1000,
  })

  assert.equal(await pusher.tick(), false)
  assert.equal(attempts, 1)
  round = 2
  clock = 1500
  assert.equal(await pusher.tick(), false)
  assert.equal(attempts, 1, 'backoff suppresses an early retry')
  assert.equal(JSON.parse(await readFile(queuePath, 'utf8')).entries[0].snapshot.tables[0].round, 1, 'pending envelope is not replaced before ack')

  clock = 2000
  assert.equal(await pusher.tick(), true)
  assert.equal(attempts, 2)
  assert.equal(sent[1].timestamp, 2000, 'retry refreshes the request timestamp')
  assert.deepEqual({ ...sent[1], timestamp: sent[0].timestamp }, sent[0], 'retry preserves capture identity and snapshot')
  await assert.rejects(readFile(queuePath, 'utf8'), { code: 'ENOENT' })
})

test('pusher restores the queued envelope, keeps collecting, and only 2xx acknowledges it', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-push-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const queuePath = path.join(dir, 'latest.json')
  let snapshotCalls = 0
  const original = {
    timestamp: 1000,
    sequence: 1000,
    snapshot: { sessionId: 'vm', buildVersion: '098', tables: [], rounds: [{ tableId: 'BAG01', shoe: 8, round: 9, winner: 'banker' }] },
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
      return status === 204 ? acceptedResponse(options, status) : { status }
    },
    baseBackoffMs: 0,
  })

  assert.equal(await pusher.tick(), false, 'redirect is not an acknowledgement')
  assert.equal(snapshotCalls, 1)
  assert.equal(sent[0].protocolVersion, 'v105')
  assert.equal(sent[0].sessionId, 'vm')
  assert.deepEqual(sent[0].roundKeys, ['BAG01:8:9'])
  assert.deepEqual(sent[0].snapshot, { ...original.snapshot, buildVersion: '105' })
  const queuedAfterRedirect = JSON.parse(await readFile(queuePath, 'utf8')).entries[0]
  assert.equal(queuedAfterRedirect.timestamp, 1000, 'transport retry time is not a durable capture identity')
  assert.deepEqual({ ...queuedAfterRedirect, timestamp: sent[0].timestamp }, sent[0])
  assert.equal(await pusher.tick(), true)
  assert.equal(snapshotCalls, 2)
  assert.deepEqual({ ...sent[1], timestamp: sent[0].timestamp }, sent[0])
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
  assert.ok(JSON.parse(await readFile(queuePath, 'utf8')).entries[0].snapshot)
})

test('pusher durably sends every previously unacknowledged retained round, then only new rounds across restarts', async (t) => {
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
    fetchImpl: async (_url, options) => { sent.push(JSON.parse(options.body)); return acceptedResponse(options) },
  })

  const first = create(async () => snapshots.shift())
  assert.equal(await first.tick(), true)
  assert.deepEqual(sent[0].snapshot.rounds.map((item) => item.round), [1, 2], 'first observation is unacknowledged and must be delivered')
  assert.equal(await first.tick(), true)
  assert.deepEqual(sent[1].snapshot.rounds.map((item) => item.round), [3])

  const restarted = create(async () => ({ sessionId: 'vm', tables: [], rounds: [round(1), round(2), round(3), round(4)] }))
  assert.equal(await restarted.tick(), true)
  assert.deepEqual(sent[2].snapshot.rounds.map((item) => item.round), [4], 'ack cursor survives restart')

  function round(number) {
    return { tableId: 'BAG01', shoe: 8, round: number, winner: 'banker' }
  }
})

test('pusher never uses the table shoe when completed rounds omit shoe', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-push-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const sent = []
  const snapshots = [snapshot(8), snapshot(9)]
  const pusher = createSnapshotPusher({
    targetUrl: 'https://render.example/api/cloud-ingest/snapshot', key: 'worker-key',
    queuePath: path.join(dir, 'latest.json'),
    getSnapshot: async () => snapshots.shift(),
    fetchImpl: async (_url, options) => { sent.push(JSON.parse(options.body)); return acceptedResponse(options) },
  })

  assert.equal(await pusher.tick(), true)
  assert.deepEqual(sent[0].snapshot.rounds, [])
  assert.equal(await pusher.tick(), true)
  assert.deepEqual(sent[1].snapshot.rounds, [], 'missing-shoe completion remains fail-closed after rollover')

  function snapshot(shoe) {
    return {
      sessionId: 'vm',
      tables: [{ tableId: 'BAG01', shoe, round: 1 }],
      rounds: [{ tableId: 'BAG01', shoe: null, round: 1, winner: 'banker' }],
    }
  }
})

test('pusher does not borrow the canonical BAG01 table shoe for BAG1 rounds', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-push-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const sent = []
  const snapshots = [snapshot(8), snapshot(9)]
  const pusher = createSnapshotPusher({
    targetUrl: 'https://render.example/api/cloud-ingest/snapshot', key: 'worker-key',
    queuePath: path.join(dir, 'latest.json'),
    getSnapshot: async () => snapshots.shift(),
    fetchImpl: async (_url, options) => { sent.push(JSON.parse(options.body)); return acceptedResponse(options) },
  })

  assert.equal(await pusher.tick(), true)
  assert.deepEqual(sent[0].snapshot.rounds, [])
  assert.equal(await pusher.tick(), true)
  assert.deepEqual(sent[1].snapshot.rounds, [])

  function snapshot(shoe) {
    return {
      sessionId: 'vm',
      tables: [{ tableId: 'BAG01', shoe, round: 1 }],
      rounds: [{ tableId: 'BAG1', shoe: null, round: 1, winner: 'banker' }],
    }
  }
})

test('pusher does not borrow the canonical BAG01A table shoe for BAG1A rounds', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-push-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const sent = []
  const snapshots = [snapshot(8), snapshot(9)]
  const pusher = createSnapshotPusher({
    targetUrl: 'https://render.example/api/cloud-ingest/snapshot', key: 'worker-key',
    queuePath: path.join(dir, 'latest.json'),
    getSnapshot: async () => snapshots.shift(),
    fetchImpl: async (_url, options) => { sent.push(JSON.parse(options.body)); return acceptedResponse(options) },
  })

  assert.equal(await pusher.tick(), true)
  assert.equal(await pusher.tick(), true)
  assert.deepEqual(sent[1].snapshot.rounds, [])

  function snapshot(shoe) {
    return {
      sessionId: 'vm',
      tables: [{ tableId: 'BAG01A', shoe, round: 1 }],
      rounds: [{ tableId: 'BAG1A', shoe: null, round: 1, winner: 'banker' }],
    }
  }
})

test('pusher rejects all retained missing-shoe events after rollover', async (t) => {
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
    fetchImpl: async (_url, options) => { sent.push(JSON.parse(options.body)); return acceptedResponse(options) },
  })

  assert.equal(await create().tick(), true)
  assert.deepEqual(sent[0].snapshot.rounds, [])
  assert.equal(await create().tick(), true, 'first-seen shoe identity survives a restart')
  assert.deepEqual(sent[1].snapshot.rounds, [])
})

test('pusher rejects a missing-shoe round in a new capture session', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-push-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const sent = []
  const snapshots = [snapshot('capture-1'), snapshot('capture-2')]
  const pusher = createSnapshotPusher({
    targetUrl: 'https://render.example/api/cloud-ingest/snapshot', key: 'worker-key',
    queuePath: path.join(dir, 'latest.json'),
    getSnapshot: async () => snapshots.shift(),
    fetchImpl: async (_url, options) => { sent.push(JSON.parse(options.body)); return acceptedResponse(options) },
  })

  assert.equal(await pusher.tick(), true)
  assert.deepEqual(sent[0].snapshot.rounds, [])
  assert.equal(await pusher.tick(), true)
  assert.deepEqual(sent[1].snapshot.rounds, [])

  function snapshot(sessionId) {
    return {
      sessionId,
      tables: [{ tableId: 'BAG01', shoe: sessionId === 'capture-1' ? 8 : 9, round: 1 }],
      rounds: [{ tableId: 'BAG01', shoe: null, round: 1, winner: 'banker', rawResult: [1, 2, 3] }],
    }
  }
})

test('pusher rejects an identical missing-shoe event after capture session and shoe roll over', async (t) => {
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
    fetchImpl: async (_url, options) => { sent.push(JSON.parse(options.body)); return acceptedResponse(options) },
  })

  assert.equal(await create().tick(), true)
  assert.deepEqual(sent[0].snapshot.rounds, [])
  assert.equal(await create().tick(), true)
  assert.deepEqual(sent[1].snapshot.rounds, [])
})

test('pusher rejects missing-shoe A-suffix rounds after rollover', async (t) => {
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
    fetchImpl: async (_url, options) => { sent.push(JSON.parse(options.body)); return acceptedResponse(options) },
  })

  assert.equal(await create().tick(), true)
  assert.deepEqual(sent[0].snapshot.rounds, [])
  assert.equal(await create().tick(), true)
  assert.deepEqual(sent[1].snapshot.rounds, [])
})

test('pusher rejects a conflicting duplicate for the same table shoe and round key', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-push-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const sent = []
  const snapshots = [snapshot([1, 2, 3]), snapshot([4, 5, 6]), snapshot([4, 5, 6])]
  const pusher = createSnapshotPusher({
    targetUrl: 'https://render.example/api/cloud-ingest/snapshot', key: 'worker-key',
    queuePath: path.join(dir, 'latest.json'),
    getSnapshot: async () => snapshots.shift(),
    fetchImpl: async (_url, options) => { sent.push(JSON.parse(options.body)); return acceptedResponse(options) },
  })

  assert.equal(await pusher.tick(), true)
  assert.deepEqual(sent[0].snapshot.rounds, [])
  assert.equal(await pusher.tick(), true)
  assert.deepEqual(sent[1].snapshot.rounds, [])
  assert.equal(await pusher.tick(), true)
  assert.deepEqual(sent[2].snapshot.rounds, [], 'the same retained event remains acknowledged')

  function snapshot(rawResult) {
    return {
      sessionId: 'capture-1',
      tables: [{ tableId: 'BAG01', shoe: 8, round: 1 }],
      rounds: [{ tableId: 'BAG01', shoe: null, round: 1, winner: 'banker', rawResult }],
    }
  }
})

test('pusher does not bypass table shoe round dedupe when only the capture event id changes', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-push-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const sent = []
  const snapshots = [snapshot('capture-1:1'), snapshot('capture-1:2')]
  const pusher = createSnapshotPusher({
    targetUrl: 'https://render.example/api/cloud-ingest/snapshot', key: 'worker-key',
    queuePath: path.join(dir, 'latest.json'),
    getSnapshot: async () => snapshots.shift(),
    fetchImpl: async (_url, options) => { sent.push(JSON.parse(options.body)); return acceptedResponse(options) },
  })

  assert.equal(await pusher.tick(), true)
  assert.deepEqual(sent[0].snapshot.rounds, [])
  assert.equal(await pusher.tick(), true)
  assert.deepEqual(sent[1].snapshot.rounds, [])

  function snapshot(sourceEventId) {
    return {
      sessionId: 'capture-1',
      tables: [{ tableId: 'BAG01', shoe: 8, round: 1 }],
      rounds: [{ tableId: 'BAG01', shoe: null, round: 1, winner: 'banker', rawResult: [1, 2, 3], sourceEventId }],
    }
  }
})

test('pusher keeps the durable queue until session sequence and accepted round keys exactly match', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-push-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const queuePath = path.join(dir, 'latest.json')
  const snapshots = [
    { sessionId: 'vm', tables: [{ tableId: 'BAG01', shoe: 8, round: 1 }], rounds: [round(1)] },
    { sessionId: 'vm', tables: [{ tableId: 'BAG01', shoe: 8, round: 2 }], rounds: [round(1), round(2)] },
  ]
  let attempt = 0
  const pusher = createSnapshotPusher({
    targetUrl: 'https://render.example/api/cloud-ingest/snapshot', key: 'worker-key', queuePath,
    getSnapshot: async () => snapshots.shift(),
    fetchImpl: async (_url, options) => {
      attempt += 1
      const envelope = JSON.parse(options.body)
      if (attempt === 2) return { status: 200, json: async () => ({ accepted: true, sessionId: envelope.sessionId, sequence: envelope.sequence, acceptedRoundKeys: ['BAG01:8:999'] }) }
      return acceptedResponse(options)
    },
    baseBackoffMs: 0,
  })

  assert.equal(await pusher.tick(), true)
  assert.equal(await pusher.tick(), false)
  assert.deepEqual(JSON.parse(await readFile(queuePath, 'utf8')).entries[0].roundKeys, ['BAG01:8:2'])
  assert.equal(await pusher.tick(), true)
  await assert.rejects(readFile(queuePath, 'utf8'), { code: 'ENOENT' })

  function round(number) {
    return { tableId: 'BAG01', shoe: 8, round: number, winner: 'banker', rawResult: [1, 2, 3, 4, -1, -1, -1, -1, 3, 7] }
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
    fetchImpl: async (url, options) => { requests.push({ url, options }); return acceptedResponse(options) },
  })
  assert.equal(await pusher.tick(), true)
  clock += 5000
  assert.equal(await pusher.tick(), true)
  assert.equal(requests[0].options.headers['x-worker-key'], 'worker-key')
  assert.equal(JSON.parse(requests[0].options.body).timestamp, 5000)
  assert.ok(JSON.parse(requests[1].options.body).sequence > JSON.parse(requests[0].options.body).sequence)
})

test('pusher fail-closes a completed round without its own shoe instead of borrowing the table shoe', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-push-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const sent = []
  const pusher = createSnapshotPusher({
    targetUrl: 'https://render.example/api/cloud-ingest/snapshot', key: 'worker-key',
    queuePath: path.join(dir, 'latest.json'),
    getSnapshot: async () => ({
      sessionId: 'vm',
      tables: [{ tableId: 'BAG01', shoe: 8, round: 1 }],
      rounds: [{ tableId: 'BAG01', shoe: null, round: 1, winner: 'banker' }],
    }),
    fetchImpl: async (_url, options) => { sent.push(JSON.parse(options.body)); return acceptedResponse(options) },
  })

  assert.equal(await pusher.tick(), true)
  assert.deepEqual(sent[0].roundKeys, [])
  assert.deepEqual(sent[0].snapshot.rounds, [])
})

test('durable FIFO keeps collecting new rounds while its unacknowledged head retries', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-push-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const queuePath = path.join(dir, 'latest.json')
  const snapshots = [snapshot([1]), snapshot([1, 2]), snapshot([1, 2, 3]), snapshot([1, 2, 3])]
  const sent = []
  let attempt = 0
  let lostAcceptedSequence = 0
  const pusher = createSnapshotPusher({
    targetUrl: 'https://render.example/api/cloud-ingest/snapshot', key: 'worker-key', queuePath,
    getSnapshot: async () => snapshots.shift(),
    fetchImpl: async (_url, options) => {
      attempt += 1
      sent.push(JSON.parse(options.body))
      if (attempt === 2) {
        lostAcceptedSequence = sent.at(-1).sequence
        throw new Error('server committed but acknowledgement was lost')
      }
      if (attempt === 3) assert.equal(sent.at(-1).sequence, lostAcceptedSequence)
      return acceptedResponse(options)
    },
    baseBackoffMs: 0,
  })

  assert.equal(await pusher.tick(), true, 'first observation is baseline only')
  assert.equal(await pusher.tick(), false, 'round 2 remains at the FIFO head')
  assert.equal(await pusher.tick(), true, 'round 3 is queued while the exact round 2 head retries')
  assert.equal(sent[2].sequence, lostAcceptedSequence)
  assert.deepEqual(sent[2].roundKeys, ['BAG01:8:2'])
  assert.equal(await pusher.tick(), true, 'round 3 drains under its own sequence')
  assert.ok(sent[3].sequence > lostAcceptedSequence)
  assert.deepEqual(sent[3].roundKeys, ['BAG01:8:3'])
  await assert.rejects(readFile(queuePath, 'utf8'), { code: 'ENOENT' })

  function snapshot(numbers) {
    return { sessionId: 'vm', tables: [], rounds: numbers.map((number) => ({ tableId: 'BAG01', shoe: 8, round: number, winner: 'banker' })) }
  }
})

test('a new round after a lost ACK stays behind the bit-stable sent sequence', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-immutable-retry-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const queuePath = path.join(dir, 'latest.json')
  const rounds = [1, 2, 3].map((round) => ({
    tableId: 'BAG01', shoe: 8, round, winner: 'banker',
    rawResult: [11, 25, 7, 19, -1, -1, -1, -1, 4, 6],
    sourceAction: '/api/v1/gametype/*/game/*/room/*/table/*/summary',
  }))
  const initialEntries = rounds.slice(0, 2).map((round, index) => ({
    protocolVersion: 'v105', sessionId: 'vm', timestamp: 1000 + index, captureTimestamp: 1000 + index,
    sequence: 1000 + index, roundKeys: [`BAG01:8:${round.round}`],
    snapshot: { sessionId: 'vm', buildVersion: '105', tables: [], rounds: [round] },
  }))
  await writeFile(queuePath, JSON.stringify({ version: 3, entries: initialEntries }))
  await writeFile(`${queuePath}.cursor.json`, JSON.stringify({
    version: 3, initialized: true, lastSequence: 1001,
    observedRoundKeys: initialEntries.flatMap((entry) => entry.roundKeys), acknowledgedRoundKeys: [],
  }))
  const snapshots = [
    { sessionId: 'vm', buildVersion: '105', tables: [], rounds: rounds.slice(0, 2) },
    { sessionId: 'vm', buildVersion: '105', tables: [], rounds },
  ]
  const sent = []
  let clock = 3000
  const pusher = createSnapshotPusher({
    targetUrl: 'https://render.example/api/cloud-ingest/snapshot', key: 'worker-key', queuePath,
    now: () => clock++, getSnapshot: async () => snapshots.shift(), isRoundDeliverable: () => true,
    baseBackoffMs: 0,
    fetchImpl: async (_url, options) => {
      sent.push(JSON.parse(options.body))
      throw new Error('server committed but acknowledgement was lost')
    },
  })

  assert.equal(await pusher.tick(), false)
  assert.equal(await pusher.tick(), false)
  assert.equal(sent[0].sequence, 1000)
  assert.equal(sent[1].sequence, sent[0].sequence)
  assert.deepEqual(sent[0].roundKeys, ['BAG01:8:1'])
  const { timestamp: firstRequestAt, ...firstIdentity } = sent[0]
  const { timestamp: retryRequestAt, ...retryIdentity } = sent[1]
  assert.ok(retryRequestAt >= firstRequestAt)
  assert.deepEqual(retryIdentity, firstIdentity)
  const retained = JSON.parse(await readFile(queuePath, 'utf8')).entries
  assert.deepEqual(retained.map((entry) => entry.roundKeys), [
    ['BAG01:8:1'], ['BAG01:8:2'], ['BAG01:8:3'],
  ])
  assert.ok(retained[2].sequence > retained[1].sequence)
})

test('restored FIFO head is not appended again when queue persisted before its observed cursor', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-push-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const queuePath = path.join(dir, 'latest.json')
  const queuedRound = { tableId: 'BAG01', shoe: 8, round: 2, winner: 'banker' }
  const queuedEnvelope = {
    protocolVersion: 'v098', sessionId: 'vm', timestamp: 1000, captureTimestamp: 1000,
    sequence: 1000, roundKeys: ['BAG01:8:2'],
    snapshot: { sessionId: 'vm', tables: [], rounds: [queuedRound] },
  }
  await writeFile(queuePath, JSON.stringify({ version: 2, entries: [queuedEnvelope] }))
  await writeFile(`${queuePath}.cursor.json`, JSON.stringify({
    version: 3, initialized: true,
    observedRoundKeys: ['BAG01:8:1'], acknowledgedRoundKeys: [],
  }))
  const sent = []
  const pusher = createSnapshotPusher({
    targetUrl: 'https://render.example/api/cloud-ingest/snapshot', key: 'worker-key', queuePath,
    getSnapshot: async () => ({
      sessionId: 'vm', tables: [],
      rounds: [
        { tableId: 'BAG01', shoe: 8, round: 1, winner: 'player' },
        queuedRound,
      ],
    }),
    fetchImpl: async (_url, options) => { sent.push(JSON.parse(options.body)); return acceptedResponse(options) },
  })

  assert.equal(await pusher.tick(), true)
  assert.deepEqual(sent.map((envelope) => envelope.roundKeys), [['BAG01:8:2']])
  await assert.rejects(readFile(queuePath, 'utf8'), { code: 'ENOENT' })
})

test('restored oversized FIFO head is split without losing keys or changing its head sequence', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-bounded-queue-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const queuePath = path.join(dir, 'latest.json')
  const rounds = Array.from({ length: 12 }, (_, index) => ({
    tableId: 'BAG01', shoe: 8, round: index + 1, winner: 'banker',
  }))
  const roundKeys = rounds.map((round) => `${round.tableId}:${round.shoe}:${round.round}`)
  await writeFile(queuePath, JSON.stringify({
    version: 3,
    entries: [{
      protocolVersion: 'v105', sessionId: 'vm', timestamp: 1000, captureTimestamp: 1000,
      sequence: 1000, roundKeys, snapshot: { sessionId: 'vm', tables: [], rounds },
    }],
  }))
  await writeFile(`${queuePath}.cursor.json`, JSON.stringify({
    version: 3, initialized: true, lastSequence: 1000,
    observedRoundKeys: roundKeys, acknowledgedRoundKeys: [],
  }))
  const sent = []
  const pusher = createSnapshotPusher({
    targetUrl: 'https://render.example/api/cloud-ingest/snapshot', key: 'worker-key', queuePath,
    maxRoundsPerEnvelope: 5,
    getSnapshot: async () => ({ sessionId: 'vm', tables: [], rounds }),
    fetchImpl: async (_url, options) => {
      sent.push(JSON.parse(options.body))
      throw new Error('keep the migrated queue for inspection')
    },
    baseBackoffMs: 0,
  })

  assert.equal(await pusher.tick(), false)
  const queue = JSON.parse(await readFile(queuePath, 'utf8')).entries
  assert.deepEqual(queue.map((entry) => entry.roundKeys.length), [5, 5, 2])
  assert.equal(queue[0].sequence, 1000)
  assert.deepEqual(queue.flatMap((entry) => entry.roundKeys), roundKeys)
  assert.deepEqual(sent[0].roundKeys, roundKeys.slice(0, 5))
})

test('first observation becomes acknowledged only after the proxy explicitly accepts its round key', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-push-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const queuePath = path.join(dir, 'latest.json')
  const pusher = createSnapshotPusher({
    targetUrl: 'https://render.example/api/cloud-ingest/snapshot', key: 'worker-key', queuePath,
    getSnapshot: async () => ({ sessionId: 'vm', tables: [], rounds: [{ tableId: 'BAG01', shoe: 8, round: 1, winner: 'banker' }] }),
    fetchImpl: async (_url, options) => acceptedResponse(options),
  })

  assert.equal(await pusher.tick(), true)
  const cursor = JSON.parse(await readFile(`${queuePath}.cursor.json`, 'utf8'))
  assert.deepEqual(cursor.observedRoundKeys, ['BAG01:8:1'])
  assert.deepEqual(cursor.acknowledgedRoundKeys, ['BAG01:8:1'])
})

test('acknowledged sequence high-water survives restart and clock rollback', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-push-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const queuePath = path.join(dir, 'latest.json')
  const sent = []
  const create = (clock) => createSnapshotPusher({
    targetUrl: 'https://render.example/api/cloud-ingest/snapshot', key: 'worker-key', queuePath,
    now: () => clock,
    getSnapshot: async () => ({ sessionId: 'vm', tables: [], rounds: [] }),
    fetchImpl: async (_url, options) => { sent.push(JSON.parse(options.body)); return acceptedResponse(options) },
  })

  assert.equal(await create(1000).tick(), true)
  assert.equal(await create(500).tick(), true)
  assert.ok(sent[1].sequence > sent[0].sequence)
})

test('retry refreshes request timestamp but preserves capture identity and payload', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-push-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  let clock = 1000
  const sent = []
  let attempt = 0
  const pusher = createSnapshotPusher({
    targetUrl: 'https://render.example/api/cloud-ingest/snapshot', key: 'worker-key',
    queuePath: path.join(dir, 'latest.json'), now: () => clock,
    getSnapshot: async () => ({ sessionId: 'vm', tables: [], rounds: [] }),
    fetchImpl: async (_url, options) => {
      attempt += 1
      sent.push(JSON.parse(options.body))
      if (attempt === 1) throw new Error('retry')
      return acceptedResponse(options)
    },
    baseBackoffMs: 0,
  })

  assert.equal(await pusher.tick(), false)
  clock = 2000
  assert.equal(await pusher.tick(), true)
  assert.equal(sent[0].timestamp, 1000)
  assert.equal(sent[1].timestamp, 2000)
  assert.equal(sent[1].captureTimestamp, sent[0].captureTimestamp)
  assert.equal(sent[1].sequence, sent[0].sequence)
  assert.deepEqual(sent[1].roundKeys, sent[0].roundKeys)
  assert.deepEqual(sent[1].snapshot, sent[0].snapshot)
})

for (const stateName of ['queue', 'cursor']) {
  test(`corrupt ${stateName} JSON is quarantined and stops the pusher`, async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'darven-push-'))
    t.after(() => rm(dir, { recursive: true, force: true }))
    const queuePath = path.join(dir, 'latest.json')
    const corruptPath = stateName === 'queue' ? queuePath : `${queuePath}.cursor.json`
    await writeFile(corruptPath, '{not-json')
    let snapshotCalls = 0
    let fetchCalls = 0
    const pusher = createSnapshotPusher({
      targetUrl: 'https://render.example/api/cloud-ingest/snapshot', key: 'worker-key', queuePath,
      getSnapshot: async () => { snapshotCalls += 1; return { sessionId: 'vm', tables: [], rounds: [] } },
      fetchImpl: async () => { fetchCalls += 1; throw new Error('must not send') },
    })

    await assert.rejects(pusher.tick(), /corrupt/i)
    assert.equal(await pusher.tick(), false)
    assert.equal(snapshotCalls, 0)
    assert.equal(fetchCalls, 0)
    assert.ok((await readdir(dir)).some((name) => name.startsWith(path.basename(corruptPath) + '.corrupt-')))
  })
}

test('retained v2 v105 data queue is preserved and blocked for explicit cutover review', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-legacy-mutable-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const queuePath = path.join(dir, 'latest.json')
  const entry = {
    protocolVersion: 'v105', sessionId: 'vm', timestamp: 1000, captureTimestamp: 1000, sequence: 1000,
    roundKeys: ['BAG01:8:1'], snapshot: { sessionId: 'vm', buildVersion: '105', tables: [], rounds: [{ tableId: 'BAG01', shoe: 8, round: 1 }] },
  }
  const original = JSON.stringify({ version: 2, entries: [entry] })
  await writeFile(queuePath, original)
  let fetchCalls = 0
  const pusher = createSnapshotPusher({
    targetUrl: 'https://render.example/api/cloud-ingest/snapshot', key: 'worker-key', queuePath,
    getSnapshot: async () => ({ sessionId: 'vm', tables: [], rounds: [] }),
    fetchImpl: async () => { fetchCalls += 1; throw new Error('must not send') },
  })
  assert.equal(await pusher.tick(), false)
  assert.equal(fetchCalls, 0)
  assert.equal(pusher.snapshot().legacyMutableQueueDetected, true)
  assert.equal(pusher.snapshot().stateInvalid, true)
  assert.equal(await readFile(queuePath, 'utf8'), original)
})

test('structurally invalid durable state is quarantined before the pusher stops', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-push-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const queuePath = path.join(dir, 'latest.json')
  await writeFile(queuePath, JSON.stringify({ version: 2, entries: [{}] }))
  const pusher = createSnapshotPusher({
    targetUrl: 'https://render.example/api/cloud-ingest/snapshot', key: 'worker-key', queuePath,
    getSnapshot: async () => ({ sessionId: 'vm', tables: [], rounds: [] }),
    fetchImpl: async () => { throw new Error('must not send') },
  })

  await assert.rejects(pusher.tick(), /corrupt queue/i)
  assert.ok((await readdir(dir)).some((name) => name.startsWith('latest.json.corrupt-')))
})

test('pusher health exposes durable backlog and failed delivery then clears after exact ACK', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-push-health-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const queuePath = path.join(dir, 'latest.json')
  const final = {
    tableId: 'BAG01', shoe: 8, round: 1, winner: 'banker',
    rawResult: [11, 25, 7, 19, -1, -1, -1, -1, 4, 6],
    sourceAction: '/api/v1/gametype/*/game/*/room/*/table/*/summary',
  }
  let fail = true
  let clock = 1000
  const pusher = createSnapshotPusher({
    targetUrl: 'https://render.example/api/cloud-ingest/snapshot', key: 'worker-key', queuePath,
    now: () => clock++, getSnapshot: async () => ({ sessionId: 'vm', tables: [], rounds: [final] }),
    isRoundDeliverable: () => true, baseBackoffMs: 0,
    fetchImpl: async (_url, options) => {
      if (fail) throw new Error('push offline token=must-not-leak Authorization: Bearer bearer-must-not-leak')
      return acceptedResponse(options)
    },
  })

  assert.equal(typeof pusher.snapshot, 'function')
  assert.equal(await pusher.tick(), false)
  const failed = pusher.snapshot()
  assert.equal(failed.queueEntryCount, 1)
  assert.equal(failed.queuedRoundKeyCount, 1)
  assert.equal(failed.consecutiveFailures, 1)
  assert.equal(Number.isFinite(failed.lastAttemptAtMs), true)
  assert.ok(failed.lastAttemptAtMs >= 1000)
  assert.equal(failed.lastSuccessAtMs, null)
  assert.match(failed.lastError, /push offline/)
  assert.doesNotMatch(failed.lastError, /must-not-leak/)
  assert.doesNotMatch(failed.lastError, /bearer-must-not-leak/i)
  assert.equal(failed.headSessionId, 'vm')
  assert.equal(Number.isSafeInteger(failed.headSequence), true)

  fail = false
  assert.equal(await pusher.tick(), true)
  const recovered = pusher.snapshot()
  assert.equal(recovered.queueEntryCount, 0)
  assert.equal(recovered.queuedRoundKeyCount, 0)
  assert.equal(recovered.consecutiveFailures, 0)
  assert.equal(recovered.lastError, null)
  assert.equal(Number.isFinite(recovered.lastSuccessAtMs), true)
})

test('delivery preserves each FIFO sequence while draining multiple entries in one tick', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-coalesce-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const queuePath = path.join(dir, 'latest.json')
  const rounds = [1, 2, 3].map((roundNo) => ({
    tableId: `BAG0${roundNo}`, shoe: 8, round: roundNo, winner: 'banker',
    rawResult: [11, 25, 7, 19, -1, -1, -1, -1, 4, 6],
    sourceAction: '/api/v1/gametype/*/game/*/room/*/table/*/summary',
  }))
  const entries = rounds.map((round, index) => ({
    protocolVersion: 'v105', sessionId: 'vm', timestamp: 1000 + index, captureTimestamp: 1000 + index,
    sequence: 1000 + index, roundKeys: [`${round.tableId}:8:${round.round}`],
    snapshot: { sessionId: 'vm', buildVersion: '105', tables: [], rounds: [round] },
  }))
  await writeFile(queuePath, JSON.stringify({ version: 3, entries }))
  await writeFile(`${queuePath}.cursor.json`, JSON.stringify({
    version: 3, initialized: true, lastSequence: 1002,
    observedRoundKeys: entries.flatMap((entry) => entry.roundKeys), acknowledgedRoundKeys: [],
  }))
  const sent = []
  const pusher = createSnapshotPusher({
    targetUrl: 'https://render.example/api/cloud-ingest/snapshot', key: 'worker-key', queuePath,
    now: () => 3000, getSnapshot: async () => ({ sessionId: 'vm', buildVersion: '105', tables: [], rounds }),
    isRoundDeliverable: () => true, maxDrainPerTick: 3,
    fetchImpl: async (_url, options) => { sent.push(JSON.parse(options.body)); return acceptedResponse(options) },
  })

  assert.equal(await pusher.tick(), true)
  assert.deepEqual(sent.map((item) => item.sequence), [1000, 1001, 1002])
  assert.deepEqual(sent.map((item) => item.roundKeys), [
    ['BAG01:8:1'], ['BAG02:8:2'], ['BAG03:8:3'],
  ])
  assert.deepEqual(sent.map((item) => item.snapshot.rounds.length), [1, 1, 1])
  await assert.rejects(readFile(queuePath, 'utf8'), { code: 'ENOENT' })
})

test('delivery limit can drain multiple bounded FIFO entries without widening durable entry size', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-delivery-limit-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const queuePath = path.join(dir, 'latest.json')
  const rounds = [1, 2, 3].map((round) => ({
    tableId: 'BAG01', shoe: 8, round, winner: 'banker',
    rawResult: [11, 25, 7, 19, -1, -1, -1, -1, 4, 6],
    sourceAction: '/api/v1/gametype/*/game/*/room/*/table/*/summary',
  }))
  const entries = rounds.map((round, index) => ({
    protocolVersion: 'v105', sessionId: 'vm', timestamp: 1000 + index, captureTimestamp: 1000 + index,
    sequence: 1000 + index, roundKeys: [`BAG01:8:${round.round}`],
    snapshot: { sessionId: 'vm', buildVersion: '105', tables: [], rounds: [round] },
  }))
  await writeFile(queuePath, JSON.stringify({ version: 3, entries }))
  await writeFile(`${queuePath}.cursor.json`, JSON.stringify({
    version: 3, initialized: true, lastSequence: 1002,
    observedRoundKeys: entries.flatMap((entry) => entry.roundKeys), acknowledgedRoundKeys: [],
  }))
  const sent = []
  const pusher = createSnapshotPusher({
    targetUrl: 'https://render.example/api/cloud-ingest/snapshot', key: 'worker-key', queuePath,
    maxRoundsPerEnvelope: 1, maxRoundsPerDelivery: 2, maxDrainPerTick: 2, now: () => 3000,
    getSnapshot: async () => ({ sessionId: 'vm', buildVersion: '105', tables: [], rounds }),
    isRoundDeliverable: () => true,
    fetchImpl: async (_url, options) => { sent.push(JSON.parse(options.body)); return acceptedResponse(options) },
  })

  assert.equal(await pusher.tick(), true)
  assert.deepEqual(sent.slice(0, 2).map((item) => item.roundKeys), [['BAG01:8:1'], ['BAG01:8:2']])
  const queued = JSON.parse(await readFile(queuePath, 'utf8')).entries
  assert.equal(queued.length, 1)
  assert.deepEqual(queued[0].roundKeys, ['BAG01:8:3'])
  assert.equal(await pusher.tick(), true)
  assert.deepEqual(sent.map((item) => item.roundKeys), [['BAG01:8:1'], ['BAG01:8:2'], ['BAG01:8:3']])
  await assert.rejects(readFile(queuePath), { code: 'ENOENT' })
})

test('large durable queue is atomically compressed and restores without losing its exact head', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-gzip-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const queuePath = path.join(dir, 'latest.json')
  const final = {
    tableId: 'BAG01', shoe: 8, round: 1, winner: 'banker',
    rawResult: [11, 25, 7, 19, -1, -1, -1, -1, 4, 6],
    sourceAction: '/api/v1/gametype/*/game/*/room/*/table/*/summary',
  }
  const snapshot = { sessionId: 'vm', buildVersion: '105', tables: [], rounds: [final] }
  const first = createSnapshotPusher({
    targetUrl: 'https://render.example/api/cloud-ingest/snapshot', key: 'worker-key', queuePath,
    queueCompressionThresholdBytes: 1, getSnapshot: async () => snapshot, isRoundDeliverable: () => true,
    fetchImpl: async () => { throw new Error('offline') }, baseBackoffMs: 0,
  })
  assert.equal(await first.tick(), false)
  const compressed = await readFile(queuePath)
  assert.deepEqual([...compressed.subarray(0, 2)], [0x1f, 0x8b])

  const sent = []
  const restarted = createSnapshotPusher({
    targetUrl: 'https://render.example/api/cloud-ingest/snapshot', key: 'worker-key', queuePath,
    queueCompressionThresholdBytes: 1, getSnapshot: async () => snapshot, isRoundDeliverable: () => true,
    fetchImpl: async (_url, options) => { sent.push(JSON.parse(options.body)); return acceptedResponse(options) },
  })
  assert.equal(await restarted.tick(), true)
  assert.deepEqual(sent[0].roundKeys, ['BAG01:8:1'])
  await assert.rejects(readFile(queuePath), { code: 'ENOENT' })
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

function acceptedResponse(options, status = 200) {
  const envelope = JSON.parse(options.body)
  return {
    status,
    json: async () => ({
      ok: true,
      accepted: true,
      duplicate: false,
      sessionId: envelope.sessionId,
      sequence: envelope.sequence,
      acceptedRoundKeys: envelope.roundKeys ?? [],
    }),
  }
}
