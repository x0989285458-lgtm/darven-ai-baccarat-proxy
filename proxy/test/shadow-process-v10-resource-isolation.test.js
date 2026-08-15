import test from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { createShadowProcessClient } from '../src/shadow-process-client.js'
import { createApp } from '../src/server.js'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, message, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(5)
  }
  assert.fail(message)
}

let nextPid = 41000

function fakeChild(scope, onSend = null) {
  const child = new EventEmitter()
  child.pid = nextPid++
  child.scope = scope
  child.connected = true
  child.exitCode = null
  child.signalCode = null
  child.sent = []
  child.respond = (message, response = {}) => {
    setImmediate(() => child.emit('message', {
      type: 'response',
      id: message.id,
      ok: response.ok !== false,
      result: response.result ?? null,
      error: response.error,
      snapshots: response.snapshots ?? {},
    }))
  }
  child.send = (message, callback) => {
    child.sent.push(structuredClone(message))
    callback?.(null)
    if (onSend) return onSend(child, message)
    child.respond(message, {
      result: message.kind === 'prepare'
        ? { enabled: 1, prepared: 1, pending: 0, queued: 0, failed: 0, disabled: 0 }
        : { observed: 1, settled: 0, noops: 0 },
    })
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

function scopedFork(children, handlers = {}) {
  return (_path, _args, options) => {
    const scope = options.env.SHADOW_PROCESS_RUNTIME_SCOPE
    const child = fakeChild(scope, handlers[scope])
    child.options = options
    children.push(child)
    return child
  }
}

function enabledEnv(extra = {}) {
  return {
    V103_SHADOW_ENABLED: 'false',
    V104_SHADOW_ENABLED: 'false',
    V104_ITERATION_SHADOW_ENABLED: 'false',
    V105_SHADOW_V6_ENABLED: 'false',
    V105_SHADOW_V7_ENABLED: 'false',
    V105_SHADOW_V8_ENABLED: 'false',
    V105_SHADOW_V9_ENABLED: 'true',
    V105_SHADOW_V10_ENABLED: 'true',
    ...extra,
  }
}

test('required and V10 lanes fork distinct PIDs with fail-closed scopes and V10 false never spawns its child', async () => {
  const children = []
  const client = createShadowProcessClient({
    env: enabledEnv({
      SUPABASE_DB_CONNECTION_STRING: 'postgresql://example.invalid/db',
      DATABASE_URL: 'postgresql://database-url.invalid/db',
      PGHOST: 'direct-db.invalid',
      UNRELATED_PRIVATE_SECRET: 'omit',
    }),
    forkImpl: scopedFork(children),
  })

  await client.prepareRequired()
  await client.prepareV10()

  assert.equal(children.length, 2)
  assert.notEqual(children[0].pid, children[1].pid)
  assert.deepEqual(children.map((child) => child.scope), ['required', 'v105-v10'])
  assert.deepEqual(children.map((child) => child.options.env.SHADOW_PROCESS_RUNTIME_SCOPE), ['required', 'v105-v10'])
  assert.equal(children[0].options.env.SUPABASE_DB_CONNECTION_STRING, 'postgresql://example.invalid/db')
  for (const key of ['SUPABASE_DB_CONNECTION_STRING', 'DATABASE_URL', 'PGHOST']) {
    assert.equal(key in children[1].options.env, false, `V10 child inherited Direct DB env ${key}`)
  }
  assert.equal(children.every((child) => !('UNRELATED_PRIVATE_SECRET' in child.options.env)), true)
  const status = client.status()
  assert.equal(status.required.pid, children[0].pid)
  assert.equal(status.v105V10.pid, children[1].pid)
  assert.doesNotMatch(JSON.stringify(status), /postgresql|secret/i)
  await client.stop()

  const disabledChildren = []
  const disabled = createShadowProcessClient({
    env: enabledEnv({ V105_SHADOW_V10_ENABLED: 'false' }),
    forkImpl: scopedFork(disabledChildren),
  })
  await disabled.prepareRequired()
  assert.deepEqual(await disabled.prepareV10(), {
    enabled: 0, prepared: 0, pending: 0, queued: 0, failed: 0, disabled: 1,
  })
  assert.deepEqual(disabledChildren.map((child) => child.scope), ['required'])
  assert.equal(disabled.status().v105V10.enabled, false)
  await disabled.stop()
})

test('real required and V10 workers stay process-isolated and V10 fails closed without database access', async (t) => {
  const client = createShadowProcessClient({
    env: enabledEnv({
      V105_SHADOW_V9_ENABLED: 'false',
      SUPABASE_URL: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
      SUPABASE_SECRET_KEY: '',
      SUPABASE_DB_CONNECTION_STRING: '',
    }),
    requestTimeoutMs: 5000,
    startupTimeoutMs: 5000,
  })
  t.after(() => client.stop().catch(() => {}))

  await client.prepareRequired()
  await assert.rejects(client.prepareV10(), /shadow runtime batch failed/)
  const status = client.status()
  assert.equal(status.required.scope, 'required')
  assert.equal(status.v105V10.scope, 'v105-v10')
  assert.equal(Number.isSafeInteger(status.required.pid), true)
  assert.equal(Number.isSafeInteger(status.v105V10.pid), true)
  assert.notEqual(status.required.pid, status.v105V10.pid)
  assert.equal(status.required.running, true)
  assert.equal(status.v105V10.running, true)
})

test('worker rejects an unknown runtime scope before creating a usable process', async () => {
  const workerPath = fileURLToPath(new URL('../src/shadow-process-worker.js', import.meta.url))
  const child = fork(workerPath, [], {
    env: { SHADOW_PROCESS_CHILD: '1', SHADOW_PROCESS_RUNTIME_SCOPE: 'invalid' },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  let timedOut = false
  const [code] = await Promise.race([
    once(child, 'exit'),
    delay(2000).then(() => {
      timedOut = true
      child.kill('SIGTERM')
      return [null]
    }),
  ])
  assert.equal(timedOut, false)
  assert.notEqual(code, 0)
})

test('V10 stall keeps one IPC active, queues two, coalesces the fourth immediately, then preserves issuance 21-24 and Final24', async () => {
  const children = []
  let stalledMessage = null
  const issued = []
  const settled = []
  const client = createShadowProcessClient({
    env: enabledEnv(),
    requestTimeoutMs: 5000,
    forkImpl: scopedFork(children, {
      required(child, message) {
        child.respond(message, {
          result: message.kind === 'prepare'
            ? { enabled: 1, prepared: 1, pending: 0, queued: 0, failed: 0, disabled: 6 }
            : { observed: 1, settled: 0, noops: 0 },
        })
      },
      'v105-v10'(child, message) {
        if (message.kind === 'prepare') {
          child.respond(message, { result: { enabled: 1, prepared: 1, pending: 0, queued: 0, failed: 0, disabled: 0 } })
          return
        }
        for (const table of message.payload.tables ?? []) issued.push(Number(table.round) + 1)
        for (const round of message.payload.rounds ?? []) settled.push(Number(round.round))
        if (!stalledMessage) {
          stalledMessage = { child, message }
          return
        }
        child.respond(message, { result: { observed: message.payload.tables?.length ?? 0, settled: message.payload.rounds?.length ?? 0, noops: 0 } })
      },
    }),
  })
  await client.prepareRequired()
  await client.prepareV10()

  const results = []
  for (const visibleRound of [20, 21, 22, 23]) {
    results.push(await client.processCapture({
      tables: [{ source: 'ofalive99', tableId: 'BAG01', shoe: 105, round: visibleRound }],
      rounds: visibleRound === 23
        ? [{ source: 'ofalive99', tableId: 'BAG01', shoe: 105, round: 24 }]
        : [],
    }))
  }

  const beforeRelease = client.status().v105V10
  assert.equal(beforeRelease.lane.active, 1)
  assert.equal(beforeRelease.lane.queued, 2)
  assert.equal(beforeRelease.pending, 1)
  assert.equal(beforeRelease.lane.coalesced, 1)
  assert.equal(beforeRelease.lane.rejected, 0)
  assert.equal(results[3].bestEffortCoalesced, 1)
  assert.deepEqual(issued, [21])

  stalledMessage.child.respond(stalledMessage.message, { result: { observed: 1, settled: 0, noops: 0 } })
  await waitFor(() => client.status().v105V10.lane.active === 0 && client.status().v105V10.lane.queued === 0, 'V10 lane did not drain')
  assert.deepEqual(issued, [21, 22, 23, 24])
  assert.deepEqual(settled, [24])
  assert.equal(client.status().v105V10.lane.failed, 0)
  await client.stop()
})

test('V10 capture stays queued until V10 preparation is fully ready', async () => {
  const children = []
  let prepareRequest = null
  let captureRequest = null
  const client = createShadowProcessClient({
    env: enabledEnv(),
    requestTimeoutMs: 5000,
    forkImpl: scopedFork(children, {
      required(child, message) {
        child.respond(message, { result: { observed: 1, settled: 0, noops: 0 } })
      },
      'v105-v10'(child, message) {
        if (message.kind === 'prepare') {
          prepareRequest = { child, message }
          return
        }
        captureRequest = { child, message }
        child.respond(message, { result: { observed: 1, settled: 0, noops: 0 } })
      },
    }),
  })

  await client.processCapture({
    tables: [{ source: 'ofalive99', tableId: 'BAG01', shoe: 105, round: 20 }],
    rounds: [],
  })
  await waitFor(() => prepareRequest !== null, 'V10 preparation was not started')
  assert.equal(captureRequest, null)
  assert.equal(client.status().v105V10.lane.active, 1)

  prepareRequest.child.respond(prepareRequest.message, {
    result: { enabled: 1, prepared: 1, pending: 0, queued: 0, failed: 0, disabled: 0 },
  })
  await waitFor(() => captureRequest !== null, 'V10 capture did not start after preparation')
  await waitFor(() => client.status().v105V10.lane.completed === 1, 'V10 capture did not complete')
  assert.equal(client.status().v105V10.lane.failed, 0)
  await client.stop()
})

test('V10 lane enforces a 2000-identity ceiling without growing IPC pending', async () => {
  const children = []
  const client = createShadowProcessClient({
    env: enabledEnv(),
    requestTimeoutMs: 5000,
    forkImpl: scopedFork(children, {
      required(child, message) { child.respond(message, { result: { observed: 1, settled: 0, noops: 0 } }) },
      'v105-v10'(_child, _message) {},
    }),
  })
  await client.processCapture({ tables: [{ tableId: 'ACTIVE', shoe: 1, round: 1 }], rounds: [] })
  await client.processCapture({ tables: [{ tableId: 'QUEUE-1', shoe: 1, round: 1 }], rounds: [] })
  await client.processCapture({
    tables: Array.from({ length: 1998 }, (_, index) => ({ tableId: `T${index}`, shoe: 1, round: 1 })),
    rounds: [],
  })
  const result = await client.processCapture({ tables: [{ tableId: 'OVERFLOW', shoe: 1, round: 1 }], rounds: [] })

  const v10 = client.status().v105V10
  assert.equal(v10.pending, 1)
  assert.equal(v10.lane.queued, 2)
  assert.equal(v10.lane.rejected, 1)
  assert.equal(result.bestEffortRejected, 1)
  await client.stop()
})

test('V10 timeout, crash, and DB saturation never change required capture success or required generation', async (t) => {
  for (const scenario of ['timeout', 'crash', 'db_request']) {
    await t.test(scenario, async () => {
      const children = []
      const client = createShadowProcessClient({
        env: enabledEnv(),
        requestTimeoutMs: 15,
        startupTimeoutMs: 15,
        killGraceMs: 2,
        killConfirmMs: 100,
        forkImpl: scopedFork(children, {
          required(child, message) { child.respond(message, { result: { observed: 1, settled: 0, noops: 0 } }) },
          'v105-v10'(child, message) {
            if (scenario === 'timeout') return
            if (scenario === 'crash') {
              child.connected = false
              child.exitCode = 1
              setImmediate(() => child.emit('exit', 1, null))
              return
            }
            child.respond(message, {
              ok: false,
              error: {
                message: 'database request failed',
                code: 'SHADOW_RUNTIME_BATCH_FAILED',
                diagnostics: [{ runtime: 'v105-v10', stage: 'observeTable', code: 'db_request' }],
              },
            })
          },
        }),
      })

      const result = await client.processCapture({ tables: [{ tableId: 'BAG01', shoe: 1, round: 20 }], rounds: [] })
      assert.equal(result.observed, 1)
      assert.equal(client.status().required.generation, 1)
      await waitFor(() => client.status().v105V10.lane.failed === 1, `${scenario} was not observed`)
      assert.equal(client.status().v105V10.lane.interruptedIdentities, 1)
      assert.equal(client.status().required.lastSuccess.kind, 'capture')
      assert.equal(client.status().required.terminationFailed, false)
      assert.equal(client.status().required.generation, 1)
      if (scenario !== 'db_request') {
        await client.processCapture({ tables: [{ tableId: 'BAG01', shoe: 1, round: 21 }], rounds: [] })
        await waitFor(() => client.status().v105V10.generation === 2, `${scenario} did not restart V10 independently`)
        assert.equal(client.status().required.generation, 1)
      }
      await client.stop()
    })
  }
})

test('V10 startup hydration timeout cannot block required V9 capture or restart its child', async () => {
  const children = []
  const client = createShadowProcessClient({
    env: enabledEnv(),
    requestTimeoutMs: 100,
    startupTimeoutMs: 15,
    killGraceMs: 2,
    killConfirmMs: 100,
    forkImpl: scopedFork(children, {
      required(child, message) {
        child.respond(message, {
          result: message.kind === 'prepare'
            ? { enabled: 1, prepared: 1, pending: 0, queued: 0, failed: 0, disabled: 6 }
            : { observed: 1, settled: 0, noops: 0 },
        })
      },
      'v105-v10'(_child, _message) {},
    }),
  })

  await client.prepareRequired()
  const v10Preparation = client.prepareV10()
  const result = await client.processCapture({ tables: [{ tableId: 'BAG01', shoe: 1, round: 20 }], rounds: [] })
  assert.equal(result.observed, 1)
  await assert.rejects(v10Preparation, /timeout/)
  assert.equal(client.status().required.lastSuccess.kind, 'capture')
  assert.equal(client.status().required.generation, 1)
  assert.equal(client.status().required.terminationFailed, false)
  await client.stop()
})

test('Outbox completion waits for required capture but never waits for a stalled V10 child', async (t) => {
  const children = []
  let releaseRequired
  const requiredGate = new Promise((resolve) => { releaseRequired = resolve })
  let claimed = false
  let completed = 0
  let failed = 0
  const client = createShadowProcessClient({
    env: enabledEnv(),
    requestTimeoutMs: 100,
    forkImpl: scopedFork(children, {
      required(child, message) {
        if (message.kind === 'prepare') {
          child.respond(message, { result: { enabled: 1, prepared: 1, pending: 0, queued: 0, failed: 0, disabled: 6 } })
          return
        }
        void requiredGate.then(() => child.respond(message, { result: { observed: 1, settled: 0, noops: 0 } }))
      },
      'v105-v10'(child, message) {
        if (message.kind === 'prepare') child.respond(message, { result: { enabled: 1, prepared: 1, pending: 0, queued: 0, failed: 0, disabled: 0 } })
      },
    }),
  })
  const work = {
    sessionId: 'v10-isolated-ack',
    status: { connected: true, authenticated: true },
    tables: [{ tableId: 'BAG01', shoe: 1, round: 20 }],
    rounds: [],
  }
  const app = createApp({
    autoConnect: false,
    production: false,
    memberAuthRequired: false,
    requireVerifiedStrategy: false,
    isolateShadowProcess: true,
    shadowProcessClient: client,
    outboxWorkDeadlineMs: 1000,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        if (claimed) return []
        claimed = true
        return [{ session_id: work.sessionId, sequence: 1, claim_token: 'lease-v10', attempts: 1, payload: { work } }]
      },
      async completeCaptureOutbox() { completed += 1 },
      async failCaptureOutbox() { failed += 1 },
      async readIssuedPrediction() { return null },
    },
    v100FormalRuntime: { enabled: false },
  })
  t.after(() => app.stop())

  const drain = app.drainCaptureOutbox()
  await delay(20)
  assert.equal(completed, 0)
  releaseRequired()
  assert.deepEqual(await drain, { processed: 1, failed: 0 })
  assert.equal(completed, 1)
  assert.equal(failed, 0)
  assert.equal(client.status().v105V10.lane.active, 1)
  await waitFor(() => client.status().v105V10.lane.failed === 1, 'V10 timeout was not observed', 300)
  assert.equal(completed, 1)
  assert.equal(failed, 0)
  const status = JSON.parse((await app.inject({ url: '/api/status' })).body)
  assert.equal(status.shadowProcessStatus.required.lastFailure, null)
  assert.equal(status.shadowProcessStatus.required.generation, 1)
  assert.equal(status.shadowProcessStatus.required.terminationFailed, false)
  assert.equal(status.shadowProcessStatus.v105V10.lane.failed, 1)
})

test('V10 REST saturation cannot prevent required V9 capture or parent Outbox acknowledgement', async (t) => {
  const children = []
  let claimed = false
  let completed = 0
  let failed = 0
  const client = createShadowProcessClient({
    env: enabledEnv(),
    requestTimeoutMs: 100,
    forkImpl: scopedFork(children, {
      required(child, message) {
        child.respond(message, {
          result: message.kind === 'prepare'
            ? { enabled: 1, prepared: 1, pending: 0, queued: 0, failed: 0, disabled: 6 }
            : { observed: 1, settled: 0, noops: 0 },
        })
      },
      'v105-v10'(child, message) {
        if (message.kind === 'prepare') {
          child.respond(message, { result: { enabled: 1, prepared: 1, pending: 0, queued: 0, failed: 0, disabled: 0 } })
          return
        }
        child.respond(message, {
          ok: false,
          error: {
            message: 'PostgREST request saturated',
            code: 'SHADOW_RUNTIME_BATCH_FAILED',
            diagnostics: [{ runtime: 'v105-v10', stage: 'observeTable', code: 'db_request' }],
          },
        })
      },
    }),
  })
  await Promise.all([client.prepareRequired(), client.prepareV10()])
  const work = {
    sessionId: 'v10-rest-saturation',
    status: { connected: true, authenticated: true },
    tables: [{ tableId: 'BAG01', shoe: 1, round: 20 }],
    rounds: [],
  }
  const app = createApp({
    autoConnect: false,
    production: false,
    memberAuthRequired: false,
    requireVerifiedStrategy: false,
    isolateShadowProcess: true,
    shadowProcessClient: client,
    outboxWorkDeadlineMs: 1000,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        if (claimed) return []
        claimed = true
        return [{ session_id: work.sessionId, sequence: 1, claim_token: 'lease-rest', attempts: 1, payload: { work } }]
      },
      async completeCaptureOutbox() { completed += 1 },
      async failCaptureOutbox() { failed += 1 },
      async readIssuedPrediction() { return null },
    },
    v100FormalRuntime: { enabled: false },
  })
  t.after(() => app.stop())

  assert.deepEqual(await app.drainCaptureOutbox(), { processed: 1, failed: 0 })
  await waitFor(() => client.status().v105V10.lane.failed === 1, 'V10 REST saturation was not observed')
  assert.equal(completed, 1)
  assert.equal(failed, 0)
  assert.equal(client.status().required.lastSuccess.kind, 'capture')
  assert.equal(client.status().required.generation, 1)
  assert.equal(client.status().required.terminationFailed, false)
})

