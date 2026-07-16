import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ALL_MT_EQUAL_STRATEGY_VERSION,
  ALL_MT_EQUAL_MAIN_WEIGHTS,
  SIDE_PREDICTION_THRESHOLDS,
  SIDE_PREDICTION_WEIGHT_PROFILES,
  buildFormalActiveStrategy,
  buildLivePrediction,
} from '../src/supabase-writer.js'
import { FORMAL_MAIN_PREDICTION_WEIGHTS } from '../src/stable-report.js'

const sum = (weights) => Object.values(weights).reduce((acc, value) => acc + Number(value), 0)
const nonZero = (weights) => Object.fromEntries(Object.entries(weights).filter(([, value]) => Number(value) !== 0))

test('v081 uses only the user-defined main weights and ignores previous main weights', () => {
  assert.equal(ALL_MT_EQUAL_STRATEGY_VERSION, 'v098_主信心實際命中校準版')
  assert.ok(Math.abs(sum(ALL_MT_EQUAL_MAIN_WEIGHTS) - 1) < 1e-9)
  assert.deepEqual(nonZero(ALL_MT_EQUAL_MAIN_WEIGHTS), {
    ask_road_signals: 0.15,
    roadmap_trend_signals: 0.55,
    recent_practical_calibration: 0.20,
    shoe_banker_player_bias: 0.10,
  })
  assert.deepEqual(buildFormalActiveStrategy().metrics.main_weights, ALL_MT_EQUAL_MAIN_WEIGHTS)
  assert.deepEqual(buildLivePrediction({ tableId: 'BAG01', shoe: 1, round: 0 }).featureWeights, ALL_MT_EQUAL_MAIN_WEIGHTS)
  assert.strictEqual(FORMAL_MAIN_PREDICTION_WEIGHTS, ALL_MT_EQUAL_MAIN_WEIGHTS)
})

test('v081 uses user-defined side thresholds and independent side weight profiles', () => {
  assert.deepEqual(SIDE_PREDICTION_THRESHOLDS, {
    tie: 42,
    superSix: 60,
    bankerPair: 48,
    playerPair: 50,
    bankerDragon: 48,
    playerDragon: 52,
  })

  assert.deepEqual(nonZero(SIDE_PREDICTION_WEIGHT_PROFILES.tie), {
    tie_risk: 0.65,
    tie_count: 0.05,
    shoe_stage: 0.05,
    road_chaos: 0.05,
    remaining_rank_total: 0.20,
  })
  assert.deepEqual(nonZero(SIDE_PREDICTION_WEIGHT_PROFILES.playerPair), {
    remaining_rank_pressure: 0.15,
    table_side_history: 0.35,
    player_pair_count: 0.15,
    shoe_stage: 0.30,
    pair_risk: 0.05,
  })
  assert.deepEqual(nonZero(SIDE_PREDICTION_WEIGHT_PROFILES.bankerPair), {
    remaining_rank_pressure: 0.05,
    table_side_history: 0.05,
    banker_pair_count: 0.10,
    shoe_stage: 0.50,
    pair_risk: 0.30,
  })
  assert.deepEqual(nonZero(SIDE_PREDICTION_WEIGHT_PROFILES.superSix), {
    banker_point: 0.40,
    remaining_rank_total: 0.15,
    table_side_history: 0.40,
    shoe_stage: 0.05,
  })
  assert.deepEqual(nonZero(SIDE_PREDICTION_WEIGHT_PROFILES.playerDragon), {
    point_diff: 0.05,
    player_natural: 0.05,
    player_point: 0.45,
    remaining_rank_total: 0.40,
    big_road: 0.05,
  })
  assert.deepEqual(nonZero(SIDE_PREDICTION_WEIGHT_PROFILES.bankerDragon), {
    point_diff: 0.10,
    banker_natural: 0.05,
    banker_point: 0.40,
    remaining_rank_total: 0.35,
    big_road: 0.10,
  })

  for (const profile of Object.values(SIDE_PREDICTION_WEIGHT_PROFILES)) {
    assert.ok(Math.abs(sum(profile) - 1) < 1e-9)
  }
})
