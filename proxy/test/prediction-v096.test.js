import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ALL_MT_EQUAL_STRATEGY_VERSION,
  SIDE_PREDICTION_THRESHOLDS,
  SIDE_PREDICTION_WEIGHT_PROFILES,
  calibrateMainConfidenceV096,
} from '../src/supabase-writer.js'

const expectedProfiles = {
  tie: { tie_risk: 0.25, tie_count: 0.35, shoe_stage: 0.05, road_chaos: 0.25, remaining_rank_total: 0.10 },
  superSix: { banker_point: 0.45, remaining_rank_total: 0.10, table_side_history: 0.40, shoe_stage: 0.05 },
  bankerPair: { remaining_rank_pressure: 0.50, table_side_history: 0.10, banker_pair_count: 0.10, shoe_stage: 0.05, pair_risk: 0.25 },
  playerPair: { remaining_rank_pressure: 0.45, table_side_history: 0.10, player_pair_count: 0.10, shoe_stage: 0.10, pair_risk: 0.25 },
  bankerDragon: { point_diff: 0.35, banker_natural: 0.25, banker_point: 0.25, remaining_rank_total: 0.10, big_road: 0.05 },
  playerDragon: { point_diff: 0.35, player_natural: 0.25, player_point: 0.25, remaining_rank_total: 0.10, big_road: 0.05 },
}

test('v096 uses the approved Traditional Chinese strategy name and side thresholds', () => {
  assert.equal(ALL_MT_EQUAL_STRATEGY_VERSION, 'v096_副預測權重與信心校準版')
  assert.deepEqual(SIDE_PREDICTION_THRESHOLDS, {
    tie: 47,
    superSix: 65,
    bankerPair: 53,
    playerPair: 55,
    bankerDragon: 53,
    playerDragon: 57,
  })
})

test('v096 side profiles keep only the approved existing weighted items and each sum to one', () => {
  for (const [target, expected] of Object.entries(expectedProfiles)) {
    const profile = SIDE_PREDICTION_WEIGHT_PROFILES[target]
    const active = Object.fromEntries(Object.entries(profile).filter(([, weight]) => weight > 0))
    assert.deepEqual(active, expected, `${target} active weights`)
    assert.ok(Math.abs(Object.values(profile).reduce((sum, weight) => sum + weight, 0) - 1) < 1e-9, `${target} sum`)
  }
})

test('v096 maps raw main confidence through the approved linear calibration', () => {
  assert.deepEqual([30, 31, 32, 33, 34].map(calibrateMainConfidenceV096), [41, 43, 45, 47, 49])
  assert.equal(calibrateMainConfidenceV096(-100), 30)
  assert.equal(calibrateMainConfidenceV096(100), 70)
})
