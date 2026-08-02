import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createShadowProcessClient } from '../src/shadow-process-client.js'
import { prepareShadowRuntimes } from '../src/shadow-process-work.js'
import { createApp } from '../src/server.js'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function fakeChild({ respond = true, respondTo = null, responseResult = null, exitDelayMs = 0, ignoreKill = false } = {}) {
  const child = new EventEmitter()
  child.connected = true
  child.exitCode = null
  child.signalCode = null
  child.sent = []
  child.send = (message, callback) => {
    child.sent.push(structuredClone(message))
    callback?.(null)
    if (respond && (!respondTo || respondTo(message))) setImmediate(() => child.emit('message', { type: 'response', id: message.id, ok: true, result: typeof responseResult === 'function' ? responseResult(message) : responseResult, snapshots: { [message.runtime]: { status: 'ready' } } }))
  }
  child.kill = (signal) => {
    if (ignoreKill) return false
    if (child.exitCode != null || child.signalCode != null) return false
    child.connected = false
    child.signalCode = signal
    setTimeout(() => child.emit('exit', null, signal), exitDelayMs)
    return true
  }
  return child
}

test('shadow process IPC sends only runtime work and inherits the exact database env allowlist', async () => {
  const children = []
  const client = createShadowProcessClient({
    env: {
      SUPABASE_URL: 'https://example.invalid',
      SUPABASE_SERVICE_ROLE_KEY: 'fake',
      SUPABASE_DB_CONNECTION_STRING: 'postgresql://example.invalid/db',
      SUPABASE_REQUEST_TIMEOUT_MS: '1234',
      DURABLE_INGEST_REQUEST_TIMEOUT_MS: '5678',
      V103_SHADOW_ENABLED: 'false',
      V104_SHADOW_ENABLED: 'false',
      V104_ITERATION_SHADOW_ENABLED: 'false',
      V105_SHADOW_V9_ENABLED: 'true',
      V105_SHADOW_V10_ENABLED: 'false',
      UNRELATED_PRIVATE_SECRET: 'omit',
    },
    forkImpl(_path, _args, options) {
      const child = fakeChild()
      child.options = options
      children.push(child)
      return child
    },
  })
  await client.runtime('v105-v9', { enabled: true }).observeTable({ tableId: 'BAG01', shoe: 1, round: 2 })
  await client.processCapture({ tables: [{ tableId: 'BAG01' }], rounds: [{ tableId: 'BAG01', round: 3 }] })

  assert.equal(children.length, 1)
  assert.equal(children[0].options.env.SUPABASE_SERVICE_ROLE_KEY, 'fake')
  assert.equal(children[0].options.env.SUPABASE_DB_CONNECTION_STRING, 'postgresql://example.invalid/db')
  assert.equal(children[0].options.env.SUPABASE_REQUEST_TIMEOUT_MS, '1234')
  assert.equal(children[0].options.env.DURABLE_INGEST_REQUEST_TIMEOUT_MS, '5678')
  assert.equal(children[0].options.env.V103_SHADOW_ENABLED, 'false')
  assert.equal(children[0].options.env.V105_SHADOW_V9_ENABLED, 'true')
  assert.equal(children[0].options.env.V105_SHADOW_V10_ENABLED, 'false')
  for (const key of ['V105_SHADOW_V6_ENABLED', 'V105_SHADOW_V7_ENABLED', 'V105_SHADOW_V8_ENABLED']) {
    assert.equal(key in children[0].options.env, false)
  }
  assert.equal('UNRELATED_PRIVATE_SECRET' in children[0].options.env, false)
  assert.doesNotMatch(JSON.stringify(children[0].sent), /SUPABASE_SERVICE_ROLE_KEY|UNRELATED_PRIVATE_SECRET/)
  assert.deepEqual(children[0].sent[0].payload, { tableId: 'BAG01', shoe: 1, round: 2 })
  assert.equal(children[0].sent[1].kind, 'capture')
  assert.equal(children[0].sent[1].payload.rounds[0].round, 3)
  await client.stop()
})

