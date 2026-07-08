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
  assert.equal(ALL_MT_EQUAL_STRATEGY_VERSION, 'v085_比例門檻校正版')
  assert.ok(Math.abs(sum(ALL_MT_EQUAL_MAIN_WEIGHTS) - 1) < 1e-9)
  assert.deepEqual(nonZero(ALL_MT_EQUAL_MAIN_WEIGHTS), {
    ask_road_signals: 0.5,
    roadmap_trend_signals: 0.5,
  })
})

test('v081 uses user-defined side thresholds and independent side weight profiles', () => {
  assert.deepEqual(SIDE_PREDICTION_THRESHOLDS, {
    tie: 47,
    superSix: 65,
    bankerPair: 50,
    playerPair: 50,
    bankerDragon: 53,
    playerDragon: 53,
  })

  assert.deepEqual(nonZero(SIDE_PREDICTION_WEIGHT_PROFILES.tie), {
    tie_risk: 0.40,
    tie_count: 0.25,
    shoe_stage: 0.15,
    road_chaos: 0.10,
    remaining_rank_total: 0.10,
  })
  assert.deepEqual(nonZero(SIDE_PREDICTION_WEIGHT_PROFILES.playerPair), {
    remaining_rank_pressure: 0.25,
    table_side_history: 0.30,
    player_pair_count: 0.25,
    shoe_stage: 0.10,
    pair_risk: 0.10,
  })
  assert.deepEqual(nonZero(SIDE_PREDICTION_WEIGHT_PROFILES.bankerPair), {
    remaining_rank_pressure: 0.25,
    table_side_history: 0.30,
    banker_pair_count: 0.25,
    shoe_stage: 0.10,
    pair_risk: 0.10,
  })
  assert.deepEqual(nonZero(SIDE_PREDICTION_WEIGHT_PROFILES.superSix), {
    banker_point: 0.45,
    remaining_rank_total: 0.25,
    table_side_history: 0.20,
    shoe_stage: 0.10,
  })
  assert.deepEqual(nonZero(SIDE_PREDICTION_WEIGHT_PROFILES.playerDragon), {
    point_diff: 0.35,
    player_natural: 0.25,
    player_point: 0.20,
    remaining_rank_total: 0.10,
    big_road: 0.10,
  })
  assert.deepEqual(nonZero(SIDE_PREDICTION_WEIGHT_PROFILES.bankerDragon), {
    point_diff: 0.35,
    banker_natural: 0.25,
    banker_point: 0.20,
    remaining_rank_total: 0.10,
    big_road: 0.10,
  })

  for (const profile of Object.values(SIDE_PREDICTION_WEIGHT_PROFILES)) {
    assert.ok(Math.abs(sum(profile) - 1) < 1e-9)
  }
})
