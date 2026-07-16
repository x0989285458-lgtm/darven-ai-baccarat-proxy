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
  assert.equal(ALL_MT_EQUAL_STRATEGY_VERSION, 'v098.20_六階段權重門檻整合版')
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
    tie: 20,
    superSix: 40,
    bankerPair: 40,
    playerPair: 40,
    bankerDragon: 25,
    playerDragon: 25,
  })

  assert.deepEqual(nonZero(SIDE_PREDICTION_WEIGHT_PROFILES.tie), {
    tie_risk: 0.45,
    tie_count: 0.10,
    shoe_stage: 0.10,
    road_chaos: 0.15,
    remaining_rank_total: 0.20,
  })
  assert.deepEqual(nonZero(SIDE_PREDICTION_WEIGHT_PROFILES.playerPair), {
    remaining_rank_pressure: 0.20,
    table_side_history: 0.20,
    player_pair_count: 0.20,
    shoe_stage: 0.15,
    pair_risk: 0.25,
  })
  assert.deepEqual(nonZero(SIDE_PREDICTION_WEIGHT_PROFILES.bankerPair), {
    remaining_rank_pressure: 0.15,
    table_side_history: 0.10,
    banker_pair_count: 0.20,
    shoe_stage: 0.20,
    pair_risk: 0.35,
  })
  assert.deepEqual(nonZero(SIDE_PREDICTION_WEIGHT_PROFILES.superSix), {
    banker_point: 0.35,
    remaining_rank_total: 0.20,
    table_side_history: 0.35,
    shoe_stage: 0.10,
  })
  assert.deepEqual(nonZero(SIDE_PREDICTION_WEIGHT_PROFILES.playerDragon), {
    point_diff: 0.15,
    player_natural: 0.10,
    player_point: 0.35,
    remaining_rank_total: 0.30,
    big_road: 0.10,
  })
  assert.deepEqual(nonZero(SIDE_PREDICTION_WEIGHT_PROFILES.bankerDragon), {
    point_diff: 0.15,
    banker_natural: 0.10,
    banker_point: 0.35,
    remaining_rank_total: 0.30,
    big_road: 0.10,
  })

  for (const profile of Object.values(SIDE_PREDICTION_WEIGHT_PROFILES)) {
    assert.ok(Math.abs(sum(profile) - 1) < 1e-9)
  }
})