test('AbortSignal terminates the entire shadow child and the next durable retry starts a fresh generation', async () => {
  const children = []
  const client = createShadowProcessClient({
    killGraceMs: 5,
    forkImpl() {
      const child = fakeChild({ respond: children.length > 0 })
      children.push(child)
      return child
    },
  })
  const runtime = client.runtime('v105-v9', { enabled: true })
  const controller = new AbortController()
  const first = runtime.settleRound({ tableId: 'BAG01', shoe: 1, round: 2 }, { signal: controller.signal })
  await delay(0)
  controller.abort()
  await assert.rejects(first, /aborted|terminated|exited/i)
  assert.notEqual(children[0].signalCode, null)

  await runtime.settleRound({ tableId: 'BAG01', shoe: 1, round: 2 })
  assert.equal(children.length, 2)
  assert.equal(client.status().generation, 2)
  await client.stop()
})

test('a capture batch timeout kills the child and the next durable retry uses a fresh process', async () => {
  const children = []
  const client = createShadowProcessClient({
    env: { ...process.env, V105_SHADOW_V10_ENABLED: 'false' },
    requestTimeoutMs: 10,
    killGraceMs: 5,
    forkImpl() {
      const child = fakeChild({ respond: children.length > 0 })
      children.push(child)
      return child
    },
  })
  await assert.rejects(client.processCapture({ tables: [], rounds: [{ tableId: 'BAG01', round: 2 }] }), /timeout|terminated|exited/i)
  assert.notEqual(children[0].signalCode, null)
  await client.processCapture({ tables: [], rounds: [{ tableId: 'BAG01', round: 2 }] })
  assert.equal(children.length, 2)
  await client.stop()
})

test('a stalled runtime hydration returns pending readiness without killing the child or advancing generation', async () => {
  const children = []
  const stalledRuntime = {
    enabled: true,
    async start() { await new Promise(() => {}) },
  }
  const runtimes = new Map([['v105-v9', stalledRuntime]])
  const client = createShadowProcessClient({
    startupTimeoutMs: 20,
    killGraceMs: 5,
    forkImpl() {
      const child = fakeChild({ respond: false })
      child.send = (message, callback) => {
        callback?.(null)
        if (message.kind !== 'prepare') return
        Promise.resolve(prepareShadowRuntimes(runtimes)).then((result) => {
          setImmediate(() => child.emit('message', { type: 'response', id: message.id, ok: true, result }))
        })
      }
      children.push(child)
      return child
    },
  })

  assert.deepEqual(await client.prepare(), { enabled: 1, prepared: 0, pending: 1, queued: 0, failed: 0, disabled: 0 })
  assert.deepEqual(await client.prepare(), { enabled: 1, prepared: 0, pending: 1, queued: 0, failed: 0, disabled: 0 })
  assert.equal(children.length, 1)
  assert.equal(children[0].signalCode, null)
  assert.equal(client.status().generation, 1)
  await client.stop()
})

test('a timed-out request is not released and no new generation starts before the old child exit is confirmed', async () => {
  const children = []
  const client = createShadowProcessClient({
    env: { ...process.env, V105_SHADOW_V10_ENABLED: 'false' },
    requestTimeoutMs: 5,
    killGraceMs: 10,
    killConfirmMs: 100,
    forkImpl() {
      const child = fakeChild({ respond: children.length > 0, exitDelayMs: children.length === 0 ? 40 : 0 })
      children.push(child)
      return child
    },
  })
  let firstSettled = false
  const first = client.processCapture({ tables: [], rounds: [{ tableId: 'BAG01', round: 2 }] })
    .finally(() => { firstSettled = true })
  await delay(15)
  assert.equal(firstSettled, false)
  const retry = client.processCapture({ tables: [], rounds: [{ tableId: 'BAG01', round: 2 }] })
  await delay(15)
  assert.equal(children.length, 1)
  await assert.rejects(first, /timeout/i)
  await retry
  assert.equal(children.length, 2)
  await client.stop()
})

