import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createShadowProcessClient } from '../src/shadow-process-client.js'
import { createShadowProcessWriter } from '../src/shadow-process-writer.js'

const READY = Object.freeze({ enabled: 1, prepared: 1, pending: 0, queued: 0, failed: 0, disabled: 0 })
const EMPTY = Object.freeze({ enabled: 0, prepared: 0, pending: 0, queued: 0, failed: 0, disabled: 0 })
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function fakeChild(scope, { stallCapture = false } = {}) {
  const child = new EventEmitter()
  child.connected = true
  child.exitCode = null
  child.signalCode = null
  child.scope = scope
  child.sent = []
  child.send = (message, callback) => {
    child.sent.push(structuredClone(message))
    callback?.(null)
    if (message.type === 'writer_response') return
    if (stallCapture && message.kind === 'capture') return
    const result = message.kind === 'prepare' ? (scope === 'required' ? EMPTY : READY) : { observed: 1, settled: 0, noops: 0 }
    setImmediate(() => child.emit('message', {
      type: 'response', id: message.id, ok: true, result,
      snapshots: message.runtime ? { [message.runtime]: { status: 'ready' } } : {},
    }))
  }
  child.kill = (signal) => {
    if (child.exitCode != null || child.signalCode != null) return false
    child.connected = false
    child.signalCode = signal
    setImmediate(() => child.emit('exit', null, signal))
    return true
  }
  return child
}

test('V9 runs in a third child process without database credentials while V10 remains REST-isolated', async () => {
  const children = []
  const client = createShadowProcessClient({
    env: {
      SUPABASE_URL: 'https://example.invalid',
      SUPABASE_SERVICE_ROLE_KEY: 'fake',
      SUPABASE_DB_CONNECTION_STRING: 'postgresql://example.invalid/v9',
      V103_SHADOW_ENABLED: 'false',
      V104_SHADOW_ENABLED: 'false',
      V104_ITERATION_SHADOW_ENABLED: 'false',
      V105_SHADOW_V9_ENABLED: 'true',
      V105_SHADOW_V10_ENABLED: 'true',
    },
    forkImpl(_path, _args, options) {
      const scope = options.env.SHADOW_PROCESS_RUNTIME_SCOPE
      const child = fakeChild(scope)
      child.options = options
      children.push(child)
      return child
    },
  })

  await client.prepareRequired()
  await client.prepareV9()
  await client.prepareV10()

  assert.deepEqual(children.map((child) => child.scope), ['required', 'v105-v9', 'v105-v10'])
  assert.equal('SUPABASE_URL' in children[1].options.env, false)
  assert.equal('SUPABASE_SERVICE_ROLE_KEY' in children[1].options.env, false)
  assert.equal('SUPABASE_SECRET_KEY' in children[1].options.env, false)
  assert.equal('SUPABASE_DB_CONNECTION_STRING' in children[1].options.env, false)
  assert.equal('SUPABASE_DB_CONNECTION_STRING' in children[2].options.env, false)
  assert.equal(client.status().v105V9.scope, 'v105-v9')
  assert.equal(client.status().v105V10.scope, 'v105-v10')
  await client.stop()
})

test('V9 child writer requests are allowlisted and executed by the parent writer', async () => {
  const children = []
  const calls = []
  const client = createShadowProcessClient({
    env: { V105_SHADOW_V9_ENABLED: 'true', V105_SHADOW_V10_ENABLED: 'false' },
    v9Writer: {
      async getV105ShadowV9History(options) {
        calls.push(options)
        return [{ table_id: 'BAG01' }]
      },
    },
    forkImpl(_path, _args, options) {
      const child = fakeChild(options.env.SHADOW_PROCESS_RUNTIME_SCOPE)
      children.push(child)
      return child
    },
  })
  await client.prepareV9()
  const child = children[0]
  child.emit('message', { type: 'writer_request', id: 77, method: 'getV105ShadowV9History', args: [{ perTableLimit: 60 }] })
  await delay(10)
  assert.deepEqual(calls, [{ perTableLimit: 60 }])
  assert.deepEqual(child.sent.find((message) => message.type === 'writer_response'), {
    type: 'writer_response', id: 77, ok: true, result: [{ table_id: 'BAG01' }],
  })
  child.emit('message', { type: 'writer_request', id: 78, method: 'deleteEverything', args: [] })
  await delay(10)
  const rejected = child.sent.find((message) => message.type === 'writer_response' && message.id === 78)
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error.code, 'V9_WRITER_METHOD_UNAVAILABLE')
  await client.stop()
})

