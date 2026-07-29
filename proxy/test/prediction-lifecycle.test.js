import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'
import { buildLivePrediction, createSupabaseIngestionClient } from '../src/supabase-writer.js'

const strategyVersion = 'v98'

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload), json: async () => payload }
}

function table(tableId = 'BAG01', shoe = 88, round = 20) {
  return { tableId, shoe, round, sourceUpdatedAt: '2026-07-17T01:00:00.000Z', beadPlateRaw: '0102', bigRoadRaw: 'BP' }
}


test('writer verifies exact reconcile ACK identity and lifecycle counts', async () => {
  const requests = []
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) })
      return response({ source: 'ofalive99', table_id: 'BAG03A', current_shoe: '901', current_visible_round: 12, pending: 2, expired_no_final: 3, abandoned_shoe_change: 4, updated_total: 9 })
    },
  })
  const ack = await client.reconcilePredictionLifecycle({ source: 'ofalive99', tableId: 'BAG03A', currentShoe: 901, currentVisibleRound: 12 })
  assert.deepEqual(ack, { source: 'ofalive99', tableId: 'BAG03A', currentShoe: '901', currentVisibleRound: 12, counts: { pending: 2, expiredNoFinal: 3, abandonedShoeChange: 4, updatedTotal: 9 } })
  assert.match(requests[0].url, /\/rpc\/reconcile_v105_prediction_lifecycle$/)
  assert.deepEqual(requests[0].body, { p_source: 'ofalive99', p_table_id: 'BAG03A', p_current_shoe: '901', p_current_visible_round: 12 })

  const mismatch = createSupabaseIngestionClient({ url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false, fetchImpl: async () => response({ source: 'ofalive99', table_id: 'BAG03A', current_shoe: '902', current_visible_round: 12, pending: 0, expired_no_final: 0, abandoned_shoe_change: 0, updated_total: 0 }) })
  await assert.rejects(mismatch.reconcilePredictionLifecycle({ source: 'ofalive99', tableId: 'BAG03A', currentShoe: 901, currentVisibleRound: 12 }), /reconciliation acknowledgement failed/)
})

test('direct reconcile uses the transaction connection with all identity parameters and preserves the ACK', async () => {
  const acknowledgement = { source: 'ofalive99', table_id: 'BAG03A', current_shoe: '901', current_visible_round: 12, pending: 2, expired_no_final: 3, abandoned_shoe_change: 4, updated_total: 9 }
  const queries = []
  let fetchCalls = 0
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    fetchImpl: async () => { fetchCalls += 1; throw new Error('REST must not be used') },
    strategyPool: { async query(value) {
      queries.push(value)
      return { rows: [{ reconcile_v105_prediction_lifecycle: acknowledgement }] }
    } },
  })

  const result = await client.reconcilePredictionLifecycle({ source: 'ofalive99', tableId: 'BAG03A', currentShoe: 901, currentVisibleRound: 12 })
  assert.deepEqual(result, { source: 'ofalive99', tableId: 'BAG03A', currentShoe: '901', currentVisibleRound: 12, counts: { pending: 2, expiredNoFinal: 3, abandonedShoeChange: 4, updatedTotal: 9 } })
  assert.equal(fetchCalls, 0)
  assert.equal(queries.length, 1)
  assert.match(queries[0].text, /select public\.reconcile_v105_prediction_lifecycle\(\$1::text, \$2::text, \$3::text, \$4::integer\) as reconcile_v105_prediction_lifecycle/)
  assert.deepEqual(queries[0].values, ['ofalive99', 'BAG03A', '901', 12])
})

