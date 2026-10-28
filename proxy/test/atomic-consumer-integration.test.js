import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'
import { createV105FormalRuntime } from '../src/v105-formal-runtime.js'
const ids = ['BAV01', 'BAV02', 'BAV03', 'BAV03A', 'BAV05', 'BAV06']
const pid = '11111111-1111-4111-8111-111111111111'
const tables = () => ids.map(tableId => ({ tableId, shoe: '88', round: 7, roundBasis: 'completed', sourceUpdatedAt: new Date(Date.now() - 10).toISOString(), bigRoadRaw: 'BPBPBPB' }))
const issued = table => ({ targetTableId: table.tableId, targetShoe: String(table.shoe), targetRound: table.round + 1, strategyVersion: 'v105', predictionId: pid, issuedAt: new Date(Date.now() - 10).toISOString(), predictionTiming: 'pre_result_context', predictedResult: 'banker', sameSideStreak: 2, sidePredictions: { tie: 10, superSix: 10, bankerPair: 10, playerPair: 10, bankerDragon: 10, playerDragon: 10 }, sideActions: { tie: false, superSix: false, bankerPair: false, playerPair: false, bankerDragon: false, playerDragon: false } })
const receipt = input => ({ disposition: 'published', publication_revision: 1, table_id: input.tableId, shoe_no: input.shoe, target_round: input.round, prediction_id: input.predictionId })
function harness(options = {}, overrides = {}) {
  let claimed = false
  const calls = { complete: 0, fail: 0, issue: 0, publish: [], read: [], reconcile: 0 }
  const writer = {
    configured: true,
    async getLatestCloudTableSnapshot() { return { snapshot_at: new Date().toISOString(), tables: tables() } },
    async reconcilePredictionLifecycle() { calls.reconcile++ },
    async issuePrediction(value) { calls.issue++; return { ...value, predictionId: pid, issuedAt: new Date().toISOString() } },
    async readIssuedPrediction(input) { calls.read.push(input); return null },
    async publishV105TablePublication(input) { calls.publish.push(input); return receipt(input) },
    async claimCaptureOutbox() {
      if (claimed) return []
      claimed = true
      return [{ session_id: 'atomic-test', sequence: 1, claim_token: 'claim', attempts: 1, payload: { work: { sessionId: 'atomic-test', tables: [tables()[0]], rounds: [{ tableId: 'BAV01', shoe: '88', round: 7, winner: 'banker', rawResult: [1, 9, 2, 10, -1, -1, -1, -1, 1, 9], sourceAction: '/api/v1/gametype/*/game/*/room/*/table/*/summary' }] } } }]
    },
    async completeCaptureOutbox() { calls.complete++ },
    async failCaptureOutbox() { calls.fail++ },
    async getCaptureOutboxHealth() { return { pending: 0, processing: 0, error: 0, dead_letter: 0 } },
    ...overrides,
  }
  const app = createApp({ autoConnect: false, production: true, requireVerifiedStrategy: false, memberAuthRequired: false, captureRoundBasis: 'completed', liveAtomicPublicationsEnabled: true, outboxCoalesceMs: 0, port: 0, supabaseClient: writer,
    v104FormalRuntime: { async start() {}, latestIssuance() { return null }, async buildPrediction(table) { return issued(table) }, recordIssuance() {}, recordSettlement() {}, snapshot() { return { status: 'ready' } } },
    v100FormalRuntime: { enabled: true, async processSnapshot({ tables }) { return { tables } } }, ...options })
  return { app, calls }
}

