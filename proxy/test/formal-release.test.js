import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createApp } from '../src/server.js'
import {
  ALL_MT_EQUAL_MAIN_WEIGHTS,
  ALL_MT_EQUAL_STRATEGY_VERSION,
  SIDE_PREDICTION_THRESHOLDS,
  SIDE_PREDICTION_WEIGHT_PROFILES,
  buildFormalActiveStrategy,
  createSupabaseIngestionClient,
} from '../src/supabase-writer.js'

const baselineSql = readFileSync(new URL('../../frontend/supabase/schema_v100_baseline.sql', import.meta.url), 'utf8')
const latestOnlySql = readFileSync(new URL('../../frontend/supabase/schema_v102_latest_only.sql', import.meta.url), 'utf8')
const rollbackSql = readFileSync(new URL('../../frontend/supabase/rollback_v102_to_v101.sql', import.meta.url), 'utf8')

function response(payload) {
  return { ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload }
}

test('v102 formal runtime exposes the exact release identity, approved main weights, and approved side thresholds', async () => {
  assert.match(baselineSql, /v100[\s\S]*active/i)
  assert.match(latestOnlySql, /v102/)
  assert.match(rollbackSql, /status\s*=\s*'archived'[\s\S]*version\s*=\s*'v101'/i)
  assert.equal(ALL_MT_EQUAL_STRATEGY_VERSION, 'v102')
  assert.deepEqual(ALL_MT_EQUAL_MAIN_WEIGHTS, {
    roadmap_trend_signals: 0.35, ask_road_signals: 0.15,
    recent_practical_calibration: 0.30, shoe_banker_player_bias: 0.10, neutral_reserve: 0.10,
  })
  assert.deepEqual(SIDE_PREDICTION_THRESHOLDS, {
    tie: 30, superSix: 50, bankerPair: 50, playerPair: 50, bankerDragon: 40, playerDragon: 40,
  })
  assert.equal(buildFormalActiveStrategy().version, 'v102')
  assert.equal(buildFormalActiveStrategy().status, 'active')
  assert.deepEqual(buildFormalActiveStrategy().metrics.side_weights, Object.fromEntries(Object.entries(SIDE_PREDICTION_WEIGHT_PROFILES).map(([key, value]) => [key, { ...value }])))

  const app = createApp({ autoConnect: false })
  const health = JSON.parse((await app.inject({ url: '/health' })).body)
  assert.equal(health.buildVersion, 'v102')
})

test('v102 history derives tie display only from complete persisted v102 evidence and rejects predecessors', async () => {
  const requests = []
  const rows = [
    {
      id: 'tie-action-miss', table_id: 'BAG01', shoe_no: '88', round_no: 13, strategy_version: 'v102',
      predicted_result: 'banker', actual_result: 'banker', is_hit: true, settlement_final: true,
      side_hits: { tie: false }, prediction_features: { prediction_timing: 'pre_result_context', side_actions: { tie: true }, side_hits: { tie: false } },
    },
    {
      id: 'tie-action-predecessor', table_id: 'BAG01', shoe_no: '88', round_no: 12, strategy_version: 'v098.20_六階段權重門檻整合版',
      predicted_result: 'banker', actual_result: 'tie', is_hit: false, settlement_final: true,
      side_hits: { tie: false }, prediction_features: { prediction_timing: 'pre_result_context', side_actions: { tie: false }, side_hits: { tie: false } },
    },
    {
      id: 'tie-action', table_id: 'BAG01', shoe_no: '88', round_no: 12, strategy_version: 'v102',
      predicted_result: 'player', actual_result: 'tie', is_hit: false, settlement_final: true,
      side_hits: { tie: true }, prediction_features: { prediction_timing: 'pre_result_context', side_actions: { tie: true }, side_hits: { tie: true } },
    },
    {
      id: 'tie-no-action', table_id: 'BAG01', shoe_no: '88', round_no: 11, strategy_version: 'v102',
      predicted_result: 'banker', actual_result: 'tie', is_hit: false, settlement_final: true,
      side_hits: { tie: false }, prediction_features: { prediction_timing: 'pre_result_context', side_actions: { tie: false }, side_hits: { tie: false } },
    },
    {
      id: 'legacy-no-evidence', table_id: 'BAG01', shoe_no: '88', round_no: 10, strategy_version: 'v098.20_六階段權重門檻整合版',
      predicted_result: 'banker', actual_result: 'tie', is_hit: false, settlement_final: true,
      prediction_features: { prediction_timing: 'pre_result_context' },
    },
  ]
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    fetchImpl: async (url) => { requests.push(String(url)); return response(rows) },
  })

  const history = await client.getTableUiSettledPredictions({ tableId: 'BAG01', shoe: 88, limit: 10 })
  assert.match(decodeURIComponent(requests[0]), /strategy_version=eq\.v102/)
  assert.deepEqual(history, [
    { round: 13, mainPredictedResult: 'banker', predictedResult: 'banker', actualResult: 'banker', isHit: true, result: 'hit' },
    { round: 12, mainPredictedResult: 'player', predictedResult: 'tie', actualResult: 'tie', isHit: true, result: 'hit' },
    { round: 11, mainPredictedResult: 'banker', predictedResult: 'banker', actualResult: 'tie', isHit: false, result: 'uncalculated' },

  ])
})

test('v102 recent calibration hydration queries only the current formal release', async () => {
  let requestedUrl = ''
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    fetchImpl: async (url) => { requestedUrl = decodeURIComponent(String(url)); return response([]) },
  })

  await client.getRecentPredictionRows({ limit: 18 })

  assert.match(requestedUrl, /strategy_version=eq\.v102/)
})
