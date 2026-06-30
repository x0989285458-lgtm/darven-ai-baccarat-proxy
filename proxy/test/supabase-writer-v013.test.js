import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SHORT_RUN_STRATEGY_VERSION,
  SHORT_RUN_WEIGHTS,
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

test('v013 short-run strategy weights sum to 1 and match required proportions', () => {
  const strategy = buildShortRunAdjustedStrategy()
  assert.equal(SHORT_RUN_STRATEGY_VERSION, 'v013_short_run_adjusted')
  assert.equal(strategy.version, 'v013_short_run_adjusted')
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

test('v013 low-performing table below 45% becomes observe or caps confidence at 50', () => {
  const prediction = buildPredictionResultRow(baseRound, {
    ...bankerLeaningTable,
    recentHitRate: 0.44,
    recentPredictionCount: 25,
  })

  assert.equal(prediction.strategy_version, 'v013_short_run_adjusted')
  assert.equal(prediction.prediction_features.table_performance.recentHitRate, 0.44)
  assert.equal(
    prediction.predicted_result === 'observe' || prediction.confidence <= 50,
    true,
    `expected observe or confidence <= 50, got ${prediction.predicted_result} ${prediction.confidence}`,
  )
  assert.equal(prediction.confidence <= 50, true)
})

test('v013 high-performing table above 65% boosts confidence but never above 100', () => {
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

  assert.equal(neutralPrediction.strategy_version, 'v013_short_run_adjusted')
  assert.equal(neutralPrediction.confidence > neutralPrediction.probabilities[neutralPrediction.predicted_result], true)
  assert.equal(neutralPrediction.confidence <= 100, true)
  assert.equal(boostedPrediction.confidence, 100)
})
