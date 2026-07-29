import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createShadowProcessClient } from '../src/shadow-process-client.js'
import { createApp } from '../src/server.js'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function fakeChild({ respond = true, exitDelayMs = 0, ignoreKill = false } = {}) {
  const child = new EventEmitter()
  child.connected = true
  child.exitCode = null
  child.signalCode = null
  child.sent = []
  child.send = (message, callback) => {
    child.sent.push(structuredClone(message))
    callback?.(null)
    if (respond) setImmediate(() => child.emit('message', { type: 'response', id: message.id, ok: true, result: null, snapshots: { [message.runtime]: { status: 'ready' } } }))
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

test('shadow process IPC sends only runtime work and inherits secrets through child env', async () => {
  const children = []
  const client = createShadowProcessClient({
    env: { SUPABASE_SERVICE_ROLE_KEY: 'fake', UNRELATED_PRIVATE_SECRET: 'omit' },
    forkImpl(_path, _args, options) {
      const child = fakeChild()
      child.options = options
      children.push(child)
      return child
    },
  })
  await client.runtime('v105', { enabled: true }).observeTable({ tableId: 'BAG01', shoe: 1, round: 2 })
  await client.processCapture({ tables: [{ tableId: 'BAG01' }], rounds: [{ tableId: 'BAG01', round: 3 }] })

  assert.equal(children.length, 1)
  assert.equal(children[0].options.env.SUPABASE_SERVICE_ROLE_KEY, 'fake')
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
  const runtime = client.runtime('v105', { enabled: true })
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

test('a timed-out request is not released and no new generation starts before the old child exit is confirmed', async () => {
  const children = []
  const client = createShadowProcessClient({
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
  assert.equal(client.status().terminationFailed, true)
  await assert.rejects(client.stop(), /termination could not be confirmed/i)
})

test('real shadow child boots, replies over IPC, and exits without any database write', async () => {
  const client = createShadowProcessClient({
    env: {
      ...process.env,
      V103_SHADOW_ENABLED: 'false',
      V104_SHADOW_ENABLED: 'false',
      V104_ITERATION_SHADOW_ENABLED: 'false',
      V105_SHADOW_V6_ENABLED: 'false',
      V105_SHADOW_V7_ENABLED: 'false',
      V105_SHADOW_V8_ENABLED: 'false',
      V105_SHADOW_V9_ENABLED: 'false',
    },
    requestTimeoutMs: 5000,
  })
  await assert.rejects(
    client.runtime('v105', { enabled: true }).observeTable({ tableId: 'BAG01', shoe: 1, round: 1 }),
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
  const processClient = createShadowProcessClient({
    requestTimeoutMs: 100,
    killGraceMs: 5,
    killConfirmMs: 100,
    forkImpl() {
      const child = fakeChild({ respond: false, exitDelayMs: 30 })
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
    outboxWorkDeadlineMs: 10,
    outboxBackoffMs: 1,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        if (claimed) return []
        claimed = true
        return [{ session_id: work.sessionId, sequence: 1, claim_token: 'lease-child', attempts: 1, payload: { work } }]
      },
      async completeCaptureOutbox() { assert.fail('expired child work must not complete') },
      async failCaptureOutbox() { failAt = Date.now() },
      async readIssuedPrediction() { return null },
    },
    v100FormalRuntime: { enabled: false },
  })
  const result = await app.drainCaptureOutbox()

  assert.deepEqual(result, { processed: 0, failed: 1 })
  assert.notEqual(exitAt, 0)
  assert.equal(failAt >= exitAt, true)
  await app.stop()
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