test('startup and shutdown prepare and stop required, V9, and V10 lanes independently', async () => {
  const calls = []
  const processClient = {
    runtime(_key, { enabled }) {
      return { enabled, snapshot() { return { status: enabled ? 'remote' : 'disabled' } } }
    },
    async prepareRequired() {
      calls.push('prepare-required')
      return { enabled: 1, prepared: 1, pending: 0, queued: 0, failed: 0, disabled: 6 }
    },
    async prepareV9() {
      calls.push('prepare-v9')
      return { enabled: 1, prepared: 1, pending: 0, queued: 0, failed: 0, disabled: 0 }
    },
    async prepareV10() {
      calls.push('prepare-v10')
      return { enabled: 1, prepared: 1, pending: 0, queued: 0, failed: 0, disabled: 0 }
    },
    async processCapture() {},
    status() {
      return {
        running: true,
        terminationFailed: false,
        required: { running: true, generation: 1 },
        v105V10: { enabled: true, running: true, generation: 1, lane: { active: 0, queued: 0 } },
      }
    },
    async stopRequired() { calls.push('stop-required') },
    async stopV9() { calls.push('stop-v9') },
    async stopV10() { calls.push('stop-v10') },
  }
  const app = createApp({
    autoConnect: false,
    port: 0,
    production: false,
    memberAuthRequired: false,
    requireVerifiedStrategy: false,
    isolateShadowProcess: true,
    shadowProcessClient: processClient,
    supabaseClient: { configured: false },
    v100FormalRuntime: { enabled: false },
  })

  await app.start()
  try {
    await waitFor(() => calls.includes('prepare-v10'), 'V10 startup prepare was not called')
    await waitFor(() => calls.includes('prepare-v9'), 'V9 startup prepare was not called')
  } finally {
    await app.stop()
  }
  assert.equal(calls.includes('prepare-required'), true)
  assert.equal(calls.includes('prepare-v9'), true)
  assert.equal(calls.includes('prepare-v10'), true)
  assert.equal(calls.includes('stop-required'), true)
  assert.equal(calls.includes('stop-v9'), true)
  assert.equal(calls.includes('stop-v10'), true)
})
