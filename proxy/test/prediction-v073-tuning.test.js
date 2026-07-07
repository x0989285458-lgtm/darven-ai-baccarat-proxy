import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ALL_MT_EQUAL_MAIN_WEIGHTS,
  SIDE_PREDICTION_THRESHOLDS,
  SIDE_PREDICTION_WEIGHT_PROFILES,
  SIDE_WEIGHT_KEYS,
  buildPredictionResultRow,
} from '../src/supabase-writer.js'

const sum = (weights) => Object.values(weights).reduce((acc, value) => acc + Number(value), 0)

const removedMainKeys = ['table_id', 'display_name', 'dealer_name', 'room_id', 'order_state']
const addedMainKeys = ['card_points', 'shoe_remaining_points', 'table_recent_hit_rate', 'direction_calibration', 'historical_backtest', 'roadmap_trend_signals', 'road_structure_signals', 'derived_road_structure_signals', 'ask_road_signals']
const removedSideKeys = ['dealer_name', 'total_players', 'order_state', 'state']
const rankKeys = ['remaining_A', 'remaining_2', 'remaining_3', 'remaining_4', 'remaining_5', 'remaining_6', 'remaining_7', 'remaining_8', 'remaining_9', 'remaining_10', 'remaining_J', 'remaining_Q', 'remaining_K']

test('v073 main prediction removes unstable identity fields and gives real weight to requested signals', () => {
  assert.ok(Math.abs(sum(ALL_MT_EQUAL_MAIN_WEIGHTS) - 1) < 1e-9)
  for (const key of removedMainKeys) assert.equal(Object.hasOwn(ALL_MT_EQUAL_MAIN_WEIGHTS, key), false)
  for (const key of addedMainKeys) assert.ok(ALL_MT_EQUAL_MAIN_WEIGHTS[key] > 0, `${key} should have non-zero main weight`)
})

test('v073 side prediction thresholds are original baseline plus five', () => {
  assert.deepEqual(SIDE_PREDICTION_THRESHOLDS, {
    tie: 55,
    superSix: 70,
    bankerPair: 75,
    playerPair: 75,
    bankerDragon: 80,
    playerDragon: 80,
  })
})

test('v073 side prediction removes weak correlation fields and uses A-K remaining ranks per target', () => {
  for (const key of removedSideKeys) assert.equal(SIDE_WEIGHT_KEYS.includes(key), false)
  for (const target of ['tie', 'superSix', 'bankerPair', 'playerPair', 'bankerDragon', 'playerDragon']) {
    const profile = SIDE_PREDICTION_WEIGHT_PROFILES[target]
    assert.ok(Math.abs(sum(profile) - 1) < 1e-9, `${target} weights must sum to 1`)
    assert.ok(profile.remaining_rank_total > 0, `${target} must use A-K統整剩餘牌數`)
  }
})

test('v073 prediction row records new strategy and preserves requested prediction outputs only', () => {
  const row = buildPredictionResultRow(
    {
      tableId: 'BAG05', shoe: 15396, round: 1, winner: 2,
      rawResult: [26,40,43,20,0,0,-1,-1,4,8],
      cardShoe: {
        remainingRankCounts: { A: 31, '2': 32, '3': 30, '4': 29, '5': 28, '6': 27, '7': 26, '8': 25, '9': 24, '10': 23, J: 22, Q: 21, K: 20 },
        remainingPointCounts: { '0': 86, '1': 31, '2': 32, '3': 30, '4': 29, '5': 28, '6': 27, '7': 26, '8': 25, '9': 24 },
      },
    },
    { tableId: 'BAG05', displayName: '桌5', dealerName: 'ignored', roomId: 29, orderState: 1, state: 1, totalPlayers: 20, shoe: 15396, round: 1, beadPlateRaw: '0202', bankerCount: 1, playerCount: 0, tieCount: 0 },
  )
  assert.equal(row.strategy_version, 'v078_副預測剩餘牌統整版')
  assert.ok(['banker', 'player'].includes(row.predicted_result))
  assert.equal(row.prediction_features.side_weights.bankerPair.dealer_name, undefined)
  assert.equal(row.prediction_features.side_weights.bankerPair.total_players, undefined)
})

test('v073 newly weighted main features produce non-neutral scores instead of metadata-only weights', () => {
  const row = buildPredictionResultRow(
    {
      tableId: 'BAG73', shoe: 15396, round: 22, winner: 'banker',
      rawResult: [1, 9, 2, 10, 0, 0, -1, -1, 3, 9],
      cardShoe: {
        remainingPointCounts: { '0': 12, '1': 12, '2': 10, '3': 10, '4': 8, '5': 8, '6': 30, '7': 31, '8': 32, '9': 33 },
        remainingRankCounts: { A: 20, '2': 20, '3': 20, '4': 20, '5': 20, '6': 30, '7': 31, '8': 32, '9': 33, '10': 20, J: 20, Q: 20, K: 20 },
      },
    },
    {
      tableId: 'BAG73', shoe: 15396, round: 22,
      bankerCount: 60, playerCount: 40, tieCount: 0,
      recentHitRate: 0.72, recentPredictionCount: 30,
      beadPlateRaw: '0202020202', bigRoadRaw: 'BBBBBB', bigEyeRaw: '111111', smallRoadRaw: '111111', cockroachRaw: '111111',
      nextBankerRaw: '1111111111', nextPlayerRaw: '222',
    },
  )
  const scores = row.prediction_features.unified_main_scores
  for (const key of ['card_points', 'shoe_remaining_points', 'direction_calibration', 'historical_backtest', 'pattern_tags']) {
    assert.notDeepEqual(scores[key], { banker: 0.5, player: 0.5 }, `${key} should actively affect scoring`)
  }
})
