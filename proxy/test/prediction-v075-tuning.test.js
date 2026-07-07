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
const rankKeys = ['remaining_A', 'remaining_2', 'remaining_3', 'remaining_4', 'remaining_5', 'remaining_6', 'remaining_7', 'remaining_8', 'remaining_9', 'remaining_10', 'remaining_J', 'remaining_Q', 'remaining_K']

test('v075 uses Chinese version and requested side thresholds', () => {
  assert.equal(ALL_MT_EQUAL_STRATEGY_VERSION, 'v077_路單走勢細分版')
  assert.deepEqual(SIDE_PREDICTION_THRESHOLDS, {
    tie: 55,
    superSix: 70,
    bankerPair: 75,
    playerPair: 75,
    bankerDragon: 80,
    playerDragon: 80,
  })
})

test('v075 main weights rebalance away from over-player bias while keeping required features', () => {
  assert.ok(Math.abs(sum(ALL_MT_EQUAL_MAIN_WEIGHTS) - 1) < 1e-9)
  for (const removed of ['round', 'super_six', 'banker_pair_count', 'player_pair_count']) {
    assert.equal(Object.hasOwn(ALL_MT_EQUAL_MAIN_WEIGHTS, removed), false)
  }
  assert.ok(ALL_MT_EQUAL_MAIN_WEIGHTS.direction_calibration >= 0.08)
  assert.ok(ALL_MT_EQUAL_MAIN_WEIGHTS.confidence >= 0.08)
  assert.ok(ALL_MT_EQUAL_MAIN_WEIGHTS.probability_gap >= 0.08)
  assert.ok(ALL_MT_EQUAL_MAIN_WEIGHTS.card_points >= 0.05)
  assert.ok(ALL_MT_EQUAL_MAIN_WEIGHTS.shoe_remaining_points >= 0.02)
  assert.ok(ALL_MT_EQUAL_MAIN_WEIGHTS.next_player_road <= 0.01)
  assert.ok(ALL_MT_EQUAL_MAIN_WEIGHTS.near5_banker_player_bias <= 0.025)
  assert.ok(ALL_MT_EQUAL_MAIN_WEIGHTS.roadmap_trend_signals >= 0.08)
  assert.ok(ALL_MT_EQUAL_MAIN_WEIGHTS.cockroach_road <= 0.01)
  assert.ok(ALL_MT_EQUAL_MAIN_WEIGHTS.tie_count <= 0.005)
})

test('v075 side weights shrink bonus noise and remove weak side features', () => {
  assert.equal(SIDE_WEIGHT_KEYS.includes('raw_result'), false)
  for (const [target, profile] of Object.entries(SIDE_PREDICTION_WEIGHT_PROFILES)) {
    assert.ok(Math.abs(sum(profile) - 1) < 1e-9, `${target} must sum to 1`)
    assert.equal(Object.hasOwn(profile, 'raw_result'), false)
    assert.ok(rankKeys.some((key) => profile[key] > 0), `${target} should keep A-K derived rank features`)
  }
  assert.equal(SIDE_PREDICTION_WEIGHT_PROFILES.superSix.bead_road, 0)
  assert.equal(SIDE_PREDICTION_WEIGHT_PROFILES.superSix.big_road, 0)
  assert.equal(SIDE_PREDICTION_WEIGHT_PROFILES.superSix.round, 0)
  assert.equal(SIDE_PREDICTION_WEIGHT_PROFILES.superSix.shoe_stage, 0)
  assert.equal(SIDE_PREDICTION_WEIGHT_PROFILES.bankerPair.banker_pair_count, 0)
  assert.equal(SIDE_PREDICTION_WEIGHT_PROFILES.playerPair.player_pair_count, 0)
  assert.equal(SIDE_PREDICTION_WEIGHT_PROFILES.bankerPair.banker_point, 0)
  assert.equal(SIDE_PREDICTION_WEIGHT_PROFILES.playerPair.player_point, 0)
  assert.equal(SIDE_PREDICTION_WEIGHT_PROFILES.bankerDragon.big_road, 0)
  assert.equal(SIDE_PREDICTION_WEIGHT_PROFILES.playerDragon.big_road, 0)
  assert.ok(SIDE_PREDICTION_WEIGHT_PROFILES.tie.tie_risk >= 0.30)
  assert.ok(SIDE_PREDICTION_WEIGHT_PROFILES.tie.point_diff >= 0.20)
  assert.ok(SIDE_PREDICTION_WEIGHT_PROFILES.bankerPair.pair_risk >= 0.35)
  assert.ok(SIDE_PREDICTION_WEIGHT_PROFILES.playerPair.pair_risk >= 0.35)
  assert.ok(SIDE_PREDICTION_WEIGHT_PROFILES.bankerDragon.point_diff >= 0.30)
  assert.ok(SIDE_PREDICTION_WEIGHT_PROFILES.playerDragon.point_diff >= 0.30)
})

test('v075 prediction row records new Chinese version and thresholds remain active', () => {
  const row = buildPredictionResultRow(
    {
      tableId: 'BAG75', shoe: 17001, round: 12, winner: 'banker',
      rawResult: [1, 9, 13, 8, 0, 0, -1, -1, 0, 8],
      cardShoe: {
        remainingPointCounts: { '0': 80, '1': 31, '2': 30, '3': 29, '4': 28, '5': 27, '6': 40, '7': 32, '8': 33, '9': 34 },
        remainingRankCounts: { A: 31, '2': 30, '3': 29, '4': 28, '5': 27, '6': 40, '7': 32, '8': 33, '9': 34, '10': 35, J: 36, Q: 37, K: 38 },
      },
    },
    { tableId: 'BAG75', shoe: 17001, round: 12, bankerCount: 12, playerCount: 8, tieCount: 1, beadPlateRaw: '01020202', bigRoadRaw: 'BBPBBP' },
  )
  assert.equal(row.strategy_version, 'v077_路單走勢細分版')
  assert.deepEqual(row.short_run_adjustment.sideActionRateTargets, {
    tie: 0.15,
    superSix: 0.1,
    bankerPair: 0.2,
    playerPair: 0.2,
    bankerDragon: 0.08,
    playerDragon: 0.08,
  })
})
