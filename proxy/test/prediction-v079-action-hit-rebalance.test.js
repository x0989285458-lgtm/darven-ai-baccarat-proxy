import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ALL_MT_EQUAL_STRATEGY_VERSION,
  ALL_MT_EQUAL_MAIN_WEIGHTS,
  SIDE_PREDICTION_THRESHOLDS,
  SIDE_PREDICTION_WEIGHT_PROFILES,
} from '../src/supabase-writer.js'

const sum = (weights) => Object.values(weights).reduce((acc, value) => acc + Number(value), 0)

test('v079 rebalances main prediction away from noisy road overfit toward calibration and history', () => {
  assert.equal(ALL_MT_EQUAL_STRATEGY_VERSION, 'v098_主信心實際命中校準版')
  assert.ok(Math.abs(sum(ALL_MT_EQUAL_MAIN_WEIGHTS) - 1) < 1e-9)
  assert.equal(Object.hasOwn(ALL_MT_EQUAL_MAIN_WEIGHTS, 'remaining_zero_to_k_total'), false)

  assert.equal(ALL_MT_EQUAL_MAIN_WEIGHTS.ask_road_signals, 0.15)
  assert.equal(ALL_MT_EQUAL_MAIN_WEIGHTS.roadmap_trend_signals, 0.55)
  assert.equal(ALL_MT_EQUAL_MAIN_WEIGHTS.direction_calibration, 0)
  assert.equal(ALL_MT_EQUAL_MAIN_WEIGHTS.table_recent_hit_rate, 0)
  assert.equal(ALL_MT_EQUAL_MAIN_WEIGHTS.historical_backtest, 0)
})

test('v079 loosens side prediction thresholds and strengthens side aggregate rank signal', () => {
  assert.deepEqual(SIDE_PREDICTION_THRESHOLDS, {
    tie: 42,
    superSix: 60,
    bankerPair: 48,
    playerPair: 50,
    bankerDragon: 48,
    playerDragon: 52,
  })
  assert.equal(SIDE_PREDICTION_WEIGHT_PROFILES.superSix.remaining_rank_total, 0.20)
  assert.equal(SIDE_PREDICTION_WEIGHT_PROFILES.bankerPair.remaining_rank_total, 0)
  assert.equal(SIDE_PREDICTION_WEIGHT_PROFILES.playerPair.remaining_rank_total, 0)
  assert.equal(SIDE_PREDICTION_WEIGHT_PROFILES.bankerDragon.remaining_rank_total, 0.30)
  assert.equal(SIDE_PREDICTION_WEIGHT_PROFILES.playerDragon.remaining_rank_total, 0.30)
  for (const profile of Object.values(SIDE_PREDICTION_WEIGHT_PROFILES)) {
    assert.ok(Math.abs(sum(profile) - 1) < 1e-9)
  }
})
