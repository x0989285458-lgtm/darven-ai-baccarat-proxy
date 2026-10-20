import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'
import { createSupabaseIngestionClient } from '../src/supabase-writer.js'

const active = [{ version: 'v105', status: 'active' }]
const flush = () => new Promise((resolve) => setImmediate(resolve))

function fixture(t, { rows = active, readError = null, direct = false, consumer = true, missing = false, configured = true, formalStart = async () => {} } = {}) {
  const calls = { requests: [], queries: [], formal: 0, claim: 0, issue: 0, lifecycle: 0, capture: 0, listen: 0, intervals: 0, recent: 0 }
  const client = createSupabaseIngestionClient({
    url: 'https://startup-fixture.invalid', serviceKey: 'fixture-only',
    requireVerifiedStrategy: true, retryAttempts: 1,
    strategyPool: direct ? { async query(sql) {
      calls.queries.push(typeof sql === 'string' ? sql : sql.text)
      if (readError) throw readError
      return { rows }
    } } : null,
    fetchImpl: async (url, init = {}) => {
      calls.requests.push({ path: new URL(url).pathname, method: init.method })
      if (readError && init.method === 'GET') throw readError
      return { ok: true, status: 200, json: async () => rows, text: async () => '' }
    },
  })
  Object.assign(client, {
    configured,
    async getRecentPredictionRows() { calls.recent += 1; return [] },
    async getCaptureOutboxHealth() { return { pending: 0, processing: 0, error: 0, dead_letter: 0, next_wakeup_at: null } },
    async claimCaptureOutbox() { calls.claim += 1; return [] },
    async issuePrediction() { calls.issue += 1; return null },
    async reconcilePredictionLifecycle() { calls.lifecycle += 1 },
    async getLatestCloudTableSnapshot() { return { snapshot_at: new Date().toISOString(), tables: ['BAV01', 'BAV02', 'BAV03', 'BAV03A', 'BAV05', 'BAV06'].map((tableId) => ({ tableId, shoe: 1, round: 0 })) } },
  })
  if (missing) delete client.verifyActiveStrategyReadOnly
  const app = createApp({
    production: true, requireVerifiedStrategy: true, memberAuthRequired: false,
    autoConnect: true, captureSource: 'cloud_browser', cloudBrowserUrl: 'https://capture-fixture.invalid',
    host: '127.0.0.1', port: 0, ingestKey: 'fixture-only',
    captureOutboxConsumerEnabled: consumer, captureOutboxPollMs: 10, latestPredictionRefreshMs: 10,
    supabaseClient: client, onlineCoreClient: { configured: false }, licenseAdminClient: { configured: false },
    v104FormalRuntime: { enabled: true, async start() { calls.formal += 1; await formalStart() } },
    fetchImpl: async () => { throw new Error('unexpected capture transport') },
  })
  // Exercise real startup composition with only native listener/transport seams inert.
  t.mock.method(app.server, 'listen', (_port, _host, done) => { calls.listen += 1; done(); return app.server })
  t.mock.method(app.cloudCaptureClient, 'start', () => { calls.capture += 1 })
  const interval = globalThis.setInterval
  t.mock.method(globalThis, 'setInterval', (...args) => { calls.intervals += 1; return interval(...args) })
  t.after(() => app.stop())
  return { app, client, calls }
}

function assertNoActiveMutation(calls) {
  assert.deepEqual(calls.requests.filter(({ method }) => method !== 'GET'), [], 'startup must never PATCH/archive or POST/promote Active')
  assert.ok(calls.queries.every((sql) => /^select version, status from public\.ai_strategy_versions/.test(sql)))
}

function assertNoWriters(calls) {
  for (const key of ['formal', 'claim', 'issue', 'lifecycle', 'capture', 'intervals']) assert.equal(calls[key], 0, `${key} must stay stopped`)
}