test('direct reconcile and issuance share one ordered write queue without overlap', async () => {
  const candidate = buildLivePrediction(table())
  const issued = { ...candidate, predictionId: '11111111-1111-1111-1111-111111111111', issuedAt: '2026-07-17T01:00:01.000Z' }
  const events = []
  let releaseReconcile
  let markReconcileStarted
  const reconcileStarted = new Promise((resolve) => { markReconcileStarted = resolve })
  const reconcileGate = new Promise((resolve) => { releaseReconcile = resolve })
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    fetchImpl: async () => { throw new Error('REST must not be used') },
    strategyPool: { async query(value) {
      if (value.text.includes('reconcile_v105_prediction_lifecycle')) {
        events.push('reconcile:start')
        markReconcileStarted()
        await reconcileGate
        events.push('reconcile:end')
        return { rows: [{ reconcile_v105_prediction_lifecycle: { source: 'ofalive99', table_id: 'BAG01', current_shoe: '88', current_visible_round: 20, pending: 0, expired_no_final: 0, abandoned_shoe_change: 0, updated_total: 0 } }] }
      }
      events.push('issue:start')
      return { rows: [{ issue_v105_prediction: { prediction_id: issued.predictionId, prediction_issued_at: issued.issuedAt, prediction: issued } }] }
    } },
  })

  const reconcile = client.reconcilePredictionLifecycle({ source: 'ofalive99', tableId: 'BAG01', currentShoe: 88, currentVisibleRound: 20 })
  await reconcileStarted
  const issuance = client.issuePrediction(candidate)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(events, ['reconcile:start'])
  releaseReconcile()
  await Promise.all([reconcile, issuance])
  assert.deepEqual(events, ['reconcile:start', 'reconcile:end', 'issue:start'])
})

test('runtime reconciles once per changed screen identity per table, including ten tables and restart', async () => {
  const calls = []
  const writer = {
    configured: true,
    async reconcilePredictionLifecycle(identity) { calls.push(identity); return { ...identity, counts: { pending: 0, expiredNoFinal: 0, abandonedShoeChange: 0, updatedTotal: 0 } } },
    async issuePrediction(candidate) { return { ...candidate, predictionId: `pid-${candidate.targetTableId}-${candidate.targetShoe}-${candidate.targetRound}`, issuedAt: '2026-07-17T01:00:00.000Z' } },
    async readIssuedPrediction() { return null },
  }
  const ten = ['BAG01', 'BAG02', 'BAG03', 'BAG03A', 'BAG05', 'BAG06', 'BAG07', 'BAG08', 'BAG09', 'BAG10'].map((id) => table(id))
  const app = createApp({ autoConnect: false, supabaseClient: writer })
  app.state.setTables(ten)
  app.state.setTables(ten.map((item) => ({ ...item, sourceUpdatedAt: '2026-07-17T01:00:01.000Z' })))
  await app.waitForServiceWorkIdle()
  assert.equal(calls.length, 10)
  assert.ok(calls.every((item) => item.source === 'ofalive99' && item.currentVisibleRound === 20))
  app.state.setTables(ten.map((item) => item.tableId === 'BAG05' ? { ...item, round: 21 } : item))
  await app.waitForServiceWorkIdle()
  assert.equal(calls.length, 11)
  assert.equal(calls.at(-1).tableId, 'BAG05')
  assert.equal(calls.at(-1).currentVisibleRound, 21)

  const restartedCalls = []
  const restarted = createApp({ autoConnect: false, supabaseClient: { ...writer, reconcilePredictionLifecycle: async (identity) => { restartedCalls.push(identity); return { ...identity, counts: { pending: 0, expiredNoFinal: 0, abandonedShoeChange: 0, updatedTotal: 0 } } } } })
  restarted.state.setTables(ten)
  await restarted.waitForServiceWorkIdle()
  assert.equal(restartedCalls.length, 10)
})

