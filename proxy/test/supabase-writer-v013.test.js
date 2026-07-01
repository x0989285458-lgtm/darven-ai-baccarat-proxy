import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SHORT_RUN_STRATEGY_VERSION,
  SHORT_RUN_WEIGHTS,
  ALL_MT_EQUAL_MAIN_WEIGHTS,
  ALL_MT_EQUAL_SIDE_WEIGHTS,
  buildShortRunAdjustedStrategy,
  buildPredictionResultRow,
} from '../src/supabase-writer.js'

const baseRound = {
  tableId: 'BAG13',
  shoe: 913,
  round: 18,
  rawResult: [1, 2, 14, 15, 0, 0, -1, -1, 5, 4],
  winner: 'player',
}

const bankerLeaningTable = {
  tableId: 'BAG13',
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

test('v049 short-run strategy weights sum to 1 and match required proportions', () => {
  const strategy = buildShortRunAdjustedStrategy()
  assert.equal(SHORT_RUN_STRATEGY_VERSION, 'v049_no_observe_confidence_30_80')
  assert.equal(strategy.version, 'v049_no_observe_confidence_30_80')
  assert.equal(strategy.status, 'active')
  assert.deepEqual(strategy.weights, {
    bead_road: 0.15,
    big_road: 0.15,
    derived_roads: 0.12,
    ask_road: 0.15,
    card_points: 0.10,
    shoe_remaining_points: 0.08,
    pattern_tags: 0.10,
    table_recent_hit_rate: 0.15,
  })
  const total = Object.values(SHORT_RUN_WEIGHTS).reduce((sum, value) => sum + value, 0)
  assert.equal(Number(total.toFixed(10)), 1)
})

test('v050 low-performing table keeps banker/player prediction and records all-MT equal strategy', () => {
  const prediction = buildPredictionResultRow(baseRound, {
    ...bankerLeaningTable,
    recentHitRate: 0.44,
    recentPredictionCount: 25,
  })

  assert.equal(prediction.strategy_version, 'v050_all_mt_equal_weight')
  assert.equal(prediction.prediction_features.table_performance.recentHitRate, 0.44)
  assert.match(prediction.predicted_result, /^(banker|player)$/)
  assert.equal(prediction.confidence >= 30, true)
  assert.equal(prediction.confidence <= 80, true)
  assert.equal(prediction.short_run_adjustment.rule, 'all_mt_and_user_requested_equal_weight')
})

test('v049 equal banker/player probabilities choose banker instead of observe', () => {
  const prediction = buildPredictionResultRow(baseRound, {
    ...bankerLeaningTable,
    bankerCount: 10,
    playerCount: 10,
    tieCount: 0,
  })

  assert.equal(prediction.predicted_result, 'banker')
  assert.equal(prediction.confidence >= 30, true)
  assert.equal(prediction.confidence <= 80, true)
})

test('v050 all MT equal strategy includes every captured and requested main/side feature with equal weights', () => {
  const mainKeys = [
    'table_id', 'display_name', 'table_type', 'room_id', 'dealer_name', 'total_players', 'state', 'order_state', 'source_updated_at',
    'shoe', 'round', 'shoe_stage', 'banker_count', 'player_count', 'tie_count', 'banker_pair_count', 'player_pair_count',
    'bead_road', 'big_road', 'big_eye_road', 'small_road', 'cockroach_road', 'next_banker_road', 'next_player_road',
    'previous_winner', 'streak_length', 'near5_banker_player_bias', 'road_trend', 'long_dragon', 'jump_pattern', 'single_jump', 'double_jump', 'road_break', 'derived_road_sync', 'ask_road_trend',
    'table_recent_hit_rate', 'direction_calibration', 'confidence', 'probability_gap', 'card_points', 'shoe_remaining_points', 'remaining_rank_counts', 'pattern_tags', 'historical_backtest',
  ]
  const sideKeys = [
    'tie_count', 'banker_pair_count', 'player_pair_count', 'bead_road', 'big_road', 'big_eye_road', 'small_road', 'cockroach_road',
    'next_banker_road', 'next_player_road', 'dealer_name', 'total_players', 'shoe', 'round', 'shoe_stage', 'state', 'order_state',
    'raw_result', 'player_point', 'banker_point', 'point_diff', 'banker_natural', 'player_natural', 'banker_dragon', 'player_dragon', 'super_six',
    'shoe_remaining_points', 'remaining_rank_counts', 'road_trend', 'long_dragon', 'jump_pattern', 'single_jump', 'double_jump', 'road_break', 'derived_road_sync', 'tie_risk', 'pair_risk', 'ask_road_conflict', 'ask_road_trend', 'road_chaos', 'table_side_history',
  ]
  assert.deepEqual(Object.keys(ALL_MT_EQUAL_MAIN_WEIGHTS).sort(), mainKeys.sort())
  assert.deepEqual(Object.keys(ALL_MT_EQUAL_SIDE_WEIGHTS).sort(), sideKeys.sort())
  assert.equal(Math.max(...Object.values(ALL_MT_EQUAL_MAIN_WEIGHTS)) - Math.min(...Object.values(ALL_MT_EQUAL_MAIN_WEIGHTS)) < 1e-9, true)
  assert.equal(Math.max(...Object.values(ALL_MT_EQUAL_SIDE_WEIGHTS)) - Math.min(...Object.values(ALL_MT_EQUAL_SIDE_WEIGHTS)) < 1e-9, true)
  assert.equal(Number(Object.values(ALL_MT_EQUAL_MAIN_WEIGHTS).reduce((a, b) => a + b, 0).toFixed(10)), 1)
  assert.equal(Number(Object.values(ALL_MT_EQUAL_SIDE_WEIGHTS).reduce((a, b) => a + b, 0).toFixed(10)), 1)
})

test('v050 prediction rows persist all-MT equal main and side weights plus captured MT context', () => {
  const prediction = buildPredictionResultRow(baseRound, {
    ...bankerLeaningTable,
    displayName: 'MT百家樂第13桌',
    tableType: 'BAC',
    roomId: '29',
    dealerName: '毛毛',
    totalPlayers: 906,
    shoe: 14092,
    round: 21,
    bankerPairCount: 1,
    playerPairCount: 4,
    state: 0,
    orderState: 1,
    sourceUpdatedAt: '2026-07-01T09:00:00Z',
  })

  assert.equal(prediction.strategy_version, 'v050_all_mt_equal_weight')
  assert.deepEqual(prediction.feature_weights, ALL_MT_EQUAL_MAIN_WEIGHTS)
  assert.deepEqual(prediction.prediction_features.side_weights, ALL_MT_EQUAL_SIDE_WEIGHTS)
  assert.equal(prediction.prediction_features.mt_context.dealerName, '毛毛')
  assert.equal(prediction.prediction_features.mt_context.totalPlayers, 906)
  assert.equal(prediction.prediction_features.derived_main_features.shoeStage, 'middle')
  assert.match(prediction.predicted_result, /^(banker|player)$/)
  assert.equal(prediction.confidence >= 30, true)
  assert.equal(prediction.confidence <= 80, true)
})

test('v050 high-performing table still keeps confidence in 30-80 range', () => {
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

  assert.equal(neutralPrediction.strategy_version, 'v050_all_mt_equal_weight')
  assert.equal(neutralPrediction.confidence >= 30, true)
  assert.equal(neutralPrediction.confidence <= 80, true)
  assert.equal(boostedPrediction.confidence <= 80, true)
})