test('V9 parent writer redacts URI userinfo from IPC errors', async () => {
  const children = []
  const client = createShadowProcessClient({
    env: { V105_SHADOW_V9_ENABLED: 'true', V105_SHADOW_V10_ENABLED: 'false' },
    v9Writer: {
      async getV105ShadowV9History() {
        const syntheticUri = ['postgresql://', 'dbuser', ':', 'dbpass123', '@example.invalid/v9'].join('')
        throw new Error(`connect ${syntheticUri} failed`)
      },
    },
    forkImpl(_path, _args, options) {
      const child = fakeChild(options.env.SHADOW_PROCESS_RUNTIME_SCOPE)
      children.push(child)
      return child
    },
  })
  await client.prepareV9()
  children[0].emit('message', { type: 'writer_request', id: 79, method: 'getV105ShadowV9History', args: [{ perTableLimit: 60 }] })
  await delay(10)
  const response = children[0].sent.find((message) => message.type === 'writer_response' && message.id === 79)
  assert.equal(response.ok, false)
  assert.equal(response.error.message.includes('dbuser'), false)
  assert.equal(response.error.message.includes('dbpass123'), false)
  assert.match(response.error.message, /\[REDACTED\]/)
  await client.stop()
})

test('V9 parent writer validates identities, rejects duplicate IDs, bounds concurrency, and drains writes on stop', async () => {
  const children = []
  const releases = []
  let calls = 0
  const client = createShadowProcessClient({
    env: { V105_SHADOW_V9_ENABLED: 'true', V105_SHADOW_V10_ENABLED: 'false' },
    v9Writer: {
      getV105ShadowV9History() {
        calls += 1
        return new Promise((resolve) => releases.push(resolve))
      },
      issueV105ShadowV9Prediction() { assert.fail('invalid identity must not reach the parent writer') },
    },
    forkImpl(_path, _args, options) {
      const child = fakeChild(options.env.SHADOW_PROCESS_RUNTIME_SCOPE)
      children.push(child)
      return child
    },
  })
  await client.prepareV9()
  const child = children[0]
  const request = (id, args = [{ perTableLimit: 60 }]) => child.emit('message', {
    type: 'writer_request', id, method: 'getV105ShadowV9History', args,
  })
  for (const id of [101, 102, 103, 104]) request(id)
  await delay(10)
  assert.equal(calls, 4)
  request(101)
  request(105)
  await delay(10)
  assert.equal(calls, 4)
  assert.equal(child.sent.find((message) => message.type === 'writer_response' && message.id === 101)?.error?.code, 'V9_WRITER_REQUEST_ID_INVALID')
  assert.equal(child.sent.find((message) => message.type === 'writer_response' && message.id === 105)?.error?.code, 'V9_WRITER_BUSY')
  releases.shift()([])
  await delay(10)
  request(106, [{ perTableLimit: 999 }])
  await delay(10)
  assert.equal(child.sent.find((message) => message.type === 'writer_response' && message.id === 106)?.error?.code, 'V9_WRITER_ARGUMENT_INVALID')
  child.emit('message', {
    type: 'writer_request', id: 107, method: 'issueV105ShadowV9Prediction',
    args: [{ targetTableId: 'BAD01', targetShoe: '1', targetRound: 1, strategyVersion: 'v105-shadow-v9-weighted-v7-v8', predictionTiming: 'pre_result_context', predictedResult: 'BANKER' }],
  })
  await delay(10)
  assert.equal(child.sent.find((message) => message.type === 'writer_response' && message.id === 107)?.error?.code, 'V9_WRITER_IDENTITY_INVALID')
  const stopping = client.stop()
  assert.equal(await Promise.race([stopping.then(() => true), delay(20).then(() => false)]), false)
  for (const release of releases) release([])
  await stopping
  assert.equal(client.status().v105V9.writerPending, 0)
  assert.equal(client.status().v105V9.lastFailure.code, 'V9_WRITER_RESPONSE_DROPPED')
})

