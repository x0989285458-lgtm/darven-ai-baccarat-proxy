import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ALL_MT_EQUAL_MAIN_WEIGHTS,
  ALL_MT_EQUAL_SIDE_WEIGHTS,
} from '../src/supabase-writer.js'
import { buildPredictionResultRow } from './helpers/prediction-result.js'

const baseRound = {
  tableId: 'BAG13',
  shoe: 913,
  round: 18,
  rawResult: [1, 2, 14, 15, 0, 0, -1, -1, 5, 4],
  winner: 'player',
}

const bankerLeaningTable = {
  tableId: 'BAG13',
  shoe: 913,
  round: 17,
  bankerCount: 20,
  playerCount: 10,
  tieCount: 0,
  beadPlateRaw: 'B#B#P#B',
  bigRoadRaw: 'BBPBB',
  bigEyeRaw: '111',
  smallRoadRaw: '121',
  cockroachRaw: '212',
  nextBankerRaw: 'banker-good',
  nextPlayerRaw: 'player-bad',
}


test('low-performing table keeps banker/player prediction and records all-MT equal strategy', () => {
  const prediction = buildPredictionResultRow(baseRound, {
    ...bankerLeaningTable,
    recentHitRate: 0.44,
    recentPredictionCount: 25,
  })

  assert.equal(prediction.strategy_version, 'v104')
  assert.equal(prediction.prediction_features.table_performance.recentHitRate, 0.44)
  assert.match(prediction.predicted_result, /^(banker|player)$/)
  assert.equal(prediction.confidence >= 30, true)
  assert.equal(prediction.confidence <= 70, true)
  assert.equal(prediction.short_run_adjustment.rule, 'v104')
})

test('revealed winner never changes an already-created neutral pre-result prediction', () => {
  const neutralTable = {
    tableId: 'BAG13',
    shoe: 913,
    round: 17,
    bankerCount: 10,
    playerCount: 10,
    tieCount: 0,
    beadPlateRaw: '',
    bigRoadRaw: '',
    bigEyeRaw: '',
    smallRoadRaw: '',
    cockroachRaw: '',
    nextBankerRaw: '',
    nextPlayerRaw: '',
  }
  const afterBanker = buildPredictionResultRow({ ...baseRound, rawResult: null, winner: 'banker' }, neutralTable)
  const afterPlayer = buildPredictionResultRow({ ...baseRound, rawResult: null, winner: 'player' }, neutralTable)

  assert.deepEqual(
    { result: afterBanker.predicted_result, confidence: afterBanker.confidence },
    { result: 'player', confidence: 46 },
  )
  assert.deepEqual(
    { result: afterPlayer.predicted_result, confidence: afterPlayer.confidence },
    { result: 'player', confidence: 46 },
  )
})

test('main and side strategy uses high-hit weighted features', () => {
  const mainKeys = [
    'roadmap_trend_signals', 'ask_road_signals', 'recent_practical_calibration',
    'shoe_banker_player_bias', 'neutral_reserve',
  ]
  const sideKeys = [
    'tie_count', 'banker_pair_count', 'player_pair_count', 'bead_road', 'big_road', 'big_eye_road', 'small_road', 'cockroach_road',
    'next_banker_road', 'next_player_road', 'shoe', 'round', 'shoe_stage',
    'player_point', 'banker_point', 'point_diff', 'banker_natural', 'player_natural', 'banker_dragon', 'player_dragon', 'super_six',
    'tie_risk', 'pair_risk', 'ask_road_conflict', 'road_chaos', 'table_side_history',
    'remaining_rank_pressure', 'remaining_rank_total',
  ]
  assert.deepEqual(Object.keys(ALL_MT_EQUAL_MAIN_WEIGHTS).sort(), mainKeys.sort())
  assert.deepEqual(Object.keys(ALL_MT_EQUAL_SIDE_WEIGHTS).sort(), sideKeys.sort())
  assert.equal(Object.keys(ALL_MT_EQUAL_MAIN_WEIGHTS).length, 5)
  assert.equal(Object.keys(ALL_MT_EQUAL_SIDE_WEIGHTS).length, 28)
  assert.equal(ALL_MT_EQUAL_MAIN_WEIGHTS.ask_road_signals, 0.15)
  assert.equal(Object.hasOwn(ALL_MT_EQUAL_MAIN_WEIGHTS, 'table_id'), false)
  assert.equal(ALL_MT_EQUAL_SIDE_WEIGHTS.pair_risk, 0.35)
  assert.equal(ALL_MT_EQUAL_SIDE_WEIGHTS.remaining_rank_pressure, 0.15)
  assert.equal(Number(Object.values(ALL_MT_EQUAL_MAIN_WEIGHTS).reduce((a, b) => a + b, 0).toFixed(10)), 1)
  assert.equal(Number(Object.values(ALL_MT_EQUAL_SIDE_WEIGHTS).reduce((a, b) => a + b, 0).toFixed(10)), 1)
})

