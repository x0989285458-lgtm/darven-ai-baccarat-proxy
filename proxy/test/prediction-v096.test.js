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
  tie: { tie_risk: 0.65, tie_count: 0.05, shoe_stage: 0.05, road_chaos: 0.05, remaining_rank_total: 0.20 },
  superSix: { banker_point: 0.40, remaining_rank_total: 0.15, table_side_history: 0.40, shoe_stage: 0.05 },
  bankerPair: { remaining_rank_pressure: 0.05, table_side_history: 0.05, banker_pair_count: 0.10, shoe_stage: 0.50, pair_risk: 0.30 },
  playerPair: { remaining_rank_pressure: 0.15, table_side_history: 0.35, player_pair_count: 0.15, shoe_stage: 0.30, pair_risk: 0.05 },
  bankerDragon: { point_diff: 0.10, banker_natural: 0.05, banker_point: 0.40, remaining_rank_total: 0.35, big_road: 0.10 },
  playerDragon: { point_diff: 0.05, player_natural: 0.05, player_point: 0.45, remaining_rank_total: 0.40, big_road: 0.05 },
}

test('v097 uses the approved Traditional Chinese strategy name and side thresholds', () => {
  assert.equal(ALL_MT_EQUAL_STRATEGY_VERSION, 'v098_主信心實際命中校準版')
  assert.deepEqual(SIDE_PREDICTION_THRESHOLDS, {
    tie: 42,
    superSix: 60,
    bankerPair: 48,
    playerPair: 50,
    bankerDragon: 48,
    playerDragon: 52,
  })
})

test('v097 side profiles keep only the approved existing weighted items and each sum to one', () => {
  for (const [target, expected] of Object.entries(expectedProfiles)) {
    const profile = SIDE_PREDICTION_WEIGHT_PROFILES[target]
    const active = Object.fromEntries(Object.entries(profile).filter(([, weight]) => weight > 0))
    assert.deepEqual(active, expected, `${target} active weights`)
    assert.ok(Math.abs(Object.values(profile).reduce((sum, weight) => sum + weight, 0) - 1) < 1e-9, `${target} sum`)
  }
})

test('v097 live prediction emits only the approved strategy instead of a v096 fallback', () => {
  const prediction = buildLivePrediction({ tableId: 'BAG97', shoe: 1, round: 0 })
  assert.equal(prediction.strategyVersion, 'v098_主信心實際命中校準版')
  assert.equal(prediction.strategyVersion.includes('v096'), false)
})

test('v096 maps raw main confidence through the approved linear calibration', () => {
  assert.deepEqual([30, 31, 32, 33, 34].map(calibrateMainConfidenceV096), [41, 43, 45, 47, 49])
  assert.equal(calibrateMainConfidenceV096(-100), 30)
  assert.equal(calibrateMainConfidenceV096(100), 70)
})

test('v096 applies calibration to neutral live predictions instead of leaving them at 30', () => {
  const prediction = buildLivePrediction({ tableId: 'BAG00', shoe: 1, round: 0 })
  assert.equal(prediction.confidence, 46)
})