test('V9 parent writer never reuses request IDs within one child generation', async () => {
  const children = []
  let calls = 0
  const client = createShadowProcessClient({
    env: { V105_SHADOW_V9_ENABLED: 'true', V105_SHADOW_V10_ENABLED: 'false' },
    v9Writer: { async getV105ShadowV9History() { calls += 1; return [] } },
    forkImpl(_path, _args, options) {
      const child = fakeChild(options.env.SHADOW_PROCESS_RUNTIME_SCOPE)
      children.push(child)
      return child
    },
  })
  await client.prepareV9()
  const child = children[0]
  for (let first = 1; first <= 2000; first += 4) {
    for (let id = first; id < first + 4 && id <= 2000; id += 1) child.emit('message', {
      type: 'writer_request', id, method: 'getV105ShadowV9History', args: [{ perTableLimit: 60 }],
    })
    await delay(0)
  }
  child.emit('message', { type: 'writer_request', id: 2001, method: 'getV105ShadowV9History', args: [{ perTableLimit: 60 }] })
  child.emit('message', { type: 'writer_request', id: 1, method: 'getV105ShadowV9History', args: [{ perTableLimit: 60 }] })
  await delay(10)
  assert.equal(calls, 2000)
  assert.equal(child.sent.find((message) => message.type === 'writer_response' && message.id === 2001)?.error?.code, 'V9_WRITER_REQUEST_LIMIT')
  assert.equal(child.sent.filter((message) => message.type === 'writer_response' && message.id === 1).at(-1)?.error?.code, 'V9_WRITER_REQUEST_ID_INVALID')
  await client.stop()
})

test('required runtime remains enabled by default for compatibility', async () => {
  const children = []
  const client = createShadowProcessClient({
    env: { V105_SHADOW_V9_ENABLED: 'false', V105_SHADOW_V10_ENABLED: 'false' },
    forkImpl(_path, _args, options) {
      const child = fakeChild(options.env.SHADOW_PROCESS_RUNTIME_SCOPE)
      children.push(child)
      return child
    },
  })
  const runtime = client.runtime('v103')
  assert.equal(runtime.enabled, true)
  await runtime.observeTable({ tableId: 'BAG01', shoe: 1, round: 1 })
  assert.equal(children[0].scope, 'required')
  await client.stop()
})

test('real V9 worker hydrates and issues through validated parent writer IPC without child credentials', async () => {
  let historyCalls = 0
  let issued = null
  const client = createShadowProcessClient({
    env: {
      NODE_ENV: 'test',
      V103_SHADOW_ENABLED: 'false', V104_SHADOW_ENABLED: 'false', V104_ITERATION_SHADOW_ENABLED: 'false',
      V105_SHADOW_V9_ENABLED: 'true', V105_SHADOW_V10_ENABLED: 'false',
    },
    requestTimeoutMs: 3000,
    startupTimeoutMs: 3000,
    v9Writer: {
      configured: true,
      async getV105ShadowV9History() { historyCalls += 1; return [] },
      async issueV105ShadowV9Prediction(candidate) {
        issued = structuredClone(candidate)
        return { ...candidate, predictionId: 'v9-ipc-real-1', issuedAt: '2026-08-15T00:00:00.000Z' }
      },
      async readV105ShadowV9Issuance() { return null },
      async settleV105ShadowV9Prediction() { throw new Error('unused') },
      async getV105ShadowV9Counters() { return null },
    },
  })
  try {
    const readiness = await client.prepareV9()
    assert.equal(readiness.enabled, 1)
    assert.equal(readiness.prepared, 1)
    assert.equal(historyCalls, 1)
    await client.runtime('v105-v9', { enabled: true }).observeTable({
      tableId: 'BAG01', shoe: 105, round: 20, bankerCount: 12, playerCount: 8, bigRoadRaw: 'B#P',
    })
    assert.equal(issued.targetTableId, 'BAG01')
    assert.equal(issued.targetRound, 21)
    assert.equal(client.status().v105V9.running, true)
  } finally {
    await client.stop()
  }
})

