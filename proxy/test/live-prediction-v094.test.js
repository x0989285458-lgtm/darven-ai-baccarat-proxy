import test from 'node:test'
import assert from 'node:assert/strict'
import { ALL_MT_EQUAL_STRATEGY_VERSION, buildLivePrediction, buildPredictionResultRow } from '../src/supabase-writer.js'

test('v094 exposes one backend live prediction with a non-fixed 30-70 confidence', () => {
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

  assert.equal(ALL_MT_EQUAL_STRATEGY_VERSION, 'v096_副預測權重與信心校準版')
  assert.equal(prediction.strategyVersion, ALL_MT_EQUAL_STRATEGY_VERSION)
  assert.match(prediction.predictedResult, /^(banker|player)$/)
  assert.ok(prediction.confidence > 30)
  assert.ok(prediction.confidence <= 70)
  assert.deepEqual(Object.keys(prediction.sidePredictions).sort(), ['bankerDragon', 'bankerPair', 'playerDragon', 'playerPair', 'superSix', 'tie'].sort())
  assert.deepEqual(Object.keys(prediction.sideActions).sort(), Object.keys(prediction.sidePredictions).sort())
  assert.equal(typeof prediction.sidePredictions.tie, 'number')
  assert.equal(typeof prediction.sideActions.tie, 'boolean')
})

test('v094 live prediction is computed without a revealed round result', () => {
  const table = { tableId: 'BAG02', shoe: 7, round: 12, bankerCount: 9, playerCount: 3, tieCount: 0, beadPlateRaw: '020202020202' }
  const beforeReveal = buildLivePrediction(table)
  const afterRevealFieldsInjected = buildLivePrediction({ ...table, winner: 'player', rawResult: [1, 9, 2, 1] })
  assert.deepEqual(afterRevealFieldsInjected, beforeReveal)
})

test('v094 settlement persists the pre-result backend direction and confidence', () => {
  const table = { tableId: 'BAG03', shoe: 9, round: 20, bankerCount: 8, playerCount: 12, tieCount: 1, beadPlateRaw: '0102010201' }
  const precomputed = { source: 'backend', predictedResult: 'player', confidence: 57, scoreTotals: { banker: 20, player: 80 } }
  const row = buildPredictionResultRow({ tableId: 'BAG03', shoe: 9, round: 21, winner: 'banker', rawResult: [1, 9, 2, 10, -1, -1, -1, -1, 1, 9] }, table, precomputed)
  assert.equal(row.predicted_result, 'player')
  assert.equal(row.confidence, 57)
  assert.equal(row.is_hit, false)
  assert.equal(row.prediction_features.prediction_timing, 'pre_result_context')
})
