import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ALL_MT_EQUAL_STRATEGY_VERSION,
  ALL_MT_EQUAL_MAIN_WEIGHTS,
  SIDE_PREDICTION_THRESHOLDS,
  SIDE_PREDICTION_WEIGHT_PROFILES,
} from '../src/supabase-writer.js'

const sum = (weights) => Object.values(weights).reduce((acc, value) => acc + Number(value), 0)

test('v080 raises empirically higher-hit main features and suppresses weak road noise', () => {
  assert.equal(ALL_MT_EQUAL_STRATEGY_VERSION, 'v080_高勝率主權重副預測修正版')
  assert.ok(Math.abs(sum(ALL_MT_EQUAL_MAIN_WEIGHTS) - 1) < 1e-9)

  assert.ok(ALL_MT_EQUAL_MAIN_WEIGHTS.big_road >= 0.105)
  assert.ok(ALL_MT_EQUAL_MAIN_WEIGHTS.shoe_stage >= 0.03)
  assert.ok(ALL_MT_EQUAL_MAIN_WEIGHTS.near5_banker_player_bias >= 0.02)
  assert.ok(ALL_MT_EQUAL_MAIN_WEIGHTS.next_banker_road >= 0.02)
  assert.ok(ALL_MT_EQUAL_MAIN_WEIGHTS.road_structure_signals >= 0.075)

  assert.ok(ALL_MT_EQUAL_MAIN_WEIGHTS.next_player_road <= 0.001)
  assert.ok(ALL_MT_EQUAL_MAIN_WEIGHTS.big_eye_road <= 0.002)
  assert.equal(ALL_MT_EQUAL_MAIN_WEIGHTS.small_road, 0)
  assert.equal(ALL_MT_EQUAL_MAIN_WEIGHTS.cockroach_road, 0)
  assert.ok(ALL_MT_EQUAL_MAIN_WEIGHTS.derived_road_structure_signals <= 0.035)
})

test('v080 side prediction thresholds match observed score ceilings', () => {
  assert.deepEqual(SIDE_PREDICTION_THRESHOLDS, {
    tie: 20,
    superSix: 20,
    bankerPair: 20,
    playerPair: 20,
    bankerDragon: 20,
    playerDragon: 20,
  })
  assert.ok(SIDE_PREDICTION_WEIGHT_PROFILES.superSix.remaining_rank_total >= 0.32)
  assert.ok(SIDE_PREDICTION_WEIGHT_PROFILES.bankerPair.remaining_rank_total >= 0.13)
  assert.ok(SIDE_PREDICTION_WEIGHT_PROFILES.playerPair.remaining_rank_total >= 0.13)
  for (const profile of Object.values(SIDE_PREDICTION_WEIGHT_PROFILES)) {
    assert.ok(Math.abs(sum(profile) - 1) < 1e-9)
  }
})
