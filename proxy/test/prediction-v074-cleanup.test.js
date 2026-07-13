import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ALL_MT_EQUAL_STRATEGY_VERSION,
  ALL_MT_EQUAL_MAIN_WEIGHTS,
  SIDE_PREDICTION_THRESHOLDS,
  SIDE_PREDICTION_WEIGHT_PROFILES,
  SIDE_WEIGHT_KEYS,
  buildPredictionResultRow,
} from '../src/supabase-writer.js'

const sum = (weights) => Object.values(weights).reduce((acc, value) => acc + Number(value), 0)

const mainRemovedKeys = ['round', 'super_six', 'banker_pair_count', 'player_pair_count']
const sideTargets = ['tie', 'superSix', 'bankerPair', 'playerPair', 'bankerDragon', 'playerDragon']
const rankKeys = ['remaining_A', 'remaining_2', 'remaining_3', 'remaining_4', 'remaining_5', 'remaining_6', 'remaining_7', 'remaining_8', 'remaining_9', 'remaining_10', 'remaining_J', 'remaining_Q', 'remaining_K']

test('v074 uses Chinese version name and preserves action-rate thresholds', () => {
  assert.equal(ALL_MT_EQUAL_STRATEGY_VERSION, 'v097_副預測命中校準與門檻降5版')
  assert.deepEqual(SIDE_PREDICTION_THRESHOLDS, {
    tie: 42,
    superSix: 60,
    bankerPair: 48,
    playerPair: 50,
    bankerDragon: 48,
    playerDragon: 52,
  })
})

test('v074 main prediction removes only requested direct weights and keeps remaining shoe points', () => {
  assert.ok(Math.abs(sum(ALL_MT_EQUAL_MAIN_WEIGHTS) - 1) < 1e-9)
  for (const key of mainRemovedKeys) assert.equal(Object.hasOwn(ALL_MT_EQUAL_MAIN_WEIGHTS, key), false, `${key} must be removed from main direct weights`)
  assert.equal(ALL_MT_EQUAL_MAIN_WEIGHTS.shoe_remaining_points, 0, 'v081 ignores previous shoe remaining weight')
  for (const key of ['big_road', 'bead_road', 'big_eye_road', 'cockroach_road', 'next_banker_road', 'next_player_road', 'previous_winner', 'streak_length', 'near5_banker_player_bias', 'table_recent_hit_rate', 'direction_calibration', 'confidence', 'probability_gap', 'card_points', 'historical_backtest', 'shoe_stage', 'banker_count', 'player_count', 'tie_count', 'roadmap_trend_signals', 'road_structure_signals', 'derived_road_structure_signals', 'ask_road_signals']) {
    assert.ok(Object.hasOwn(ALL_MT_EQUAL_MAIN_WEIGHTS, key), `${key} should remain available in main weights`)
  }
})

test('v074 side prediction treats raw result as source data, not a direct weight', () => {
  assert.equal(SIDE_WEIGHT_KEYS.includes('raw_result'), false)
  for (const target of sideTargets) {
    const profile = SIDE_PREDICTION_WEIGHT_PROFILES[target]
    assert.equal(Object.hasOwn(profile, 'raw_result'), false, `${target} must not directly weight raw_result`)
    assert.ok(Math.abs(sum(profile) - 1) < 1e-9, `${target} weights must sum to 1`)
    assert.ok((profile.remaining_rank_total > 0) || (profile.remaining_rank_pressure > 0), `${target} must still use A-K統整剩餘牌數`)
  }
})

test('v074 prediction row records Chinese strategy and keeps derived point/rank features', () => {
  const row = buildPredictionResultRow(
    {
      tableId: 'BAG74', shoe: 16001, round: 9, winner: 'banker',
      rawResult: [1, 9, 13, 8, 0, 0, -1, -1, 0, 8],
      cardShoe: {
        remainingPointCounts: { '0': 80, '1': 31, '2': 30, '3': 29, '4': 28, '5': 27, '6': 40, '7': 32, '8': 33, '9': 34 },
        remainingRankCounts: { A: 31, '2': 30, '3': 29, '4': 28, '5': 27, '6': 40, '7': 32, '8': 33, '9': 34, '10': 35, J: 36, Q: 37, K: 38 },
      },
    },
    {
      tableId: 'BAG74', shoe: 16001, round: 9,
      bankerCount: 12, playerCount: 8, tieCount: 1,
      recentHitRate: 0.65, recentPredictionCount: 30,
      beadPlateRaw: '01020202', bigRoadRaw: 'BBPBBP', bigEyeRaw: '111222', smallRoadRaw: '121212', cockroachRaw: '212121',
      nextBankerRaw: '1111', nextPlayerRaw: '2222',
    },
  )
  assert.equal(row.strategy_version, 'v097_副預測命中校準與門檻降5版')
  assert.ok(row.prediction_features.point_features)
  assert.ok(row.prediction_features.card_shoe_features)
  assert.ok(row.prediction_features.side_card_rank_features)
  assert.equal(Object.hasOwn(row.prediction_features.side_weights.bankerPair, 'raw_result'), false)
  assert.ok(row.prediction_features.unified_main_scores.shoe_remaining_points)
})
