import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ALL_MT_EQUAL_STRATEGY_VERSION,
  ALL_MT_EQUAL_MAIN_WEIGHTS,
  SIDE_PREDICTION_THRESHOLDS,
  SIDE_PREDICTION_WEIGHT_PROFILES,
} from '../src/supabase-writer.js'

const sum = (weights) => Object.values(weights).reduce((acc, value) => acc + Number(value), 0)
const nonZero = (weights) => Object.fromEntries(Object.entries(weights).filter(([, value]) => Number(value) !== 0))

test('v081 uses only the user-defined main weights and ignores previous main weights', () => {
  assert.equal(ALL_MT_EQUAL_STRATEGY_VERSION, 'v094_信心值前後端統一版')
  assert.ok(Math.abs(sum(ALL_MT_EQUAL_MAIN_WEIGHTS) - 1) < 1e-9)
  assert.deepEqual(nonZero(ALL_MT_EQUAL_MAIN_WEIGHTS), {
    ask_road_signals: 0.05,
    roadmap_trend_signals: 0.75,
    recent_practical_calibration: 0.10,
    shoe_banker_player_bias: 0.10,
  })
})

test('v081 uses user-defined side thresholds and independent side weight profiles', () => {
  assert.deepEqual(SIDE_PREDICTION_THRESHOLDS, {
    tie: 47,
    superSix: 65,
    bankerPair: 50,
    playerPair: 55,
    bankerDragon: 53,
    playerDragon: 53,
  })

  assert.deepEqual(nonZero(SIDE_PREDICTION_WEIGHT_PROFILES.tie), {
    tie_risk: 0.05,
    tie_count: 0.55,
    shoe_stage: 0.10,
    road_chaos: 0.10,
    remaining_rank_total: 0.20,
  })
  assert.deepEqual(nonZero(SIDE_PREDICTION_WEIGHT_PROFILES.playerPair), {
    remaining_rank_pressure: 0.25,
    table_side_history: 0.10,
    player_pair_count: 0.05,
    shoe_stage: 0.55,
    pair_risk: 0.05,
  })
  assert.deepEqual(nonZero(SIDE_PREDICTION_WEIGHT_PROFILES.bankerPair), {
    remaining_rank_pressure: 0.40,
    table_side_history: 0.25,
    banker_pair_count: 0.05,
    shoe_stage: 0.05,
    pair_risk: 0.25,
  })
  assert.deepEqual(nonZero(SIDE_PREDICTION_WEIGHT_PROFILES.superSix), {
    banker_point: 0.65,
    remaining_rank_total: 0.05,
    table_side_history: 0.25,
    shoe_stage: 0.05,
  })
  assert.deepEqual(nonZero(SIDE_PREDICTION_WEIGHT_PROFILES.playerDragon), {
    point_diff: 0.05,
    player_natural: 0.25,
    player_point: 0.25,
    remaining_rank_total: 0.25,
    big_road: 0.20,
  })
  assert.deepEqual(nonZero(SIDE_PREDICTION_WEIGHT_PROFILES.bankerDragon), {
    point_diff: 0.40,
    banker_natural: 0.20,
    banker_point: 0.20,
    remaining_rank_total: 0.15,
    big_road: 0.05,
  })

  for (const profile of Object.values(SIDE_PREDICTION_WEIGHT_PROFILES)) {
    assert.ok(Math.abs(sum(profile) - 1) < 1e-9)
  }
})