test('an unconfirmed child termination fails closed and prevents a replacement generation', async () => {
  const children = []
  const client = createShadowProcessClient({
    requestTimeoutMs: 5,
    killGraceMs: 5,
    killConfirmMs: 20,
    forkImpl() {
      const child = fakeChild({ respond: false, ignoreKill: true })
      children.push(child)
      return child
    },
  })
  await assert.rejects(
    client.processCapture({ tables: [], rounds: [{ tableId: 'BAG01', round: 2 }] }),
    /termination could not be confirmed/i,
  )
  await assert.rejects(
    client.processCapture({ tables: [], rounds: [{ tableId: 'BAG01', round: 2 }] }),
    /termination could not be confirmed/i,
  )
  assert.equal(children.length, 1)
  assert.equal(client.status().running, true)
  assert.equal(client.status().terminationFailed, true)
  assert.equal(client.status().phase, 'fatal')
  assert.equal(client.status().code, 'SHADOW_PROCESS_TERMINATION_UNCONFIRMED')
  await assert.rejects(client.stop(), /termination could not be confirmed/i)
})

test('an unconfirmed isolated child termination enters server fatal mode without releasing or reclaiming the lease', async () => {
  const children = []
  let claims = 0
  let failureAckCalls = 0
  let fatalHandlerCalls = 0
  const processClient = createShadowProcessClient({
    requestTimeoutMs: 5,
    killGraceMs: 5,
    killConfirmMs: 20,
    forkImpl() {
      const child = fakeChild({ respond: true, respondTo: (message) => message.kind === 'prepare', responseResult: { enabled: 0, prepared: 0, pending: 0, queued: 0, failed: 0 }, ignoreKill: true })
      children.push(child)
      return child
    },
  })
  const app = createApp({
    autoConnect: false,
    production: false,
    memberAuthRequired: false,
    requireVerifiedStrategy: false,
    isolateShadowProcess: true,
    shadowProcessClient: processClient,
    fatalHandler({ code, exitCode }) {
      fatalHandlerCalls += 1
      assert.equal(code, 'SHADOW_PROCESS_TERMINATION_UNCONFIRMED')
      assert.equal(exitCode, 70)
    },
    outboxWorkDeadlineMs: 100,
    outboxBackoffMs: 1,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        claims += 1
        return [{ session_id: 'fatal-child', sequence: 1, claim_token: 'lease-fatal', attempts: 1, payload: { work: {
          sessionId: 'fatal-child', status: { connected: true, authenticated: true }, tables: [], rounds: [],
        } } }]
      },
      async completeCaptureOutbox() { assert.fail('unconfirmed child work must not complete') },
      async failCaptureOutbox() { failureAckCalls += 1 },
      async readIssuedPrediction() { return null },
    },
    v100FormalRuntime: { enabled: false },
  })

  assert.deepEqual(await app.drainCaptureOutbox(), { processed: 0, failed: 1 })
  assert.deepEqual(await app.drainCaptureOutbox(), { processed: 0, failed: 0 })
  await delay(20)

  assert.equal(failureAckCalls, 0)
  assert.equal(claims, 1)
  assert.equal(children.length, 1)
  assert.equal(fatalHandlerCalls, 1)
  const status = JSON.parse((await app.inject({ url: '/api/status' })).body)
  assert.deepEqual(status.captureOutboxPhase, {
    phase: 'fatal',
    code: 'SHADOW_PROCESS_TERMINATION_UNCONFIRMED',
    startedAt: status.captureOutboxPhase.startedAt,
  })
  assert.equal(status.shadowProcessStatus.running, true)
  assert.equal(status.shadowProcessStatus.terminationFailed, true)
  assert.doesNotMatch(JSON.stringify(status.captureOutboxPhase), /fatal-child|lease-fatal/i)
  await app.stop()
})

test('real shadow child boots, replies over IPC, and exits without any database write', async () => {
  const client = createShadowProcessClient({
    env: {
      ...process.env,
      V103_SHADOW_ENABLED: 'false',
      V104_SHADOW_ENABLED: 'false',
      V104_ITERATION_SHADOW_ENABLED: 'false',
      V105_SHADOW_V9_ENABLED: 'false',
      V105_SHADOW_V10_ENABLED: 'false',
    },
    requestTimeoutMs: 5000,
  })
  await assert.rejects(
    client.runtime('v105-v9', { enabled: true }).observeTable({ tableId: 'BAG01', shoe: 1, round: 1 }),
    /disabled/i,
  )
  assert.equal(client.status().generation, 1)
  await client.stop()
  assert.equal(client.status().running, false)
})

