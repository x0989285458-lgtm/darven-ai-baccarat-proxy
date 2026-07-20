import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ALL_MT_EQUAL_MAIN_WEIGHTS,
  buildLivePrediction,
} from '../src/supabase-writer.js'

function neutralTable(overrides = {}) {
  return {
    tableId: 'BAG102',
    shoe: 102,
    round: 10,
    bankerCount: 0,
    playerCount: 0,
    beadPlateRaw: '',
    bigRoadRaw: '',
    nextBankerRaw: '',
    nextPlayerRaw: '',
    ...overrides,
  }
}

test('v102 main weights are the exact five-source profile and sum to one', () => {
  assert.deepEqual(ALL_MT_EQUAL_MAIN_WEIGHTS, {
    roadmap_trend_signals: 0.35,
    ask_road_signals: 0.15,
    recent_practical_calibration: 0.30,
    shoe_banker_player_bias: 0.10,
    neutral_reserve: 0.10,
  })
  assert.equal(Object.values(ALL_MT_EQUAL_MAIN_WEIGHTS).reduce((sum, weight) => sum + weight, 0), 1)
})

test('neutral reserve contributes 0.5 to banker and player without changing direction', () => {
  const prediction = buildLivePrediction(neutralTable())

  assert.deepEqual(prediction.scoreSources.neutral_reserve, { banker: 0.5, player: 0.5 })
  assert.equal(prediction.scoreTotals.banker, prediction.scoreTotals.player)
})

test('recent calibration shrinks banker and player settled rates toward neutral', () => {
  const bankerSupported = buildLivePrediction(neutralTable({
    settledDirectionalPredictionStats: {
      banker: { settledPredictionCount: 20, hitRate: 0.70 },
      player: { settledPredictionCount: 20, hitRate: 0.40 },
    },
  }))
  const playerSupported = buildLivePrediction(neutralTable({
    settledDirectionalPredictionStats: {
      banker: { settledPredictionCount: 20, hitRate: 0.40 },
      player: { settledPredictionCount: 20, hitRate: 0.70 },
    },
  }))

  assert.deepEqual(bankerSupported.scoreSources.recent_practical_calibration, { banker: 0.55, player: 0.475 })
  assert.deepEqual(playerSupported.scoreSources.recent_practical_calibration, { banker: 0.475, player: 0.55 })
})

test('recent calibration keeps each direction neutral below twenty settled samples', () => {
  const prediction = buildLivePrediction(neutralTable({
    settledDirectionalPredictionStats: {
      banker: { settledPredictionCount: 19, hitRate: 0.95 },
      player: { settledPredictionCount: 4, hitRate: 0.05 },
    },
  }))

  assert.deepEqual(prediction.scoreSources.recent_practical_calibration, { banker: 0.5, player: 0.5 })
})

test('missing directional history stays neutral and never substitutes shoe ratio or aggregate hit rate', () => {
  const baseline = buildLivePrediction(neutralTable({
    bankerCount: 99,
    playerCount: 1,
  }))
  const prediction = buildLivePrediction(neutralTable({
    bankerCount: 99,
    playerCount: 1,
    recentHitRate: 0.99,
    recentPredictionCount: 100,
  }))

  assert.deepEqual(prediction.scoreSources.recent_practical_calibration, { banker: 0.5, player: 0.5 })
  assert.equal(prediction.predictionFeatures.derived_main_features.recentPracticalCalibration.source, 'unavailable')
  assert.equal(prediction.confidence, baseline.confidence)
})

test('confidence calibration reads only the predicted direction settled samples', () => {
  const prediction = buildLivePrediction(neutralTable({
    bankerCount: 99,
    playerCount: 1,
    settledDirectionalPredictionStats: {
      banker: { settledPredictionCount: 20, hitRate: 0.80 },
      player: { settledPredictionCount: 20, hitRate: 0.10 },
    },
  }))

  assert.equal(prediction.predictedResult, 'banker')
  assert.equal(prediction.predictionFeatures.confidence_calibration.direction, 'banker')
  assert.equal(prediction.predictionFeatures.confidence_calibration.recentPredictionCount, 20)
  assert.equal(prediction.predictionFeatures.confidence_calibration.recentHitRate, 0.80)
})

function oneSupportGroupTable(overrides = {}) {
  return neutralTable({
    bankerCount: 99,
    playerCount: 1,
    ...overrides,
  })
}

test('four prior predictions on the same side do not lower confidence', () => {
  const baseline = buildLivePrediction(oneSupportGroupTable())
  const prediction = buildLivePrediction(oneSupportGroupTable({
    priorMainPredictionStreak: { direction: baseline.predictedResult, count: 4 },
  }))

  assert.equal(prediction.predictedResult, baseline.predictedResult)
  assert.equal(prediction.confidence, baseline.confidence)
  assert.equal(prediction.mainStreakAdjustment.applied, false)
})

test('five prior same-side predictions with only one independent support group lower confidence by five', () => {
  const baseline = buildLivePrediction(oneSupportGroupTable())
  const prediction = buildLivePrediction(oneSupportGroupTable({
    priorMainPredictionStreak: { direction: baseline.predictedResult, count: 5 },
  }))

  assert.equal(prediction.predictedResult, baseline.predictedResult)
  assert.equal(prediction.confidence, Math.max(30, baseline.confidence - 5))
  assert.equal(prediction.mainStreakAdjustment.supportGroupCount, 1)
  assert.equal(prediction.mainStreakAdjustment.applied, true)
  assert.equal(prediction.mainStreakAdjustment.actionSuppressed, false)
  assert.equal(prediction.confidence >= 30, true)
})

test('five prior same-side predictions with two independent support groups do not lower confidence', () => {
  const table = oneSupportGroupTable({
    settledDirectionalPredictionStats: {
      banker: { settledPredictionCount: 20, hitRate: 0.80 },
      player: { settledPredictionCount: 20, hitRate: 0.20 },
    },
  })
  const baseline = buildLivePrediction(table)
  const prediction = buildLivePrediction({
    ...table,
    priorMainPredictionStreak: { direction: baseline.predictedResult, count: 5 },
  })

  assert.equal(baseline.predictedResult, 'banker')
  assert.equal(prediction.predictedResult, baseline.predictedResult)
  assert.equal(prediction.confidence, baseline.confidence)
  assert.equal(prediction.mainStreakAdjustment.supportGroupCount, 2)
  assert.equal(prediction.mainStreakAdjustment.applied, false)
})

test('missing prior prediction streak never applies a penalty', () => {
  const prediction = buildLivePrediction(oneSupportGroupTable())

  assert.equal(prediction.mainStreakAdjustment.applied, false)
  assert.equal(prediction.mainStreakAdjustment.reason, 'streak-unavailable')
})
