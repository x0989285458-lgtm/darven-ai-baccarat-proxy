import test from 'node:test'
import assert from 'node:assert/strict'
import { ALL_MT_EQUAL_STRATEGY_VERSION, buildLivePrediction, buildPredictionResultRow, calibrateMainConfidenceByHitRate } from '../src/supabase-writer.js'

test('exposes one backend live prediction with a non-fixed 30-70 confidence', () => {
  const table = {
    tableId: 'BAG01', tableType: 'BAC', shoe: 88, round: 20,
    bankerCount: 18, playerCount: 2, tieCount: 1,
    bankerPairCount: 3, playerPairCount: 0,
    beadPlateRaw: '020202020202#020202020202#020202020202',
    bigRoadRaw: '0902,0802,0702#0602,0502,0402',
    bigEyeRaw: '1,1,1', smallRoadRaw: '1,1', cockroachRaw: '1,1',
    nextBankerRaw: { big: '111' }, nextPlayerRaw: { big: '222' },
  }

  const prediction = buildLivePrediction(table)

  assert.equal(ALL_MT_EQUAL_STRATEGY_VERSION, 'v104')
  assert.equal(prediction.strategyVersion, ALL_MT_EQUAL_STRATEGY_VERSION)
  assert.match(prediction.predictedResult, /^(banker|player)$/)
  assert.ok(prediction.confidence > 30)
  assert.ok(prediction.confidence <= 70)
  assert.deepEqual(Object.keys(prediction.sidePredictions).sort(), ['bankerDragon', 'bankerPair', 'playerDragon', 'playerPair', 'superSix', 'tie'].sort())
  assert.deepEqual(Object.keys(prediction.sideActions).sort(), Object.keys(prediction.sidePredictions).sort())
  assert.equal(typeof prediction.sidePredictions.tie, 'number')
  assert.equal(typeof prediction.sideActions.tie, 'boolean')
})

test('live prediction is computed without a revealed round result', () => {
  const table = { tableId: 'BAG02', shoe: 7, round: 12, bankerCount: 9, playerCount: 3, tieCount: 0, beadPlateRaw: '020202020202' }
  const beforeReveal = buildLivePrediction(table)
  const afterRevealFieldsInjected = buildLivePrediction({ ...table, winner: 'player', rawResult: [1, 9, 2, 1] })
  assert.deepEqual(afterRevealFieldsInjected, beforeReveal)
})

test('settlement records the verified final action so provisional history can be quarantined', () => {
  const table = { tableId: 'BAG03', shoe: 9, round: 20, bankerCount: 8, playerCount: 12, tieCount: 1, beadPlateRaw: '0102010201' }
  const precomputed = { ...buildLivePrediction(table), predictedResult: 'player', confidence: 57, scoreTotals: { banker: 20, player: 80 } }
  const row = buildPredictionResultRow({
    tableId: 'BAG03', shoe: 9, round: 21, winner: 'banker',
    rawResult: [1, 9, 2, 10, -1, -1, -1, -1, 1, 9],
    sourceAction: '/api/v1/gametype/*/game/*/room/*/table/*/summary',
  }, table, precomputed)

  assert.equal(row.prediction_features.settlement_final, true)
  assert.equal(row.prediction_features.settlement_source_action, '/api/v1/gametype/*/game/*/room/*/table/*/summary')
})

test('settlement persists the pre-result backend direction and confidence', () => {
  const table = { tableId: 'BAG03', shoe: 9, round: 20, bankerCount: 8, playerCount: 12, tieCount: 1, beadPlateRaw: '0102010201' }
  const precomputed = { ...buildLivePrediction(table), predictedResult: 'player', confidence: 57, scoreTotals: { banker: 20, player: 80 } }
  const row = buildPredictionResultRow({ tableId: 'BAG03', shoe: 9, round: 21, winner: 'banker', rawResult: [1, 9, 2, 10, -1, -1, -1, -1, 1, 9] }, table, precomputed)
  assert.equal(row.predicted_result, 'player')
  assert.equal(row.confidence, 57)
  assert.equal(row.is_hit, false)
  assert.equal(row.prediction_features.prediction_timing, 'pre_result_context')
})

test('calibrates confidence from settled directional history without changing direction', () => {
  assert.equal(ALL_MT_EQUAL_STRATEGY_VERSION, 'v104')
  assert.deepEqual(calibrateMainConfidenceByHitRate(30, {}), {
    rawSignalConfidence: 30, finalConfidence: 46, reason: 'learning-neutral-shrinkage', recentHitRate: null, recentPredictionCount: null, reliability: 0,
  })
  assert.equal(calibrateMainConfidenceByHitRate(70, {}).finalConfidence, 54)
  assert.equal(calibrateMainConfidenceByHitRate(30, { recentHitRate: 0.30, recentPredictionCount: 18 }, 'banker').finalConfidence, 46)
  assert.equal(calibrateMainConfidenceByHitRate(70, {
    settledDirectionalPredictionStats: { banker: { settledPredictionCount: 20, hitRate: 0.80 } },
  }, 'banker').finalConfidence, 70)
  assert.equal(calibrateMainConfidenceByHitRate(50, {
    settledDirectionalPredictionStats: { banker: { settledPredictionCount: 19, hitRate: 0.80 } },
  }, 'banker').finalConfidence, 50)

  const base = { tableId: 'BAG10', shoe: 10, round: 20, bankerCount: 12, playerCount: 8, tieCount: 1, beadPlateRaw: '0201020102' }
  const learning = buildLivePrediction(base)
  const calibrated = buildLivePrediction({
    ...base,
    settledDirectionalPredictionStats: {
      banker: { settledPredictionCount: 20, hitRate: 0.80 },
      player: { settledPredictionCount: 20, hitRate: 0.20 },
    },
  })
  assert.equal(calibrated.predictedResult, learning.predictedResult)
  assert.equal(calibrated.predictionFeatures.confidence_calibration.reason, 'settled-direction-hit-rate-calibration')
  assert.equal(calibrated.predictionFeatures.confidence_calibration.recentHitRate, 0.8)
})
