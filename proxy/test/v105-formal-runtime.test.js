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

test('v105 history reader requires 60 Final rows and the latest issuance state independently for every formal table', async () => {
  const requested = []
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    fetchImpl: async (url) => {
      const request = new URL(url)
      requested.push(request)
      const tableId = request.searchParams.get('table_id')?.replace(/^eq\./, '')
      const base = {
        source: 'ofalive99', table_id: tableId, shoe_no: '1', predicted_result: 'banker',
        prediction_timing: 'pre_result_context', issued_same_side_streak: '1',
      }
      if (request.searchParams.get('settlement_final') === 'eq.true') {
        return response(Array.from({ length: 70 }, (_, index) => ({
          ...base,
          id: `${tableId}-final-${index}`,
          round_no: index + 1,
          strategy_version: index === 0 ? 'v105' : 'v104',
          prediction_issued_at: `2026-07-22T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
          settlement_final: true,
          baseline_v104_predicted_result: index === 0 ? 'player' : null,
          baseline_v104_same_side_streak: index === 0 ? '3' : null,
        })))
      }
      return response([{
        ...base,
        id: `${tableId}-latest`,
        round_no: 99,
        strategy_version: 'v105',
        prediction_issued_at: '2026-07-23T00:00:00.000Z',
        settlement_final: false,
        baseline_v104_predicted_result: 'player',
        baseline_v104_same_side_streak: '3',
      }])
    },
  })
  const rows = await client.getV105FormalHistory()
  const finalRequests = requested.filter((request) => request.searchParams.get('settlement_final') === 'eq.true')
  const stateRequests = requested.filter((request) => request.searchParams.get('settlement_final') == null)
  assert.equal(requested.length, PRODUCTION_TABLE_IDS.length * 2)
  assert.equal(finalRequests.length, PRODUCTION_TABLE_IDS.length)
  assert.equal(stateRequests.length, PRODUCTION_TABLE_IDS.length)
  assert.ok(finalRequests.every((request) => request.searchParams.get('limit') === '70'))
  assert.ok(stateRequests.every((request) => request.searchParams.get('limit') === '1'))
  assert.deepEqual(new Set(finalRequests.map((request) => request.searchParams.get('table_id')?.replace(/^eq\./, ''))), new Set(PRODUCTION_TABLE_IDS))
  assert.ok(rows.every((row) => ['v104', 'v105'].includes(row.strategy_version)))
  const latest = rows.find((row) => row.id === 'BAG01-latest')
  assert.equal(latest.final_v105_predicted_result, 'banker')
  assert.equal(latest.predicted_result, 'player')
  assert.equal(latest.same_side_streak, 3)
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
