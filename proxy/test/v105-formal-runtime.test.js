import test from 'node:test'
import assert from 'node:assert/strict'
import { createV105FormalRuntime } from '../src/v105-formal-runtime.js'
import { createSupabaseIngestionClient } from '../src/supabase-writer.js'

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

test('v105 history reader warm-starts from v104 and v105 while rejecting older strategies', async () => {
  let requested
  const base = {
    source: 'ofalive99', table_id: 'BAG01', shoe_no: '1', round_no: 8,
    predicted_result: 'banker', prediction_issued_at: '2026-07-22T00:00:00.000Z',
    prediction_timing: 'pre_result_context', issued_same_side_streak: '1', settlement_final: true,
  }
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    fetchImpl: async (url) => { requested = new URL(url); return response([
      { ...base, id: 'old', strategy_version: 'v103' },
      { ...base, id: 'predecessor', strategy_version: 'v104' },
      { ...base, id: 'current', strategy_version: 'v105', baseline_v104_predicted_result: 'player', baseline_v104_same_side_streak: '3' },
    ]) },
  })
  const rows = await client.getV105FormalHistory()
  assert.equal(requested.searchParams.get('strategy_version'), 'in.(v104,v105)')
  assert.deepEqual(rows.map((row) => row.strategy_version), ['v104', 'v105'])
  assert.equal(rows[1].final_v105_predicted_result, 'banker')
  assert.equal(rows[1].predicted_result, 'player')
  assert.equal(rows[1].same_side_streak, 3)
})