for (const phase of ['verify', 'recent']) {
  test(`stop during ${phase} must prevent later listen/formal/capture`, async (t) => {
    const { app, client, calls } = fixture(t)
    let release, entered
    const gate = new Promise(resolve => { release = resolve })
    const arrived = new Promise(resolve => { entered = resolve })
    const method = phase === 'verify' ? 'verifyActiveStrategyReadOnly' : 'getRecentPredictionRows'
    const original = client[method].bind(client)
    client[method] = async (...args) => { entered(); await gate; return original(...args) }
    const starting = app.start().then(() => 'resolved', e => `rejected:${e.message}`)
    await arrived
    await app.stop()
    const stopped = structuredClone(calls)
    release()
    const outcome = await starting
    await flush()
    console.log('STOP_RACE', JSON.stringify({phase, stopped, after:calls, outcome}))
    assert.equal(calls.listen, 0, 'stop must fence pending startup admission')
    assertNoWriters(calls)
  })
}
for (const direct of [false,true]) {
 test(`passive parent ${direct ? 'DB' : 'REST'} rejects wrong Active`, async t => {
  const {app,calls} = fixture(t,{direct,consumer:false,rows:[{version:'legacy',status:'active'}]})
  await assert.rejects(app.start(), /active strategy/)
  assertNoWriters(calls); assertNoActiveMutation(calls); assert.equal(calls.listen,0)
 })
}

test('stop during Formal hydration prevents late collector and timers', async t => {
  let release, entered
  const gate = new Promise(resolve => { release = resolve })
  const arrived = new Promise(resolve => { entered = resolve })
  const {app, calls} = fixture(t, {formalStart: async () => { entered(); await gate }})
  const starting = app.start().then(() => null, error => error)
  await arrived
  await app.stop()
  release()
  assert.match((await starting)?.message ?? '', /application stopped during startup/)
  assert.equal(calls.formal, 1)
  for (const key of ['capture', 'claim', 'issue', 'lifecycle', 'intervals']) assert.equal(calls[key], 0)
  await assert.rejects(app.start(), /application stopped during startup/)
})

test('stop before listener callback closes a late listening socket', async t => {
  const {app, calls} = fixture(t)
  let finishListen, entered, listening = false, closeCount = 0
  const arrived = new Promise(resolve => { entered = resolve })
  t.mock.getter(app.server, 'listening', () => listening)
  t.mock.method(app.server, 'listen', (_port, _host, done) => {
    calls.listen += 1
    finishListen = () => { listening = true; done() }
    entered()
    return app.server
  })
  t.mock.method(app.server, 'close', done => { closeCount += 1; listening = false; done(); return app.server })
  const starting = app.start().then(() => null, error => error)
  await arrived
  await app.stop()
  finishListen()
  assert.match((await starting)?.message ?? '', /application stopped during startup/)
  assert.equal(listening, false)
  assert.equal(closeCount, 1)
  assertNoWriters(calls)
})

test('stop before startup microtask prevents even verification', async t => {
  const {app, calls} = fixture(t)
  const starting = app.start().then(() => null, error => error)
  await app.stop()
  assert.match((await starting)?.message ?? '', /application stopped during startup/)
  assert.equal(calls.requests.length, 0)
  assert.equal(calls.listen, 0)
  assertNoWriters(calls)
})

test('failed admission stays failed without retrying or promoting Active on the same App', async t => {
  const {app, client, calls} = fixture(t, {rows: [{version: 'legacy', status: 'active'}]})
  await assert.rejects(app.start(), /active strategy/)
  let retries = 0
  client.verifyActiveStrategyReadOnly = async () => { retries += 1; return {ok: true, activeStrategyVersion: 'v105'} }
  await assert.rejects(app.start(), /active strategy/)
  assert.equal(retries, 0)
  assertNoActiveMutation(calls)
  assertNoWriters(calls)
  assert.equal(calls.listen, 0)
})

test('concurrent startup shares verification and starts resources once', async t => {
  const {app, client, calls} = fixture(t)
  let release, entered, verifies = 0
  const gate = new Promise(resolve => { release = resolve })
  const arrived = new Promise(resolve => { entered = resolve })
  const original = client.verifyActiveStrategyReadOnly.bind(client)
  client.verifyActiveStrategyReadOnly = async () => { verifies += 1; entered(); await gate; return original() }
  const a = app.start()
  const b = app.start()
  await arrived
  release()
  await Promise.all([a, b])
  assert.equal(verifies, 1)
  assert.equal(calls.listen, 1)
  assert.equal(calls.formal, 1)
  assert.equal(calls.capture, 1)
})