test('one failed table publication cannot block healthy-table Final claim and ACK', async () => {
  let claims = 0
  const published = []
  const { app, calls } = harness({}, {
    async publishV105TablePublication(input) {
      published.push(input)
      if (input.tableId === 'BAV01') throw new Error('table publication unavailable')
      return receipt(input)
    },
    async claimCaptureOutbox() {
      claims++
      if (claims > 1) return []
      return [{ session_id: 'atomic-test', sequence: 1, claim_token: 'claim', attempts: 1, payload: { work: { sessionId: 'atomic-test', tables: [tables()[1]], rounds: [{ tableId: 'BAV02', shoe: '88', round: 7, winner: 'banker', rawResult: [1, 9, 2, 10, -1, -1, -1, -1, 1, 9], sourceAction: '/api/v1/gametype/*/game/*/room/*/table/*/summary' }] } } }]
    },
  })
  try {
    await app.drainCaptureOutbox()
    assert.ok(claims >= 1)
    assert.equal(calls.complete, 1)
    assert.equal(calls.fail, 0)
    assert.ok(published.some(input => input.tableId === 'BAV02'))
    await assert.rejects(app.refreshLatestDurablePredictions(), /publication unavailable/)
    assert.ok(published.filter(input => input.tableId === 'BAV01').length >= 2, 'failed table timer cursor must remain retryable')
  } finally { await app.stop() }
})

test('per-table preclaim isolation never acknowledges the failed table Final', async () => {
  const { app, calls } = harness({}, { async publishV105TablePublication(input) {
    if (input.tableId === 'BAV01') throw new Error('table publication unavailable')
    return receipt(input)
  } })
  try {
    await app.drainCaptureOutbox()
    assert.equal(calls.complete, 0)
    assert.equal(calls.fail, 1)
  } finally { await app.stop() }
})

test('unknown cloud snapshot still prevents claim despite per-table preclaim isolation', async () => {
  let claims = 0
  const { app, calls } = harness({}, {
    async getLatestCloudTableSnapshot() { throw new Error('snapshot unknown') },
    async claimCaptureOutbox() { claims++; return [] },
  })
  try {
    await assert.rejects(app.drainCaptureOutbox(), /fresh complete cloud snapshot/)
    assert.equal(claims, 0)
    assert.equal(calls.complete, 0)
  } finally { await app.stop() }
})

test('historical exact durable issuance drains Final without publishing obsolete screen or advancing timer cursor', async () => {
  const published = [], exactReads = []
  const formal = createV105FormalRuntime({ allowUnconfigured: true })
  await formal.start()
  formal.recordIssuance({ ...issued({ tableId: 'BAV01', shoe: '88', round: 8 }), sameSideStreak: 1 })
  const { app, calls } = harness({
    v104FormalRuntime: { async start() {}, latestIssuance: formal.latestIssuance, async buildPrediction(table) { return issued(table) }, recordIssuance() {}, recordSettlement() {}, snapshot() { return { status: 'ready' } } },
  }, {
    async readIssuedPrediction(input) { exactReads.push(input); return input.round === 8 ? issued({ tableId: input.tableId, shoe: input.shoe, round: input.round - 1 }) : null },
    async publishV105TablePublication(input) {
      published.push(input)
      return input.tableId === 'BAV01' ? { ...receipt(input), disposition: 'superseded' } : receipt(input)
    },
  })
  try {
    await app.drainCaptureOutbox()
    assert.equal(calls.complete, 1, app.state.snapshot().status.persistenceError)
    assert.equal(calls.fail, 0)
    assert.equal(published.filter(input => input.tableId === 'BAV01').length, 0)
    assert.ok(exactReads.some(input => input.tableId === 'BAV01' && input.round === 8))
    await assert.rejects(app.refreshLatestDurablePredictions(), /historical|superseded/)
    assert.equal(published.filter(input => input.tableId === 'BAV01').length, 0)
  } finally { await app.stop() }
})

test('historical fallback cannot use missing, wrong or unknown exact durable issuance', async t => {
  for (const kind of ['missing', 'wrong', 'error']) await t.test(kind, async () => {
    const { app, calls } = harness({ v104FormalRuntime: {
      async start() {}, latestIssuance(tableId) { return tableId === 'BAV01' ? issued({ tableId, shoe: '88', round: 8 }) : null }, async buildPrediction(table) { return issued(table) }, recordIssuance() {}, recordSettlement() {}, snapshot() { return { status: 'ready' } },
    } }, { async readIssuedPrediction(input) {
      if (kind === 'error') throw new Error('unknown issuance')
      return kind === 'missing' ? null : issued({ tableId: input.tableId, shoe: 'wrong', round: input.round - 1 })
    } })
    try {
      await app.drainCaptureOutbox()
      assert.equal(calls.complete, 0)
      assert.equal(calls.fail, 1)
      assert.equal(calls.publish.filter(input => input.tableId === 'BAV01').length, 0)
    } finally { await app.stop() }
  })
})