test('an expired exact lease blocks late Formal completion from starting Shadow or completing the outbox row', async () => {
  const captures = []
  const completed = []
  const failed = []
  let claimed = false
  const processClient = {
    runtime(_key, { enabled }) {
      return { enabled, observeTable() {}, settleRound() {}, snapshot() { return { status: 'ready' } } }
    },
    async processCapture(payload) { captures.push(payload) },
    status() { return { running: false, generation: 0, pending: 0, stopping: false } },
    async stop() {},
  }
  const work = {
    sessionId: 'late-formal',
    status: { connected: true, authenticated: true },
    tables: [{ tableId: 'BAG01', shoe: 1, round: 1 }],
    rounds: [],
  }
  const app = createApp({
    autoConnect: false,
    production: false,
    memberAuthRequired: false,
    requireVerifiedStrategy: false,
    isolateShadowProcess: true,
    shadowProcessClient: processClient,
    outboxWorkDeadlineMs: 10,
    outboxBackoffMs: 1,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        if (claimed) return []
        claimed = true
        return [{ session_id: 'late-formal', sequence: 1, claim_token: 'lease-late', attempts: 1, payload: { work } }]
      },
      async completeCaptureOutbox(identity) { completed.push(identity) },
      async failCaptureOutbox(identity) { failed.push(identity) },
      async readIssuedPrediction() { return null },
    },
    v100FormalRuntime: {
      enabled: true,
      async processSnapshot({ tables }) {
        await delay(40)
        return { tables }
      },
    },
  })
  const result = await app.drainCaptureOutbox()
  await delay(60)

  assert.deepEqual(result, { processed: 0, failed: 1 })
  assert.equal(failed.length, 1)
  assert.equal(captures.length, 0)
  assert.equal(completed.length, 0)
  await app.stop()
})

test('an active child must exit before the exact lease failure is acknowledged', async () => {
  let claimed = false
  let exitAt = 0
  let failAt = 0
  let failureAckCalls = 0
  let fatalHandlerCalls = 0
  const processClient = createShadowProcessClient({
    requestTimeoutMs: 500,
    killGraceMs: 5,
    killConfirmMs: 200,
    forkImpl() {
      const child = fakeChild({ respond: true, respondTo: (message) => message.kind === 'prepare', responseResult: { enabled: 0, prepared: 0, pending: 0, queued: 0, failed: 0 }, exitDelayMs: 30 })
      child.once('exit', () => { exitAt = Date.now() })
      return child
    },
  })
  const work = {
    sessionId: 'active-child-deadline',
    status: { connected: true, authenticated: true },
    tables: [{ tableId: 'BAG01', shoe: 1, round: 1 }],
    rounds: [],
  }
  const app = createApp({
    autoConnect: false,
    production: false,
    memberAuthRequired: false,
    requireVerifiedStrategy: false,
    isolateShadowProcess: true,
    shadowProcessClient: processClient,
    fatalHandler() { fatalHandlerCalls += 1 },
    outboxWorkDeadlineMs: 100,
    outboxBackoffMs: 1,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        if (claimed) return []
        claimed = true
        return [{ session_id: work.sessionId, sequence: 1, claim_token: 'lease-child', attempts: 1, payload: { work } }]
      },
      async completeCaptureOutbox() { assert.fail('expired child work must not complete') },
      async failCaptureOutbox() { failureAckCalls += 1; failAt = Date.now() },
      async readIssuedPrediction() { return null },
    },
    v100FormalRuntime: { enabled: false },
  })
  const result = await app.drainCaptureOutbox()

  assert.deepEqual(result, { processed: 0, failed: 1 })
  assert.notEqual(exitAt, 0)
  assert.equal(failAt >= exitAt, true)
  assert.equal(failureAckCalls, 1)
  assert.equal(fatalHandlerCalls, 0)
  await app.stop()
})