test('lifecycle guard rejects same-shoe round regression without stale reconcile or issuance mutation', async () => {
  const reconciled = []
  const issued = []
  const writer = {
    configured: true,
    async reconcilePredictionLifecycle(identity) { reconciled.push(identity) },
    async issuePrediction(candidate) {
      issued.push([candidate.targetShoe, candidate.targetRound])
      return { ...candidate, predictionId: `pid-${candidate.targetShoe}-${candidate.targetRound}`, issuedAt: '2026-07-17T01:00:00.000Z' }
    },
    async readIssuedPrediction() { return null },
  }
  const app = createApp({ autoConnect: false, supabaseClient: writer })
  for (const round of [20, 21, 20]) {
    app.state.setTables([table('BAG01', 88, round)])
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.deepEqual(reconciled.map(({ currentShoe, currentVisibleRound }) => [currentShoe, currentVisibleRound]), [['88', 20], ['88', 21]])
  assert.deepEqual(issued, [['88', 21], ['88', 22]])
})

test('lifecycle guard rejects old-shoe replay and still accepts a legitimate newer shoe', async () => {
  const reconciled = []
  const issued = []
  const writer = {
    configured: true,
    async reconcilePredictionLifecycle(identity) { reconciled.push(identity) },
    async issuePrediction(candidate) {
      issued.push([candidate.targetShoe, candidate.targetRound])
      return { ...candidate, predictionId: `pid-${candidate.targetShoe}-${candidate.targetRound}`, issuedAt: '2026-07-17T01:00:00.000Z' }
    },
    async readIssuedPrediction() { return null },
  }
  const app = createApp({ autoConnect: false, supabaseClient: writer })
  for (const shoe of [88, 89, 88, 90]) {
    app.state.setTables([table('BAG01', shoe, 20)])
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.deepEqual(reconciled.map(({ currentShoe, currentVisibleRound }) => [currentShoe, currentVisibleRound]), [['88', 20], ['89', 20], ['90', 20]])
  assert.deepEqual(issued, [['88', 21], ['89', 21], ['90', 21]])
})

test('reconcile failure records persistence error without pretending settlement or polling repeatedly', async () => {
  let reconcileCalls = 0
  let issueCalls = 0
  const app = createApp({ autoConnect: false, supabaseClient: {
    configured: true,
    async reconcilePredictionLifecycle() { reconcileCalls += 1; throw new Error('reconcile unavailable') },
    async issuePrediction(candidate) { issueCalls += 1; return { ...candidate, predictionId: 'pid', issuedAt: '2026-07-17T01:00:00.000Z' } },
    async readIssuedPrediction() { return null },
  } })
  app.state.setTables([table()])
  app.state.setTables([{ ...table(), sourceUpdatedAt: '2026-07-17T01:00:02.000Z' }])
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(reconcileCalls, 1)
  assert.equal(issueCalls, 1, 'preissuance may proceed independently')
  assert.match(app.state.snapshot().status.persistenceError ?? '', /reconcile unavailable/)
})

test('lifecycle stats use an aggregate RPC and exclude expired and abandoned rows from active pending while old APIs remain additive', async () => {
  let statsUrl = ''
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    fetchImpl: async (url) => {
      statsUrl = String(url)
      return response({ active_pending: 2, settled: 1, expired_no_final: 1, abandoned_shoe_change: 1, unclassified: 1, total: 6 })
    },
  })
  assert.deepEqual(await client.getPredictionLifecycleStats(), { activePending: 2, settled: 1, expiredNoFinal: 1, abandonedShoeChange: 1, unclassified: 1, total: 6 })
  assert.match(statsUrl, /\/rpc\/get_v105_prediction_lifecycle_stats$/)

  const app = createApp({ autoConnect: false, licenseAdminClient: { configured: false, getCloudDataStatus: async () => ({ message: 'ok' }), getDailyAnalytics: async () => ({ todayRoundCount: 0, tableStats: [], dailyReports: [] }) }, supabaseClient: { configured: true, getPredictionLifecycleStats: async () => ({ activePending: 2, settled: 1, expiredNoFinal: 1, abandonedShoeChange: 1, unclassified: 0, total: 5 }) } })
  const status = JSON.parse((await app.inject({ url: '/api/cloud-data/status' })).body)
  assert.equal(status.ok, true)
  assert.equal(status.lifecycleStats.activePending, 2)
  assert.ok(Array.isArray(status.tableStats))
})