test('prediction rows persist high-hit main and side weights plus captured MT context', () => {
  const prediction = buildPredictionResultRow(baseRound, {
    ...bankerLeaningTable,
    displayName: 'MT百家樂第13桌',
    tableType: 'BAC',
    roomId: '29',
    dealerName: '毛毛',
    totalPlayers: 906,
    shoe: 913,
    round: 17,
    bankerPairCount: 1,
    playerPairCount: 4,
    state: 0,
    orderState: 1,
    sourceUpdatedAt: '2026-07-01T09:00:00Z',
  })

  assert.equal(prediction.strategy_version, 'v104')
  assert.deepEqual(prediction.feature_weights, ALL_MT_EQUAL_MAIN_WEIGHTS)
  assert.deepEqual(prediction.prediction_features.side_weights.bankerPair, ALL_MT_EQUAL_SIDE_WEIGHTS)
  assert.equal(Object.keys(prediction.prediction_features.side_weights.tie).length, 28)
  assert.equal(prediction.prediction_features.mt_context.dealerName, '毛毛')
  assert.equal(prediction.prediction_features.mt_context.totalPlayers, 906)
  assert.equal(prediction.prediction_features.derived_main_features.shoeStage, 'middle')
  assert.match(prediction.predicted_result, /^(banker|player)$/)
  assert.equal(prediction.confidence >= 30, true)
  assert.equal(prediction.confidence <= 70, true)
})

test('high-performing table still keeps confidence in 30-70 range', () => {
  const neutralPrediction = buildPredictionResultRow(baseRound, {
    ...bankerLeaningTable,
    bankerCount: 8,
    playerCount: 7,
    tieCount: 0,
    recentHitRate: 0.70,
    recentPredictionCount: 25,
  })
  const boostedPrediction = buildPredictionResultRow(baseRound, {
    ...bankerLeaningTable,
    bankerCount: 99,
    playerCount: 1,
    tieCount: 0,
    recentHitRate: 0.92,
    recentPredictionCount: 25,
  })

  assert.equal(neutralPrediction.strategy_version, 'v104')
  assert.equal(neutralPrediction.confidence >= 30, true)
  assert.equal(neutralPrediction.confidence <= 70, true)
  assert.equal(boostedPrediction.confidence <= 70, true)
})

test('dragon bonus prediction is single-side only and skips close two-sided dragon scores', () => {
  const prediction = buildPredictionResultRow({
    ...baseRound,
    winner: 'banker',
    rawResult: [1, 2, 14, 15, 0, 0, -1, -1, 9, 3],
  }, {
    tableId: 'BAG13',
    shoe: 913,
    round: 17,
    bankerCount: 10,
    playerCount: 10,
    tieCount: 0,
  })

  assert.equal(prediction.prediction_features.side_predictions.bankerDragon >= 20, true)
  assert.equal(prediction.prediction_features.side_predictions.playerDragon >= 20, true)
  assert.equal(prediction.prediction_features.side_hits.bankerDragon, false)
  assert.equal(prediction.prediction_features.side_hits.playerDragon, false)
})