test('child hydration finishes before claim and does not consume the exact outbox lease deadline', async () => {
  let claimed = false
  let preparedAt = 0
  let claimedAt = 0
  const processClient = {
    runtime(_key, { enabled }) {
      return { enabled, observeTable() {}, settleRound() {}, snapshot() { return { status: 'ready' } } }
    },
    async prepare() {
      await delay(30)
      preparedAt = Date.now()
      return { enabled: 7, prepared: 7, pending: 0, queued: 0, failed: 0, disabled: 0 }
    },
    async processCapture() {},
    status() { return { running: true, generation: 1, pending: 0, stopping: false } },
    async stop() {},
  }
  const app = createApp({
    autoConnect: false,
    production: false,
    memberAuthRequired: false,
    requireVerifiedStrategy: false,
    isolateShadowProcess: true,
    shadowProcessClient: processClient,
    outboxWorkDeadlineMs: 10,
    outboxBackoffMs: 1,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        claimedAt = Date.now()
        if (claimed) return []
        claimed = true
        return [{ session_id: 'prepared-first', sequence: 1, claim_token: 'lease-prepared', attempts: 1, payload: { work: {
          sessionId: 'prepared-first', status: { connected: true, authenticated: true }, tables: [], rounds: [],
        } } }]
      },
      async completeCaptureOutbox() {},
      async failCaptureOutbox() { assert.fail('hydration time must not expire the lease') },
      async readIssuedPrediction() { return null },
    },
    v100FormalRuntime: { enabled: false },
  })

  assert.deepEqual(await app.drainCaptureOutbox(), { processed: 1, failed: 0 })
  assert.equal(preparedAt > 0, true)
  assert.equal(claimedAt >= preparedAt, true)
  await app.stop()
})

test('pending or queued shadow hydration does not claim, consume an attempt, or run Formal lease work', async () => {
  let claims = 0
  let formalCalls = 0
  let completed = 0
  const failures = []
  const processClient = {
    runtime(_key, { enabled }) {
      return { enabled, observeTable() {}, settleRound() {}, snapshot() { return { status: 'initializing' } } }
    },
    async prepare() { return { enabled: 5, prepared: 4, pending: 1, queued: 0, failed: 0, disabled: 0 } },
    async processCapture() {
      const error = new Error('shadow runtime batch failed (v105-v10:hydrate:not_ready)')
      error.code = 'SHADOW_RUNTIME_BATCH_FAILED'
      error.diagnostics = [{ runtime: 'v105-v10', stage: 'hydrate', code: 'not_ready' }]
      throw error
    },
    status() {
      return { running: true, generation: 1, pending: 0, stopping: false, terminationFailed: false }
    },
    async stop() {},
  }
  const app = createApp({
    autoConnect: false,
    production: false,
    memberAuthRequired: false,
    requireVerifiedStrategy: false,
    isolateShadowProcess: true,
    shadowProcessClient: processClient,
    outboxWorkDeadlineMs: 100,
    outboxBackoffMs: 1000,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        claims += 1
        return []
      },
      async completeCaptureOutbox() { completed += 1 },
      async failCaptureOutbox(identity) { failures.push(identity); return { failed: true, retry_after_ms: 1000 } },
      async readIssuedPrediction() { return null },
    },
    v100FormalRuntime: {
      enabled: true,
      async processSnapshot({ tables }) { formalCalls += 1; return { tables } },
    },
  })

  assert.deepEqual(await app.drainCaptureOutbox(), { processed: 0, failed: 0 })
  assert.equal(claims, 0)
  assert.equal(formalCalls, 0)
  assert.equal(completed, 0)
  assert.equal(failures.length, 0)
  await app.stop()
})