test('a stalled V9 child is best-effort and cannot delay required capture acknowledgement or V10', async () => {
  const children = []
  const client = createShadowProcessClient({
    env: {
      V103_SHADOW_ENABLED: 'false', V104_SHADOW_ENABLED: 'false', V104_ITERATION_SHADOW_ENABLED: 'false',
      V105_SHADOW_V9_ENABLED: 'true', V105_SHADOW_V10_ENABLED: 'true',
    },
    requestTimeoutMs: 500,
    forkImpl(_path, _args, options) {
      const scope = options.env.SHADOW_PROCESS_RUNTIME_SCOPE
      const child = fakeChild(scope, { stallCapture: scope === 'v105-v9' })
      children.push(child)
      return child
    },
  })

  const result = await Promise.race([
    client.processCapture({ tables: [{ tableId: 'BAG01', shoe: 1, round: 1 }], rounds: [] }),
    delay(80).then(() => { throw new Error('V9 delayed parent capture acknowledgement') }),
  ])
  await delay(20)

  assert.deepEqual(result, { observed: 1, settled: 0, noops: 0 })
  assert.equal(children.some((child) => child.scope === 'v105-v9' && child.sent.some((item) => item.kind === 'capture')), true)
  assert.equal(children.some((child) => child.scope === 'v105-v10' && child.sent.some((item) => item.kind === 'capture')), true)
  assert.equal(client.status().v105V9.lane.active, 1)
  await client.stop()
  assert.equal(client.status().v105V9.lane.interruptedIdentities, 1)
  assert.equal(client.status().v105V9.lane.droppedOnStop, 0)
})

test('V9 child cannot create a local writer or receive a database pool', () => {
  assert.throws(() => createShadowProcessWriter({
    scope: 'v105-v9',
    env: {
      NODE_ENV: 'test',
      SUPABASE_URL: 'https://example.invalid',
      SUPABASE_SERVICE_ROLE_KEY: 'fake',
      SUPABASE_DB_CONNECTION_STRING: 'postgresql://example.invalid/v9',
    },
    createClient() { assert.fail('V9 child must not create a local database writer') },
  }), /parent IPC/)
})

test('V9 resume release is shadow-only, resumes the existing counter, and rolls back by switch only', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../release/v105-shadow-v9-resume-isolated-release-manifest.json', import.meta.url), 'utf8'))
  assert.equal(manifest.releaseVersion, 'v105-shadow-v9-resume-isolated.1')
  assert.equal(manifest.gitTag, manifest.releaseVersion)
  assert.equal(manifest.applicationVersion, '1.0.60')
  assert.equal(manifest.formalStrategyVersion, 'v105')
  assert.equal(manifest.shadowStrategyVersion, 'v105-shadow-v9-weighted-v7-v8')
  assert.equal(manifest.shadowOnly, true)
  assert.equal(manifest.databaseMigrationRequired, false)
  assert.equal(manifest.counterMode, 'resume-existing')
  assert.deepEqual(manifest.runtimeIsolation, {
    childScope: 'v105-v9',
    separateFromRequired: true,
    separateFromV10: true,
    childDatabaseCredentials: false,
    writerTransport: 'parent-ipc',
    writerRequestValidation: 'method-schema-identity-size',
    writerMaxConcurrency: 4,
    writerPayloadMaxBytes: 262144,
    writerResultMaxBytes: 2097152,
    writerRequestIdLimitPerGeneration: 2000,
    writerRequestIdsReusableWithinGeneration: false,
    ipcErrorRedaction: 'both-boundaries-uri-jwt-key',
    writerResponseDropObservable: true,
    shutdownWaitsForParentWrites: true,
    captureLane: 'bounded-best-effort',
    deliveryGuarantee: 'live-best-effort-no-retroactive-replay',
    failureAndDropCountsObservable: true,
    retroactiveReplayAllowed: false,
    maxQueuedCaptures: 2,
    maxQueuedIdentities: 2000,
    canBlockFormalOutboxAck: false,
  })
  assert.equal(manifest.rollback.setV105ShadowV9EnabledFalse, true)
  assert.equal(manifest.rollback.databaseRollbackRequired, false)
})
