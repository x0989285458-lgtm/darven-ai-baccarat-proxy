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
  assert.equal(ALL_MT_EQUAL_STRATEGY_VERSION, 'v083_副預測門檻調整版')
  assert.ok(Math.abs(sum(ALL_MT_EQUAL_MAIN_WEIGHTS) - 1) < 1e-9)
  assert.deepEqual(nonZero(ALL_MT_EQUAL_MAIN_WEIGHTS), {
    ask_road_signals: 0.6,
    roadmap_trend_signals: 0.4,
  })
})

test('v081 uses user-defined side thresholds and independent side weight profiles', () => {
  assert.deepEqual(SIDE_PREDICTION_THRESHOLDS, {
    tie: 45,
    superSix: 45,
    bankerPair: 30,
    playerPair: 30,
    bankerDragon: 40,
    playerDragon: 40,
  })

  assert.deepEqual(nonZero(SIDE_PREDICTION_WEIGHT_PROFILES.tie), {
    tie_risk: 0.30,
    remaining_rank_total: 0.30,
    shoe_stage: 0.15,
    tie_count: 0.10,
    road_chaos: 0.15,
  })
  assert.deepEqual(nonZero(SIDE_PREDICTION_WEIGHT_PROFILES.playerPair), {
    pair_risk: 0.40,
    remaining_rank_pressure: 0.35,
    shoe_stage: 0.10,
    player_pair_count: 0.15,
  })
  assert.deepEqual(nonZero(SIDE_PREDICTION_WEIGHT_PROFILES.bankerPair), {
    pair_risk: 0.40,
    remaining_rank_pressure: 0.35,
    shoe_stage: 0.10,
    banker_pair_count: 0.15,
  })
  assert.deepEqual(nonZero(SIDE_PREDICTION_WEIGHT_PROFILES.superSix), {
    banker_point: 0.30,
    remaining_rank_total: 0.30,
    shoe_stage: 0.10,
    table_side_history: 0.10,
    super_six: 0.20,
  })
  assert.deepEqual(nonZero(SIDE_PREDICTION_WEIGHT_PROFILES.playerDragon), {
    player_point: 0.25,
    remaining_rank_total: 0.25,
    shoe_stage: 0.10,
    table_side_history: 0.10,
    player_dragon: 0.30,
  })
  assert.deepEqual(nonZero(SIDE_PREDICTION_WEIGHT_PROFILES.bankerDragon), {
    banker_point: 0.25,
    remaining_rank_total: 0.25,
    shoe_stage: 0.10,
    table_side_history: 0.10,
    banker_dragon: 0.30,
  })

  for (const profile of Object.values(SIDE_PREDICTION_WEIGHT_PROFILES)) {
    assert.ok(Math.abs(sum(profile) - 1) < 1e-9)
  }
})