test('shutdown kills an isolated child before waiting on its unsettled capture work', async () => {
  let claimed = false
  let captureStarted
  const started = new Promise((resolve) => { captureStarted = resolve })
  let stopCalls = 0
  let rejectCapture
  const processClient = {
    runtime(_key, { enabled }) {
      return { enabled, observeTable() {}, settleRound() {}, snapshot() { return { status: 'ready' } } }
    },
    async prepare() { return { enabled: 7, prepared: 7, pending: 0, queued: 0, failed: 0, disabled: 0 } },
    async processCapture() {
      captureStarted()
      await new Promise((_, reject) => { rejectCapture = reject })
    },
    status() {
      return { running: true, generation: 1, pending: 1, stopping: stopCalls > 0, terminationFailed: false }
    },
    async stop() {
      stopCalls += 1
      rejectCapture?.(new Error('shadow process client stopped'))
    },
  }
  const app = createApp({
    autoConnect: false,
    production: false,
    memberAuthRequired: false,
    requireVerifiedStrategy: false,
    isolateShadowProcess: true,
    shadowProcessClient: processClient,
    outboxWorkDeadlineMs: 1000,
    shadowShutdownDeadlineMs: 50,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        if (claimed) return []
        claimed = true
        return [{ session_id: 'shutdown-pending', sequence: 1, claim_token: 'lease-shutdown', attempts: 1, payload: { work: {
          sessionId: 'shutdown-pending', status: { connected: true, authenticated: true }, tables: [], rounds: [],
        } } }]
      },
      async completeCaptureOutbox() { assert.fail('unsettled capture must not complete') },
      async failCaptureOutbox() { return { failed: true, retry_after_ms: 1000 } },
      async readIssuedPrediction() { return null },
    },
    v100FormalRuntime: { enabled: false },
  })

  const drain = app.drainCaptureOutbox()
  await started
  const stopped = await Promise.race([
    app.stop().then(() => true),
    delay(100).then(() => false),
  ])

  assert.equal(stopped, true)
  assert.equal(stopCalls, 1)
  assert.deepEqual(await drain, { processed: 0, failed: 1 })
})

test('prepare failure is observable with a bounded code and never claims an outbox lease', async () => {
  let prepareFailed = false
  let claims = 0
  const processClient = {
    runtime(_key, { enabled }) {
      return { enabled, observeTable() {}, settleRound() {}, snapshot() { return { status: 'initializing' } } }
    },
    async prepare() {
      prepareFailed = true
      throw new Error('shadow runtime batch failed')
    },
    async processCapture() { assert.fail('capture must not run after prepare failure') },
    status() {
      return prepareFailed
        ? { running: true, generation: 1, pending: 0, stopping: false, lastFailure: { kind: 'prepare', code: 'SHADOW_RUNTIME_BATCH_FAILED', diagnostics: [{ runtime: 'v105-v9', stage: 'hydrate', code: 'db_request' }] } }
        : { running: true, generation: 1, pending: 0, stopping: false, lastFailure: null }
    },
    async stop() {},
  }
  const app = createApp({
    autoConnect: false,
    production: false,
    memberAuthRequired: false,
    requireVerifiedStrategy: false,
    isolateShadowProcess: true,
    shadowProcessClient: processClient,
    outboxBackoffMs: 1000,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() { claims += 1; return [] },
      async readIssuedPrediction() { return null },
    },
    v100FormalRuntime: { enabled: false },
  })

  await assert.rejects(app.drainCaptureOutbox(), /shadow runtime batch failed/)
  assert.equal(claims, 0)
  const status = JSON.parse((await app.inject({ url: '/api/status' })).body)
  assert.equal(status.shadowProcessStatus.lastFailure.code, 'SHADOW_RUNTIME_BATCH_FAILED')
  assert.deepEqual(status.shadowProcessStatus.lastFailure.diagnostics, [{ runtime: 'v105-v9', stage: 'hydrate', code: 'db_request' }])
  await app.stop()
})

