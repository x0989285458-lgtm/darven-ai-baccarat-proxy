import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ALL_MT_EQUAL_MAIN_WEIGHTS,
  V100_MAIN_SIGNAL_DEDUP_VERSION,
  V100_MAIN_SIGNAL_DEDUP_WEIGHTS,
  buildLivePrediction,
  calculateV100MainPrediction,
} from '../src/supabase-writer.js'

test('deduplicates a same-direction shoe margin when ask-road is stronger', () => {
  const prediction = calculateV100MainPrediction({
    table: {
      tableId: 'BAG99',
      shoe: 1,
      round: 20,
      bankerCount: 11,
      playerCount: 9,
      nextBankerRaw: 'B',
    },
  })

  assert.equal(V100_MAIN_SIGNAL_DEDUP_VERSION, 'v101_主預測沿用v100正式版')
  assert.deepEqual(prediction.scores.shoe_banker_player_bias, { banker: 0.5, player: 0.5 })
  assert.deepEqual(prediction.diagnostics.shoeBankerPlayerBias, {
    originalScore: { banker: 0.55, player: 0.45 },
    adjustedScore: { banker: 0.5, player: 0.5 },
    askRoadMargin: 0.12,
    originalShoeMargin: 0.1,
    sharedComponentMargin: 0.1,
    residualMargin: 0,
    deduplicated: true,
  })
})

test('keeps only the same-direction shoe margin beyond ask-road', () => {
  const prediction = calculateV100MainPrediction({
    table: {
      tableId: 'BAG99',
      shoe: 1,
      round: 20,
      bankerCount: 13,
      playerCount: 7,
      nextBankerRaw: 'B',
    },
  })

  assert.deepEqual(prediction.scores.shoe_banker_player_bias, { banker: 0.52, player: 0.48 })
  assert.deepEqual(prediction.diagnostics.shoeBankerPlayerBias, {
    originalScore: { banker: 0.58, player: 0.42 },
    adjustedScore: { banker: 0.52, player: 0.48 },
    askRoadMargin: 0.12,
    originalShoeMargin: 0.16,
    sharedComponentMargin: 0.12,
    residualMargin: 0.04,
    deduplicated: true,
  })
})

test('preserves an opposite-direction shoe margin but clips it to 55/45', () => {
  const prediction = calculateV100MainPrediction({
    table: {
      tableId: 'BAG99',
      shoe: 1,
      round: 20,
      bankerCount: 7,
      playerCount: 13,
      nextBankerRaw: 'B',
    },
  })

  assert.deepEqual(prediction.scores.shoe_banker_player_bias, { banker: 0.45, player: 0.55 })
  assert.equal(prediction.diagnostics.shoeBankerPlayerBias.sharedComponentMargin, 0)
  assert.equal(prediction.diagnostics.shoeBankerPlayerBias.residualMargin, -0.1)
  assert.equal(prediction.diagnostics.shoeBankerPlayerBias.deduplicated, false)
})

test('fails closed to a finite neutral shoe score for invalid signal input', () => {
  const prediction = calculateV100MainPrediction({
    table: {
      tableId: 'BAG99',
      shoe: 1,
      round: 20,
      bankerCount: 13,
      playerCount: 7,
      nextBankerRaw: Symbol('invalid-ask-road'),
    },
  })

  assert.deepEqual(prediction.scores.shoe_banker_player_bias, { banker: 0.5, player: 0.5 })
  assert.equal(Object.values(prediction.scores).flatMap(Object.values).every(Number.isFinite), true)
  assert.equal(Object.values(prediction.total).every(Number.isFinite), true)
  assert.equal(Object.values(prediction.diagnostics.shoeBankerPlayerBias)
    .filter((value) => typeof value === 'number').every(Number.isFinite), true)
})

test('v101 formal prediction uses the approved deduplicated main score', () => {
  const prediction = buildLivePrediction({
    tableId: 'BAG99',
    shoe: 1,
    round: 20,
    bankerCount: 11,
    playerCount: 9,
    nextBankerRaw: 'B',
  })

  assert.deepEqual({
    strategyVersion: prediction.strategyVersion,
    predictedResult: prediction.predictedResult,
    confidence: prediction.confidence,
    scoreTotals: prediction.scoreTotals,
    askRoadScore: prediction.scoreSources.ask_road_signals,
    shoeScore: prediction.scoreSources.shoe_banker_player_bias,
  }, {
    strategyVersion: 'v101',
    predictedResult: 'banker',
    confidence: 46,
    scoreTotals: { banker: 0.515, player: 0.48500000000000004 },
    askRoadScore: { banker: 0.56, player: 0.44 },
    shoeScore: { banker: 0.5, player: 0.5 },
  })
})

test('keeps the exact approved four non-zero main weights', () => {
  const activeWeights = Object.fromEntries(Object.entries(V100_MAIN_SIGNAL_DEDUP_WEIGHTS)
    .filter(([, weight]) => weight > 0))

  assert.deepEqual(activeWeights, {
    ask_road_signals: 0.25,
    roadmap_trend_signals: 0.45,
    recent_practical_calibration: 0.20,
    shoe_banker_player_bias: 0.10,
  })
  assert.equal(V100_MAIN_SIGNAL_DEDUP_WEIGHTS, ALL_MT_EQUAL_MAIN_WEIGHTS)
  assert.ok(Math.abs(Object.values(V100_MAIN_SIGNAL_DEDUP_WEIGHTS).reduce((sum, weight) => sum + weight, 0) - 1) < 1e-12)
})
