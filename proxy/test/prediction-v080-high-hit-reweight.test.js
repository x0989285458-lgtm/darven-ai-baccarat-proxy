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
  assert.equal(ALL_MT_EQUAL_STRATEGY_VERSION, 'v085_比例門檻校正版')
  assert.ok(Math.abs(sum(ALL_MT_EQUAL_MAIN_WEIGHTS) - 1) < 1e-9)

  assert.equal(ALL_MT_EQUAL_MAIN_WEIGHTS.ask_road_signals, 0.5)
  assert.equal(ALL_MT_EQUAL_MAIN_WEIGHTS.roadmap_trend_signals, 0.5)
  assert.equal(ALL_MT_EQUAL_MAIN_WEIGHTS.big_road, 0)
  assert.equal(ALL_MT_EQUAL_MAIN_WEIGHTS.shoe_stage, 0)
  assert.equal(ALL_MT_EQUAL_MAIN_WEIGHTS.next_banker_road, 0)
  assert.equal(ALL_MT_EQUAL_MAIN_WEIGHTS.road_structure_signals, 0)
  assert.equal(ALL_MT_EQUAL_MAIN_WEIGHTS.derived_road_structure_signals, 0)
})

test('v080 side prediction thresholds match observed score ceilings', () => {
  assert.deepEqual(SIDE_PREDICTION_THRESHOLDS, {
    tie: 47,
    superSix: 65,
    bankerPair: 50,
    playerPair: 50,
    bankerDragon: 53,
    playerDragon: 53,
  })
  assert.equal(SIDE_PREDICTION_WEIGHT_PROFILES.superSix.remaining_rank_total, 0.25)
  assert.equal(SIDE_PREDICTION_WEIGHT_PROFILES.bankerPair.remaining_rank_total, 0)
  assert.equal(SIDE_PREDICTION_WEIGHT_PROFILES.playerPair.remaining_rank_total, 0)
  for (const profile of Object.values(SIDE_PREDICTION_WEIGHT_PROFILES)) {
    assert.ok(Math.abs(sum(profile) - 1) < 1e-9)
  }
})
