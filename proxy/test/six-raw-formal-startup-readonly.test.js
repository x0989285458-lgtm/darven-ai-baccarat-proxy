import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'
import { createSupabaseIngestionClient } from '../src/supabase-writer.js'

const active = [{ version: 'v105', status: 'active' }]
const flush = () => new Promise((resolve) => setImmediate(resolve))

function fixture(t, { rows = active, readError = null, direct = false, consumer = true, missing = false, configured = true } = {}) {
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
    v104FormalRuntime: { enabled: true, async start() { calls.formal += 1 } },
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

test('six-raw required client legacy bootstrap cannot promote Active on a re-verification path', async (t) => {
  const { client, calls } = fixture(t, { rows: [{ version: 'legacy', status: 'active' }], direct: true })
  const result = await client.ensureInitialStrategy().then(() => null, (error) => error)
  assertNoActiveMutation(calls)
  assert.match(result?.message ?? '', /active strategy/)
  assert.equal(client.getRuntimeStatus().ready, false)
})

test('six-raw formal consumer wrong Active fails closed without promotion or writer startup', async (t) => {
  const { app, calls } = fixture(t, { rows: [{ version: 'legacy', status: 'active' }] })
  const result = await app.start().then(() => null, (error) => error)
  await flush()
  assertNoActiveMutation(calls)
  assert.match(result?.message ?? '', /active strategy/)
  assertNoWriters(calls)
  assert.equal(calls.listen, 0, 'no admission before strategy verification')
})


for (const direct of [false, true]) {
  for (const [name, options] of [
    ['wrong version', { rows: [{ version: 'legacy', status: 'active' }] }],
    ['multiple active', { rows: [...active, { version: 'legacy', status: 'active' }] }],
    ['no active', { rows: [] }],
    ['inactive row', { rows: [{ version: 'v105', status: 'archived' }] }],
    ['DB read error', { readError: new Error('temporary database failure') }],
  ]) {
    test(`six-raw ${direct ? 'DB' : 'REST'} ${name} blocks consumer and all producer startup`, async (t) => {
      const { app, calls } = fixture(t, { direct, ...options })
      await assert.rejects(app.start(), /active strategy/)
      await app.drainCaptureOutbox()
      await app.refreshLatestDurablePredictions()
      await flush()
      assertNoActiveMutation(calls)
      assertNoWriters(calls)
      assert.equal(calls.listen, 0)
      assert.equal(calls.recent, 0)
      if (direct) assert.deepEqual(calls.requests, [], 'DB failure must not fall through to REST repair')
      else assert.deepEqual(calls.requests.map(({ method }) => method), ['GET'])
    })
    test(`six-raw required legacy client ${direct ? 'DB' : 'REST'} ${name} never falls back to bootstrap`, async (t) => {
      const { client, calls } = fixture(t, { direct, ...options })
      await assert.rejects(client.ensureInitialStrategy(), /active strategy/)
      assertNoActiveMutation(calls)
      assert.equal(client.getRuntimeStatus().degraded, true)
      if (direct) assert.deepEqual(calls.requests, [])
    })
  }
  test(`six-raw one active v105 admits formal, collector, claim and timers after ${direct ? 'DB' : 'REST'} verification`, async (t) => {
    const { app, calls } = fixture(t, { direct })
    await app.start()
    await app.drainCaptureOutbox()
    assertNoActiveMutation(calls)
    assert.equal(calls.formal, 1)
    assert.equal(calls.capture, 1)
    assert.ok(calls.claim >= 1)
    assert.equal(calls.intervals, 1)
    assert.equal(calls.recent, 1)
    assert.equal(calls.listen, 1)
    if (direct) assert.deepEqual(calls.requests, [])
    else assert.deepEqual(calls.requests.map(({ method }) => method), ['GET'])
  })
}

for (const [name, options] of [
  ['missing read-only verifier', { missing: true }],
  ['unconfigured client', { configured: false }],
]) {
  test(`six-raw ${name} cannot silently admit production writers`, async (t) => {
    const { app, calls } = fixture(t, options)
    await assert.rejects(app.start(), /active strategy/)
    await app.drainCaptureOutbox()
    await flush()
    assertNoActiveMutation(calls)
    assertNoWriters(calls)
    assert.equal(calls.listen, 0)
  })
}

for (const acknowledgement of [false, undefined, { ok: false }, { ok: true, activeStrategyVersion: 'legacy' }]) {
  test(`six-raw invalid verification acknowledgement ${JSON.stringify(acknowledgement)} fails closed even with stale ready status`, async (t) => {
    const { app, client, calls } = fixture(t)
    await client.verifyActiveStrategyReadOnly()
    client.verifyActiveStrategyReadOnly = async () => acknowledgement
    await assert.rejects(app.start(), /active strategy/)
    assertNoActiveMutation(calls)
    assertNoWriters(calls)
    assert.equal(calls.listen, 0)
  })
}

test('six-raw unresolved verification keeps HTTP admission and every writer stopped', async (t) => {
  const { app, client, calls } = fixture(t)
  const verify = client.verifyActiveStrategyReadOnly.bind(client)
  let release
  const gate = new Promise((resolve) => { release = resolve })
  client.verifyActiveStrategyReadOnly = async () => { await gate; return verify() }
  const starting = app.start()
  try {
    await flush()
    assertNoWriters(calls)
    assert.equal(calls.listen, 0)
  } finally {
    release()
    await starting
  }
  await app.drainCaptureOutbox()
  assert.equal(calls.formal, 1)
  assert.ok(calls.claim >= 1)
})

for (const direct of [false, true]) {
  test(`six-raw passive parent uses bounded ${direct ? 'DB' : 'REST'} readiness without formal or claim work`, async (t) => {
    const { app, client, calls } = fixture(t, { direct, consumer: false })
    await app.start()
    await app.drainCaptureOutbox()
    await flush()
    assert.deepEqual(client.getRuntimeStatus(), { ready: true, degraded: false, reason: null, activeStrategyVersion: 'v105' })
    assertNoActiveMutation(calls)
    assertNoWriters(calls)
    assert.equal(calls.recent, 0)
    assert.equal(calls.listen, 1)
    if (direct) {
      assert.equal(calls.queries.length, 1)
      assert.match(calls.queries[0], /limit 2$/)
    } else assert.equal(calls.requests.length, 1)
  })
}
