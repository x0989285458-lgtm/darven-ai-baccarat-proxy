import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ALL_MT_EQUAL_STRATEGY_VERSION,
  ALL_MT_EQUAL_MAIN_WEIGHTS,
  SIDE_WEIGHT_KEYS,
  SIDE_PREDICTION_WEIGHT_PROFILES,
  buildPredictionResultRow,
} from '../src/supabase-writer.js'

const rankKeys = ['remaining_A', 'remaining_2', 'remaining_3', 'remaining_4', 'remaining_5', 'remaining_6', 'remaining_7', 'remaining_8', 'remaining_9', 'remaining_10', 'remaining_J', 'remaining_Q', 'remaining_K']
const sum = (weights) => Object.values(weights).reduce((acc, value) => acc + Number(value), 0)

test('v078 removes main remaining-card aggregate and uses side A-K aggregate only', () => {
  assert.equal(ALL_MT_EQUAL_STRATEGY_VERSION, 'v078_副預測剩餘牌統整版')
  assert.ok(Math.abs(sum(ALL_MT_EQUAL_MAIN_WEIGHTS) - 1) < 1e-9)
  assert.equal(Object.hasOwn(ALL_MT_EQUAL_MAIN_WEIGHTS, 'remaining_zero_to_k_total'), false)
  assert.equal(SIDE_WEIGHT_KEYS.includes('remaining_rank_total'), true)
  for (const key of rankKeys) assert.equal(SIDE_WEIGHT_KEYS.includes(key), false, `${key} must be removed from side direct weights`)
  for (const [target, profile] of Object.entries(SIDE_PREDICTION_WEIGHT_PROFILES)) {
    assert.ok(Math.abs(sum(profile) - 1) < 1e-9, `${target} weights must sum to 1`)
    assert.ok(profile.remaining_rank_total > 0, `${target} must use A-K統整剩餘牌數`)
    for (const key of rankKeys) assert.equal(Object.hasOwn(profile, key), false, `${target} must not directly weight ${key}`)
  }
})

test('v078 prediction row exposes side remaining-rank total and no main remaining-card aggregate score', () => {
  const row = buildPredictionResultRow(
    {
      tableId: 'BAG78', shoe: 78, round: 18, winner: 'banker', rawResult: [1, 14, 2, 15, 0, 0, -1, -1, 3, 6],
      cardShoe: {
        remainingPointCounts: { '0': 128, '1': 31, '2': 30, '3': 29, '4': 28, '5': 27, '6': 40, '7': 32, '8': 33, '9': 34 },
        remainingRankCounts: { A: 31, '2': 30, '3': 29, '4': 28, '5': 27, '6': 40, '7': 32, '8': 33, '9': 34, '10': 35, J: 36, Q: 37, K: 38 },
        cardsRemainingTotal: 430,
      },
    },
    { tableId: 'BAG78', shoe: 78, round: 18, bankerCount: 9, playerCount: 7, tieCount: 1, beadPlateRaw: '020102010201#020102010202#020202', bigRoadRaw: '0201010201020201020202' },
  )
  assert.equal(row.strategy_version, 'v078_副預測剩餘牌統整版')
  assert.equal(Object.hasOwn(row.prediction_features.unified_main_scores, 'remaining_zero_to_k_total'), false)
  assert.equal(row.prediction_features.side_card_rank_features.remainingRankTotal, 430)
  assert.equal(typeof row.prediction_features.side_prediction_rank_inputs.tie.remainingRankFeatureScores.remaining_rank_total, 'number')
  assert.equal(Object.hasOwn(row.prediction_features.side_weights.tie, 'remaining_A'), false)
  assert.ok(row.prediction_features.side_weights.tie.remaining_rank_total > 0)
})
