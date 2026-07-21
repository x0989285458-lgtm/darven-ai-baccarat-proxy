import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ALL_MT_EQUAL_STRATEGY_VERSION,
  SIDE_PREDICTION_THRESHOLDS,
  SIDE_PREDICTION_WEIGHT_PROFILES,
  calibrateMainConfidenceV096,
  buildLivePrediction,
} from '../src/supabase-writer.js'

const expectedProfiles = {
  tie: { tie_risk: 0.45, tie_count: 0.10, shoe_stage: 0.10, road_chaos: 0.15, remaining_rank_total: 0.20 },
  superSix: { banker_point: 0.35, remaining_rank_total: 0.20, table_side_history: 0.35, shoe_stage: 0.10 },
  bankerPair: { remaining_rank_pressure: 0.15, table_side_history: 0.10, banker_pair_count: 0.20, shoe_stage: 0.20, pair_risk: 0.35 },
  playerPair: { remaining_rank_pressure: 0.20, table_side_history: 0.20, player_pair_count: 0.20, shoe_stage: 0.15, pair_risk: 0.25 },
  bankerDragon: { point_diff: 0.15, banker_natural: 0.10, banker_point: 0.35, remaining_rank_total: 0.30, big_road: 0.10 },
  playerDragon: { point_diff: 0.15, player_natural: 0.10, player_point: 0.35, remaining_rank_total: 0.30, big_road: 0.10 },
}

test('uses the approved Traditional Chinese strategy name and side thresholds', () => {
  assert.equal(ALL_MT_EQUAL_STRATEGY_VERSION, 'v104')
  assert.deepEqual(SIDE_PREDICTION_THRESHOLDS, {
    tie: 30,
    superSix: 50,
    bankerPair: 50,
    playerPair: 50,
    bankerDragon: 40,
    playerDragon: 40,
  })
})

test('side profiles keep only the approved existing weighted items and each sum to one', () => {
  for (const [target, expected] of Object.entries(expectedProfiles)) {
    const profile = SIDE_PREDICTION_WEIGHT_PROFILES[target]
    const active = Object.fromEntries(Object.entries(profile).filter(([, weight]) => weight > 0))
    assert.deepEqual(active, expected, `${target} active weights`)
    assert.ok(Math.abs(Object.values(profile).reduce((sum, weight) => sum + weight, 0) - 1) < 1e-9, `${target} sum`)
  }
})

test('live prediction emits only the approved strategy instead of a fallback', () => {
  const prediction = buildLivePrediction({ tableId: 'BAG97', shoe: 1, round: 0 })
  assert.equal(prediction.strategyVersion, 'v104')
  assert.equal(prediction.strategyVersion.includes('v096'), false)
})

test('maps raw main confidence through the approved linear calibration', () => {
  assert.deepEqual([30, 31, 32, 33, 34].map(calibrateMainConfidenceV096), [41, 43, 45, 47, 49])
  assert.equal(calibrateMainConfidenceV096(-100), 30)
  assert.equal(calibrateMainConfidenceV096(100), 70)
})

test('applies calibration to neutral live predictions instead of leaving them at 30', () => {
  const prediction = buildLivePrediction({ tableId: 'BAG00', shoe: 1, round: 0 })
  assert.equal(prediction.confidence, 46)
})
