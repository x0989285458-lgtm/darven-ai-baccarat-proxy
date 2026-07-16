import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ALL_MT_EQUAL_STRATEGY_VERSION,
  ALL_MT_EQUAL_MAIN_WEIGHTS,
  SIDE_PREDICTION_THRESHOLDS,
  SIDE_PREDICTION_WEIGHT_PROFILES,
} from '../src/supabase-writer.js'
import { buildPredictionResultRow } from './helpers/prediction-result.js'

const sum = (weights) => Object.values(weights).reduce((acc, value) => acc + Number(value), 0)
const rankKeys = ['remaining_A', 'remaining_2', 'remaining_3', 'remaining_4', 'remaining_5', 'remaining_6', 'remaining_7', 'remaining_8', 'remaining_9', 'remaining_10', 'remaining_J', 'remaining_Q', 'remaining_K']

test('v084 keeps main prediction unchanged while applying requested side ratios and thresholds', () => {
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

test('v076 main weights further reduce player-biased noise and emphasize calibration', () => {
  assert.ok(Math.abs(sum(ALL_MT_EQUAL_MAIN_WEIGHTS) - 1) < 1e-9)
  assert.equal(ALL_MT_EQUAL_MAIN_WEIGHTS.ask_road_signals, 0.15)
  assert.equal(ALL_MT_EQUAL_MAIN_WEIGHTS.roadmap_trend_signals, 0.55)
  assert.equal(ALL_MT_EQUAL_MAIN_WEIGHTS.big_road, 0)
  assert.equal(ALL_MT_EQUAL_MAIN_WEIGHTS.card_points, 0)
  assert.equal(ALL_MT_EQUAL_MAIN_WEIGHTS.shoe_remaining_points, 0)
})

test('v076 side weights keep tie useful but shrink superSix pair and dragon noise', () => {
  for (const [target, profile] of Object.entries(SIDE_PREDICTION_WEIGHT_PROFILES)) {
    assert.ok(Math.abs(sum(profile) - 1) < 1e-9, `${target} must sum to 1`)
    assert.ok((profile.remaining_rank_total > 0) || (profile.remaining_rank_pressure > 0), `${target} keeps A-K統整剩餘牌數`)
  }
  assert.equal(SIDE_PREDICTION_WEIGHT_PROFILES.tie.tie_risk, 0.65)
  assert.equal(SIDE_PREDICTION_WEIGHT_PROFILES.tie.point_diff, 0)
  assert.equal(SIDE_PREDICTION_WEIGHT_PROFILES.tie.bead_road, 0)
  assert.equal(SIDE_PREDICTION_WEIGHT_PROFILES.superSix.table_side_history, 0.40)
  assert.equal(SIDE_PREDICTION_WEIGHT_PROFILES.superSix.banker_point, 0.40)
  assert.equal(SIDE_PREDICTION_WEIGHT_PROFILES.superSix.remaining_rank_total, 0.15)
  assert.equal(SIDE_PREDICTION_WEIGHT_PROFILES.bankerPair.remaining_rank_pressure, 0.05)
  assert.equal(SIDE_PREDICTION_WEIGHT_PROFILES.playerPair.remaining_rank_pressure, 0.15)
  assert.equal(SIDE_PREDICTION_WEIGHT_PROFILES.bankerDragon.point_diff, 0.10)
  assert.equal(SIDE_PREDICTION_WEIGHT_PROFILES.playerDragon.point_diff, 0.05)
})

test('v076 prediction row records new strategy without changing main action-rate target shape', () => {
  const row = buildPredictionResultRow(
    {
      tableId: 'BAG76', shoe: 18001, round: 18, winner: 'banker',
      rawResult: [1, 9, 13, 8, 0, 0, -1, -1, 0, 8],
      cardShoe: {
        remainingPointCounts: { '0': 80, '1': 31, '2': 30, '3': 29, '4': 28, '5': 27, '6': 40, '7': 32, '8': 33, '9': 34 },
        remainingRankCounts: { A: 31, '2': 30, '3': 29, '4': 28, '5': 27, '6': 40, '7': 32, '8': 33, '9': 34, '10': 35, J: 36, Q: 37, K: 38 },
      },
    },
    { tableId: 'BAG76', shoe: 18001, round: 17, bankerCount: 12, playerCount: 8, tieCount: 1, beadPlateRaw: '01020202', bigRoadRaw: 'BBPBBP' },
  )
  assert.equal(row.strategy_version, 'v098_主信心實際命中校準版')
  assert.equal(row.predicted_result === 'banker' || row.predicted_result === 'player', true)
})