test('missing or malformed shadow readiness never claims an outbox lease', async () => {
  for (const readiness of [null, {}, { enabled: 3, prepared: 4, pending: 0, queued: 0, failed: 0 }]) {
    let claims = 0
    const processClient = {
      runtime(_key, { enabled }) {
        return { enabled, observeTable() {}, settleRound() {}, snapshot() { return { status: 'initializing' } } }
      },
      async prepare() { return readiness },
      status() { return { running: true, generation: 1, pending: 0, stopping: false } },
      async stop() {},
    }
    const app = createApp({
      autoConnect: false,
      production: false,
      memberAuthRequired: false,
      requireVerifiedStrategy: false,
      isolateShadowProcess: true,
      shadowProcessClient: processClient,
      outboxBackoffMs: 1000,
      supabaseClient: {
        configured: true,
        async claimCaptureOutbox() { claims += 1; return [] },
        async readIssuedPrediction() { return null },
      },
      v100FormalRuntime: { enabled: false },
    })

    assert.deepEqual(await app.drainCaptureOutbox(), { processed: 0, failed: 0 })
    assert.equal(claims, 0)
    await app.stop()
  }
})

test('structured prepare failure is observable and never claims or failure-ACKs an outbox lease', async () => {
  let claims = 0
  let failureAcks = 0
  const readiness = { enabled: 3, prepared: 2, pending: 0, queued: 0, failed: 1, disabled: 4 }
  const processClient = {
    runtime(_key, { enabled }) {
      return { enabled, observeTable() {}, settleRound() {}, snapshot() { return { status: 'initializing' } } }
    },
    async prepare() { return readiness },
    status() { return { running: true, generation: 1, pending: 0, stopping: false } },
    async stop() {},
  }
  const app = createApp({
    autoConnect: false,
    production: false,
    memberAuthRequired: false,
    requireVerifiedStrategy: false,
    isolateShadowProcess: true,
    shadowProcessClient: processClient,
    outboxBackoffMs: 1000,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() { claims += 1; return [] },
      async failCaptureOutbox() { failureAcks += 1 },
      async readIssuedPrediction() { return null },
    },
    v100FormalRuntime: { enabled: false },
  })

  assert.deepEqual(await app.drainCaptureOutbox(), { processed: 0, failed: 0 })
  assert.equal(claims, 0)
  assert.equal(failureAcks, 0)
  const status = JSON.parse((await app.inject({ url: '/api/status' })).body)
  assert.deepEqual(status.shadowProcessReadiness, readiness)
  await app.stop()
})

test('Formal raw ingest and status stay responsive while child hydration remains queued', async () => {
  let persisted = 0
  let claims = 0
  const processClient = {
    runtime(_key, { enabled }) {
      return { enabled, observeTable() {}, settleRound() {}, snapshot() { return { status: 'initializing' } } }
    },
    async prepare() { return { enabled: 3, prepared: 0, pending: 1, queued: 2, failed: 0, disabled: 4 } },
    status() { return { running: true, generation: 1, pending: 0, stopping: false } },
    async stop() {},
  }
  const app = createApp({
    autoConnect: false,
    production: false,
    memberAuthRequired: false,
    requireVerifiedStrategy: false,
    isolateShadowProcess: true,
    shadowProcessClient: processClient,
    ingestKey: 'worker-key',
    now: () => 1_000_000,
    outboxBackoffMs: 1000,
    supabaseClient: {
      configured: true,
      async writeCloudTableSnapshot() {},
      async persistCaptureEnvelope({ roundKeys }) {
        persisted += 1
        return { duplicate: false, acceptedRoundKeys: roundKeys }
      },
      async claimCaptureOutbox() { claims += 1; return [] },
      async readIssuedPrediction() { return null },
    },
    v100FormalRuntime: { enabled: false },
  })
  const envelope = {
    protocolVersion: 'v105', timestamp: 1_000_000, sequence: 1, roundKeys: [],
    snapshot: {
      buildVersion: '105', sessionId: 'hydrate-live', connected: true, authenticated: true,
      tables: [{ tableId: 'BAG01', shoe: 88, round: 20 }], rounds: [],
    },
  }

  const ingest = await Promise.race([
    app.inject({ method: 'POST', url: '/api/cloud-ingest/snapshot', headers: { 'x-worker-key': 'worker-key' }, body: JSON.stringify(envelope) }),
    delay(100).then(() => ({ statusCode: 599 })),
  ])
  const status = await Promise.race([
    app.inject({ url: '/api/status' }),
    delay(100).then(() => ({ statusCode: 599 })),
  ])
  await delay(0)

  assert.equal(ingest.statusCode, 200)
  assert.equal(status.statusCode, 200)
  assert.equal(persisted, 1)
  assert.equal(claims, 0)
  assert.equal(JSON.parse(status.body).connected, true)
  await app.stop()
})

