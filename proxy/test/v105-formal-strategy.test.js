import test from 'node:test'
import assert from 'node:assert/strict'
import { buildV105FormalPrediction, V105_FORMAL_RELEASE_VERSION, V105_FORMAL_STRATEGY_VERSION } from '../src/v105-formal-strategy.js'
import { buildV104ShadowPrediction } from '../src/v104-shadow-strategy.js'

const table = {
  tableId: 'BAG01', shoe: '1', round: 8,
  beadPlateRaw: '0201010102010101', bigRoadRaw: '0002,,,,,#0001,0001,0001,,,#0002,,,,,#0001,0001,0001,,,', bankerCount: 2, playerCount: 6,
  bigEyeRaw: '1#2#1#2#1#2', smallRoadRaw: '2#1#2#1#2#1', cockroachRaw: '1,1,#2,2,',
  nextBankerRaw: { big_eye: '1#2#1#2#1#2#1', small: '2#1#2#1#2#1#2', cockroach: '1,1,#2,2,1' },
  nextPlayerRaw: { big_eye: '1#2#1#2#1#2#2', small: '2#1#2#1#2#1#1', cockroach: '1,1,#2,2,2' },
}

test('publishes one formal v105 identity', () => {
  assert.equal(V105_FORMAL_STRATEGY_VERSION, 'v105')
  assert.equal(V105_FORMAL_RELEASE_VERSION, 'v105.0.0-formal.8')
})

test('prioritizes the completed generic big-road cycle over continuation in formal v105', () => {
  const prediction = buildV105FormalPrediction(table, [], {})
  assert.equal(prediction.strategyVersion, 'v105')
  assert.equal(prediction.buildVersion, 'v105')
  assert.equal(prediction.scoreSources.roadmap_trend_signals.banker > prediction.scoreSources.roadmap_trend_signals.player, true)
  assert.equal(prediction.diagnostics.roadCycles.main.direction, 'banker')
  assert.equal(prediction.diagnostics.roadCycles.main.reasonText, '大路週期1－3連續2次，2路輔助確認，下一位置支持莊')
  assert.equal(prediction.diagnostics.roadCycles.auxiliary.beadPlate.countedAsIndependentSupport, false)
  assert.equal(prediction.diagnostics.roadCycles.auxiliary.bigEye.validationOnly, true)
})

test('preserves the v104 baseline exactly when the cycle validation gate is not eligible', () => {
  const noAuxiliary = { ...table, bigEyeRaw: '', smallRoadRaw: '', cockroachRaw: '', nextBankerRaw: {}, nextPlayerRaw: {} }
  const baseline = buildV104ShadowPrediction(noAuxiliary, [], {}, { historyStrategyVersion: ['v104', 'v105'], cyclePriority: false })
  const prediction = buildV105FormalPrediction(noAuxiliary, [], {})
  assert.equal(prediction.cycleApplied, false)
  assert.equal(prediction.predictedResult, baseline.predictedResult)
  assert.equal(prediction.confidence, baseline.confidence)
  assert.equal(prediction.sameSideStreak, baseline.sameSideStreak)
  assert.equal(prediction.baselineV104PredictedResult, baseline.predictedResult)
  assert.equal(prediction.baselineV104SameSideStreak, baseline.sameSideStreak)
})
