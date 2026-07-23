import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ALL_MT_EQUAL_STRATEGY_VERSION,
  ALL_MT_EQUAL_MAIN_WEIGHTS,
  SIDE_PREDICTION_THRESHOLDS,
  SIDE_PREDICTION_WEIGHT_PROFILES,
} from '../src/supabase-writer.js'

const sum = (weights) => Object.values(weights).reduce((acc, value) => acc + Number(value), 0)

test('raises empirically higher-hit main features and suppresses weak road noise', () => {
  assert.equal(ALL_MT_EQUAL_STRATEGY_VERSION, 'v105')
  assert.ok(Math.abs(sum(ALL_MT_EQUAL_MAIN_WEIGHTS) - 1) < 1e-9)

  assert.equal(ALL_MT_EQUAL_MAIN_WEIGHTS.ask_road_signals, 0.15)
  assert.equal(ALL_MT_EQUAL_MAIN_WEIGHTS.roadmap_trend_signals, 0.35)
  assert.equal(ALL_MT_EQUAL_MAIN_WEIGHTS.recent_practical_calibration, 0.30)
  assert.equal(ALL_MT_EQUAL_MAIN_WEIGHTS.neutral_reserve, 0.10)
})

test('side prediction thresholds match observed score ceilings', () => {
  assert.deepEqual(SIDE_PREDICTION_THRESHOLDS, {
    tie: 30,
    superSix: 50,
    bankerPair: 50,
    playerPair: 50,
    bankerDragon: 40,
    playerDragon: 40,
  })
  assert.equal(SIDE_PREDICTION_WEIGHT_PROFILES.superSix.remaining_rank_total, 0.20)
  assert.equal(SIDE_PREDICTION_WEIGHT_PROFILES.bankerPair.remaining_rank_total, 0)
  assert.equal(SIDE_PREDICTION_WEIGHT_PROFILES.playerPair.remaining_rank_total, 0)
  for (const profile of Object.values(SIDE_PREDICTION_WEIGHT_PROFILES)) {
    assert.ok(Math.abs(sum(profile) - 1) < 1e-9)
  }
})