test('remote child failures expose only bounded structured diagnostics', async () => {
  const client = createShadowProcessClient({
    forkImpl() {
      const child = fakeChild({ respond: false })
      child.send = (message, callback) => {
        callback?.(null)
        setImmediate(() => child.emit('message', {
          type: 'response', id: message.id, ok: false,
          error: {
            message: 'password=hunter2 Bearer top-secret',
            code: 'SHADOW_RUNTIME_BATCH_FAILED',
            diagnostics: [{ runtime: 'v105-v9', stage: 'settleRound', code: 'db_request', raw: 'must-not-leak' }],
          },
        }))
      }
      return child
    },
  })

  await assert.rejects(client.processCapture({ tables: [], rounds: [] }), /REDACTED/)
  const status = client.status()
  assert.deepEqual(status.lastFailure.diagnostics, [{ runtime: 'v105-v9', stage: 'settleRound', code: 'db_request' }])
  assert.doesNotMatch(JSON.stringify(status), /hunter2|top-secret|must-not-leak/i)
  await client.stop()
})

test('server isolated mode sends one complete durable outbox payload to the child and stops it', async () => {
  const captures = []
  const completed = []
  let stopped = 0
  let claimed = false
  const processClient = {
    runtime(_key, { enabled }) {
      return {
        enabled,
        async observeTable() { assert.fail('isolated mode must not send per-table IPC') },
        async settleRound() { assert.fail('isolated mode must not send per-Final IPC') },
        snapshot() { return { status: 'ready' } },
      }
    },
    async processCapture(payload) { captures.push(structuredClone(payload)) },
    status() { return { running: true, generation: 1, pending: 0, stopping: false } },
    async stop() { stopped += 1 },
  }
  const work = {
    sessionId: 'isolated-outbox',
    status: { connected: true, authenticated: true },
    tables: [{ tableId: 'BAG01', shoe: 1, round: 1 }],
    rounds: [{
      tableId: 'BAG01', shoe: 1, round: 2, winner: 'banker',
      sourceAction: '/api/v1/gametype/*/game/*/room/*/table/*/summary',
      rawResult: [1, 9, 2, 10, -1, -1, -1, -1, 1, 9],
    }],
  }
  const app = createApp({
    autoConnect: false,
    production: false,
    memberAuthRequired: false,
    requireVerifiedStrategy: false,
    isolateShadowProcess: true,
    shadowProcessClient: processClient,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        if (claimed) return []
        claimed = true
        return [{ session_id: 'isolated-outbox', sequence: 1, claim_token: 'lease-1', attempts: 1, payload: { work } }]
      },
      async completeCaptureOutbox(identity) { completed.push(identity) },
      async failCaptureOutbox() { assert.fail('valid isolated child work must not fail') },
      async readIssuedPrediction() { return null },
    },
    v100FormalRuntime: {
      enabled: true,
      async processSnapshot({ tables }) {
        return {
          tables: tables.map((table) => ({
            ...table,
            v102RankLedger: { completeThrough: 0, targetRound: 1, rankDataAvailable: true },
          })),
        }
      },
    },
  })
  const result = await app.drainCaptureOutbox()

  assert.deepEqual(result, { processed: 1, failed: 0 })
  assert.equal(captures.length, 1)
  assert.equal(captures[0].tables[0].tableId, work.tables[0].tableId)
  assert.deepEqual(captures[0].rounds, work.rounds)
  assert.deepEqual(captures[0].tables[0].v102RankLedger, { completeThrough: 0, targetRound: 1, rankDataAvailable: true })
  assert.deepEqual(completed, [{ sessionId: 'isolated-outbox', sequence: 1, claimToken: 'lease-1', attempt: 1 }])
  const status = JSON.parse((await app.inject({ url: '/api/status' })).body)
  assert.equal(status.shadowProcessMode, 'isolated_child_process')
  await app.stop()
  assert.equal(stopped, 1)
})