test('historical exact identity cannot acknowledge semantically invalid immutable predictions', async t => {
  for (const kind of ['valid', 'missingMain', 'invalidMain', 'missingTiming', 'postResult', 'invalidIssuedAt']) await t.test(kind, async () => {
    const formal = createV105FormalRuntime({ allowUnconfigured: true })
    await formal.start()
    formal.recordIssuance({ ...issued({ tableId: 'BAV01', shoe: '88', round: 8 }), sameSideStreak: 1 })
    const { app, calls } = harness({ v104FormalRuntime: {
      async start() {}, latestIssuance: formal.latestIssuance, async buildPrediction(table) { return issued(table) }, recordIssuance() {}, recordSettlement() {}, snapshot() { return { status: 'ready' } },
    } }, { async readIssuedPrediction(input) {
      if (input.round !== 8) return null // This fixture has no issuance for Final7.
      const exact = issued({ tableId: input.tableId, shoe: input.shoe, round: input.round - 1 })
      if (kind === 'missingMain') delete exact.predictedResult
      if (kind === 'invalidMain') exact.predictedResult = 'tie'
      if (kind === 'missingTiming') delete exact.predictionTiming
      if (kind === 'postResult') exact.predictionTiming = 'post_result'
      if (kind === 'invalidIssuedAt') exact.issuedAt = 'invalid'
      return exact
    } })
    try {
      await app.drainCaptureOutbox()
      assert.equal(calls.complete, kind === 'valid' ? 1 : 0, app.state.snapshot().status.persistenceError)
      assert.equal(calls.fail, kind === 'valid' ? 0 : 1)
      assert.equal(calls.publish.filter(input => input.tableId === 'BAV01').length, 0)
    } finally { await app.stop() }
  })
})

test('current Final publication unknown or superseded without historical proof cannot ACK', async t => {
  for (const kind of ['unknown', 'superseded']) await t.test(kind, async () => {
    let writes = 0
    const { app, calls } = harness({}, { async publishV105TablePublication(input) {
      writes++
      if (writes <= ids.length) return receipt(input)
      if (kind === 'unknown') throw new Error('publication commit unknown')
      return { ...receipt(input), disposition: 'superseded' }
    } })
    try {
      await app.drainCaptureOutbox()
      assert.equal(calls.complete, 0)
      assert.equal(calls.fail, 1)
    } finally { await app.stop() }
  })
})

test('Consumer explicit loopback postcommit wake never delays Final ACK; stop aborts late transport', async t => {
  const previous = process.env.LIVE_PUBLICATION_NOTIFY_URL
  process.env.LIVE_PUBLICATION_NOTIFY_URL = 'http://127.0.0.1:8792/internal/publication-ready'
  t.after(() => { if (previous === undefined) delete process.env.LIVE_PUBLICATION_NOTIFY_URL; else process.env.LIVE_PUBLICATION_NOTIFY_URL = previous })
  let release
  const sends = [], order = []
  const { app, calls } = harness({ controlToken: 'notifier-fixture-only', fetchImpl: (url, init) => {
    sends.push({ url, init }); order.push('notify')
    return new Promise(resolve => { release = resolve })
  } }, { async publishV105TablePublication(input) { order.push('commit'); return receipt(input) } })
  try {
    await app.drainCaptureOutbox()
    assert.equal(calls.complete, 1, app.state.snapshot().status.persistenceError)
    assert.equal(calls.fail, 0)
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.equal(sends.length, 1)
    assert.ok(order.indexOf('notify') > order.indexOf('commit'))
    assert.equal(sends[0].url, process.env.LIVE_PUBLICATION_NOTIFY_URL)
    assert.equal(sends[0].init.body, '{}')
    assert.equal(sends[0].init.headers['x-control-token'], 'notifier-fixture-only')
    await app.stop()
    assert.equal(sends[0].init.signal.aborted, true)
    release({ ok: true })
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.equal(sends.length, 1)
  } finally { await app.stop(); release?.({ ok: true }) }
})
