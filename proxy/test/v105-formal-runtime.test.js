import test from 'node:test'
import assert from 'node:assert/strict'
import { createV105FormalRuntime } from '../src/v105-formal-runtime.js'
import { createSupabaseIngestionClient } from '../src/supabase-writer.js'
import { PRODUCTION_TABLE_IDS } from '../src/cloud-capture.js'

function response(payload) {
  return { ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload }
}

test('v105 runtime hydrates v104 predecessor history, keeps v105 identity, and emits cycle-priority predictions', async () => {
  const calls = []
  const predecessor = {
    prediction_id: 'v104-predecessor', strategy_version: 'v104', prediction_timing: 'pre_result_context',
    prediction_issued_at: '2026-07-22T00:00:00.000Z', settlement_final: true,
    table_id: 'BAG01', shoe_no: '1', round_no: 8, predicted_result: 'banker', actual_result: 'banker', same_side_streak: 5,
  }
  const runtime = createV105FormalRuntime({
    writer: {
      configured: true,
      async getV105FormalHistory(options) { calls.push(options); return [predecessor] },
    },
  })
  await runtime.start()
  const prediction = await runtime.buildPrediction({
    tableId: 'BAG01', shoe: '1', round: 8,
    beadPlateRaw: '0201010102010101', bigRoadRaw: '0002,,,,,#0001,0001,0001,,,#0002,,,,,#0001,0001,0001,,,', bankerCount: 2, playerCount: 6,
  })
  assert.equal(calls.length, 1)
  assert.equal(runtime.snapshot().strategyVersion, 'v105')
  assert.equal(runtime.snapshot().historySource, 'v104_predecessor_plus_v105_formal_issuance_and_final')
  assert.equal(runtime.snapshot().lastIssuanceByTable.BAG01.round, 8)
  assert.equal(runtime.snapshot().lastIssuanceByTable.BAG01.sameSideStreak, 5)
  assert.equal(prediction.strategyVersion, 'v105')
  assert.equal(prediction.diagnostics.roadCycles.main.direction, 'banker')
})

test('v105 runtime accepts an identical current issuance after restart hydration without advancing its streak twice', async () => {
  const hydrated = {
    prediction_id: 'existing-current', strategy_version: 'v105', prediction_timing: 'pre_result_context',
    prediction_issued_at: '2026-08-03T16:17:44.000Z', settlement_final: false,
    table_id: 'BAG09', shoe_no: '4337', round_no: 12, predicted_result: 'banker', same_side_streak: 2,
  }
  const runtime = createV105FormalRuntime({
    writer: { configured: true, async getV105FormalHistory() { return [hydrated] } },
  })
  await runtime.start()
  assert.doesNotThrow(() => runtime.recordIssuance({
    predictionId: 'existing-current', issuedAt: hydrated.prediction_issued_at,
    strategyVersion: 'v105', predictionTiming: 'pre_result_context',
    source: 'ofalive99', targetTableId: 'BAG09', targetShoe: '4337', targetRound: 12,
    predictedResult: 'banker', sameSideStreak: 2,
    baselineV104PredictedResult: 'banker', baselineV104SameSideStreak: 2,
  }))
  assert.deepEqual(runtime.snapshot().lastIssuanceByTable.BAG09, {
    shoe: '4337', direction: 'banker', sameSideStreak: 2, round: 12,
  })
})

test('v105 runtime rejects a conflicting duplicate current issuance after restart hydration', async () => {
  const hydrated = {
    prediction_id: 'existing-current', strategy_version: 'v105', prediction_timing: 'pre_result_context',
    prediction_issued_at: '2026-08-03T16:17:44.000Z', settlement_final: false,
    table_id: 'BAG09', shoe_no: '4337', round_no: 12, predicted_result: 'banker', same_side_streak: 2,
  }
  const runtime = createV105FormalRuntime({
    writer: { configured: true, async getV105FormalHistory() { return [hydrated] } },
  })
  await runtime.start()
  assert.throws(() => runtime.recordIssuance({
    predictionId: 'different-id', issuedAt: hydrated.prediction_issued_at,
    strategyVersion: 'v105', predictionTiming: 'pre_result_context',
    source: 'ofalive99', targetTableId: 'BAG09', targetShoe: '4337', targetRound: 12,
    predictedResult: 'banker', sameSideStreak: 3,
    baselineV104PredictedResult: 'banker', baselineV104SameSideStreak: 3,
  }), /streak acknowledgement mismatch/)
})

