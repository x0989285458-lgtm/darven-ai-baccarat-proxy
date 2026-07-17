import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createApp } from '../src/server.js'
import {
  ALL_MT_EQUAL_MAIN_WEIGHTS,
  ALL_MT_EQUAL_STRATEGY_VERSION,
  SIDE_PREDICTION_THRESHOLDS,
  SIDE_PREDICTION_WEIGHT_PROFILES,
  buildFormalActiveStrategy,
  createSupabaseIngestionClient,
} from '../src/supabase-writer.js'

const migrationUrl = new URL('../../frontend/supabase/schema_v98_formal_release.sql', import.meta.url)
const rollbackUrl = new URL('../../frontend/supabase/rollback_v98_formal_release.sql', import.meta.url)

function response(payload) {
  return { ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload }
}

test('v98 formal runtime exposes the exact release identity, approved main weights, and approved side thresholds', async () => {
  assert.equal(ALL_MT_EQUAL_STRATEGY_VERSION, 'v98')
  assert.deepEqual(ALL_MT_EQUAL_MAIN_WEIGHTS, {
    table_type: 0, total_players: 0, state: 0, source_updated_at: 0,
    shoe: 0, shoe_stage: 0, banker_count: 0, player_count: 0, tie_count: 0,
    bead_road: 0, big_road: 0, big_eye_road: 0, small_road: 0, cockroach_road: 0, next_banker_road: 0, next_player_road: 0,
    previous_winner: 0, streak_length: 0, near5_banker_player_bias: 0, table_recent_hit_rate: 0, direction_calibration: 0,
    confidence: 0, probability_gap: 0, card_points: 0, shoe_remaining_points: 0, historical_backtest: 0,
    roadmap_trend_signals: 0.45, road_structure_signals: 0, derived_road_structure_signals: 0, ask_road_signals: 0.25,
    recent_practical_calibration: 0.20, shoe_banker_player_bias: 0.10,
  })
  assert.deepEqual(SIDE_PREDICTION_THRESHOLDS, {
    tie: 25, superSix: 45, bankerPair: 43, playerPair: 43, bankerDragon: 30, playerDragon: 30,
  })
  assert.equal(buildFormalActiveStrategy().version, 'v98')
  assert.equal(buildFormalActiveStrategy().status, 'active')
  assert.deepEqual(buildFormalActiveStrategy().metrics.side_weights, Object.fromEntries(Object.entries(SIDE_PREDICTION_WEIGHT_PROFILES).map(([key, value]) => [key, { ...value }])))

  const app = createApp({ autoConnect: false })
  const health = JSON.parse((await app.inject({ url: '/health' })).body)
  assert.equal(health.buildVersion, 'v98')
})

test('v98 history derives tie display only from complete persisted tie action/hit evidence and includes the compatible predecessor', async () => {
  const requests = []
  const rows = [
    {
      id: 'tie-action-miss', table_id: 'BAG01', shoe_no: '88', round_no: 13, strategy_version: 'v98',
      predicted_result: 'banker', actual_result: 'banker', is_hit: true, settlement_final: true,
      side_hits: { tie: false }, prediction_features: { prediction_timing: 'pre_result_context', side_actions: { tie: true }, side_hits: { tie: false } },
    },
    {
      id: 'tie-action-predecessor', table_id: 'BAG01', shoe_no: '88', round_no: 12, strategy_version: 'v098.20_六階段權重門檻整合版',
      predicted_result: 'banker', actual_result: 'tie', is_hit: false, settlement_final: true,
      side_hits: { tie: false }, prediction_features: { prediction_timing: 'pre_result_context', side_actions: { tie: false }, side_hits: { tie: false } },
    },
    {
      id: 'tie-action', table_id: 'BAG01', shoe_no: '88', round_no: 12, strategy_version: 'v98',
      predicted_result: 'player', actual_result: 'tie', is_hit: false, settlement_final: true,
      side_hits: { tie: true }, prediction_features: { prediction_timing: 'pre_result_context', side_actions: { tie: true }, side_hits: { tie: true } },
    },
    {
      id: 'tie-no-action', table_id: 'BAG01', shoe_no: '88', round_no: 11, strategy_version: 'v098.20_六階段權重門檻整合版',
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
  assert.match(decodeURIComponent(requests[0]), /strategy_version=in\.\(v98,v098\.20_/)
  assert.deepEqual(history, [
    { round: 13, mainPredictedResult: 'banker', predictedResult: 'tie', actualResult: 'banker', isHit: false, result: 'miss' },
    { round: 12, mainPredictedResult: 'player', predictedResult: 'tie', actualResult: 'tie', isHit: true, result: 'hit' },
    { round: 11, mainPredictedResult: 'banker', predictedResult: 'banker', actualResult: 'tie', isHit: false, result: 'uncalculated' },
    { round: 10, predictedResult: 'banker', actualResult: 'tie', isHit: false },
  ])
})

test('v98 recent calibration hydration includes the formal release and compatible predecessor rows', async () => {
  let requestedUrl = ''
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    fetchImpl: async (url) => { requestedUrl = decodeURIComponent(String(url)); return response([]) },
  })

  await client.getRecentPredictionRows({ limit: 18 })

  assert.match(requestedUrl, /strategy_version=in\.\([^)]*v98[^)]*v098\.20_/)
})

test('v98 additive migration activates exactly one formal strategy with rollback metadata', () => {
  assert.equal(existsSync(migrationUrl), true, 'v98 formal migration must exist')
  assert.equal(existsSync(rollbackUrl), true, 'v98 formal rollback must exist')
  const sql = readFileSync(migrationUrl, 'utf8')
  assert.match(sql, /insert into public\.ai_strategy_versions[\s\S]+?'v98'[\s\S]+?main_weights[\s\S]+?0\.25[\s\S]+?0\.45[\s\S]+?side_thresholds/is)
  assert.match(sql, /update public\.ai_strategy_versions[\s\S]+status\s*=\s*'archived'[\s\S]+status\s*=\s*'active'/i)
  assert.match(sql, /count\(\*\)[\s\S]+status\s*=\s*'active'[\s\S]+<>\s*1/i)
  assert.match(sql, /v98_formal_release_previous_active/i)
  assert.match(sql, /delete from public\.v98_formal_release_previous_active[\s\S]+insert into public\.v98_formal_release_previous_active/i)
  const rollback = readFileSync(rollbackUrl, 'utf8')
  assert.match(rollback, /v98_formal_release_previous_active/i)
  assert.match(rollback, /set status\s*=\s*'archived'[\s\S]+version\s*=\s*'v98'/i)
  assert.doesNotMatch(rollback, /drop\s+(table|column)|truncate/i)
})