test('failed v105 hydration is circuit-broken instead of hammering the database on every worker retry', async () => {
  let calls = 0
  let nowMs = 1000
  const runtime = createV105FormalRuntime({
    now: () => nowMs,
    retryBackoffMs: 300000,
    writer: {
      configured: true,
      async getV105FormalHistory() { calls += 1; throw new Error('database overloaded') },
    },
  })
  await assert.rejects(runtime.start(), /database overloaded/)
  await assert.rejects(runtime.start(), /database overloaded/)
  assert.equal(calls, 1)
  nowMs += 300001
  await assert.rejects(runtime.start(), /database overloaded/)
  assert.equal(calls, 2)
})

test('v105 history reader uses one JSON-free settled-history RPC plus one latest issuance read per formal table', async () => {
  const requested = []
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    fetchImpl: async (url, init = {}) => {
      const request = new URL(url)
      requested.push({ request, init })
      if (request.pathname.endsWith('/rpc/get_v105_recent_performance_rows')) {
        return response(PRODUCTION_TABLE_IDS.flatMap((tableId) => Array.from({ length: 60 }, (_, index) => ({
          id: `${tableId}-final-${index}`,
          source: 'ofalive99', table_id: tableId, shoe_no: '1', round_no: index + 1,
          strategy_version: 'v105', predicted_result: 'banker', actual_result: 'player',
          settlement_final: true, prediction_timing: 'pre_result_context',
          prediction_issued_at: `2026-07-22T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
        }))))
      }
      const tableId = request.searchParams.get('table_id')?.replace(/^eq\./, '')
      return response([{
        source: 'ofalive99', table_id: tableId, shoe_no: '1', predicted_result: 'banker',
        prediction_timing: 'pre_result_context', issued_same_side_streak: '1',
        id: `${tableId}-latest`, round_no: 99, strategy_version: 'v105',
        prediction_issued_at: '2026-07-23T00:00:00.000Z', settlement_final: false,
        baseline_v104_predicted_result: 'player', baseline_v104_same_side_streak: '3',
      }])
    },
  })
  const rows = await client.getV105FormalHistory()
  const rpcRequests = requested.filter(({ request }) => request.pathname.endsWith('/rpc/get_v105_recent_performance_rows'))
  const stateRequests = requested.filter(({ request }) => request.pathname.endsWith('/daily_prediction_results'))
  assert.equal(requested.length, PRODUCTION_TABLE_IDS.length + 1)
  assert.equal(rpcRequests.length, 1)
  assert.equal(rpcRequests[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(rpcRequests[0].init.body), { p_per_table_limit: 60 })
  assert.equal(stateRequests.length, PRODUCTION_TABLE_IDS.length)
  assert.ok(stateRequests.every(({ request }) => request.searchParams.get('limit') === '1'))
  assert.deepEqual(new Set(stateRequests.map(({ request }) => request.searchParams.get('table_id')?.replace(/^eq\./, ''))), new Set(PRODUCTION_TABLE_IDS))
  assert.ok(rows.every((row) => row.strategy_version === 'v105'))
  const latest = rows.find((row) => row.id === 'BAG01-latest')
  assert.equal(latest.final_v105_predicted_result, 'banker')
  assert.equal(latest.predicted_result, 'player')
  assert.equal(latest.same_side_streak, 3)
})


test('v105 formal history prefers backend-only database reads for settled and latest state', async () => {
  const settled = PRODUCTION_TABLE_IDS.flatMap((tableId) => Array.from({ length: 60 }, (_, index) => ({
    id: `${tableId}-final-${index}`, source: 'ofalive99', table_id: tableId, shoe_no: '1', round_no: index + 1,
    strategy_version: 'v105', predicted_result: 'banker', actual_result: 'player', settlement_final: true,
    prediction_timing: 'pre_result_context', prediction_issued_at: `2026-07-22T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
  })))
  const queries = []
  let fetchCalls = 0
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    fetchImpl: async () => { fetchCalls += 1; throw new Error('REST must not be used') },
    strategyPool: { async query(value) {
      queries.push(value)
      if (/get_v105_recent_performance_rows/i.test(value.text)) return { rows: settled }
      return { rows: PRODUCTION_TABLE_IDS.map((tableId) => ({
        id: `${tableId}-latest`, source: 'ofalive99', table_id: tableId, shoe_no: '1', round_no: 99,
        strategy_version: 'v105', predicted_result: 'banker', settlement_final: false,
        prediction_timing: 'pre_result_context', prediction_issued_at: '2026-07-23T00:00:00.000Z',
        baseline_v104_predicted_result: 'player', baseline_v104_same_side_streak: '3', issued_same_side_streak: '1',
      })) }
    } },
  })
  const rows = await client.getV105FormalHistory()
  assert.equal(fetchCalls, 0)
  assert.equal(queries.length, 2)
  assert.equal(rows.length, 610)
  assert.deepEqual(new Set(rows.map((row) => row.table_id)), new Set(PRODUCTION_TABLE_IDS))
})

test('recent performance startup hydration uses one bounded service-only RPC for all formal tables', async () => {
  const requested = []
  const rpcRows = PRODUCTION_TABLE_IDS.map((tableId) => ({
    id: `${tableId}-final`, table_id: tableId, shoe_no: '1', round_no: 1,
    strategy_version: 'v105', predicted_result: 'banker', actual_result: 'banker',
    settlement_final: true, prediction_timing: 'pre_result_context',
    prediction_issued_at: '2026-07-24T00:00:00.000Z', created_at: '2026-07-24T00:01:00.000Z',
  }))
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    fetchImpl: async (url, init = {}) => {
      requested.push({ url: new URL(url), init })
      return response(rpcRows)
    },
  })

  const rows = await client.getRecentPredictionRows({ limit: 10000 })

  assert.equal(requested.length, 1)
  assert.equal(requested[0].url.pathname, '/rest/v1/rpc/get_v105_recent_performance_rows')
  assert.equal(requested[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(requested[0].init.body), { p_per_table_limit: 60 })
  assert.equal(rows.length, PRODUCTION_TABLE_IDS.length)
  assert.deepEqual(new Set(rows.map((row) => row.table_id)), new Set(PRODUCTION_TABLE_IDS))
})

test('recent performance startup prefers the backend-only database function over stalled REST', async () => {
  const rpcRows = PRODUCTION_TABLE_IDS.map((tableId) => ({
    id: `${tableId}-final`, table_id: tableId, shoe_no: '1', round_no: 1,
    strategy_version: 'v105', predicted_result: 'banker', actual_result: 'banker',
    settlement_final: true, prediction_timing: 'pre_result_context',
    prediction_issued_at: '2026-07-24T00:00:00.000Z', created_at: '2026-07-24T00:01:00.000Z',
  }))
  let query
  let fetchCalls = 0
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    fetchImpl: async () => { fetchCalls += 1; throw new Error('REST must not be used') },
    strategyPool: { async query(value) { query = value; return { rows: rpcRows } } },
  })
  const rows = await client.getRecentPredictionRows({ limit: 10000 })
  assert.equal(fetchCalls, 0)
  assert.match(query.text, /get_v105_recent_performance_rows\(\$1\)/i)
  assert.deepEqual(query.values, [60])
  assert.equal(rows.length, PRODUCTION_TABLE_IDS.length)
})
