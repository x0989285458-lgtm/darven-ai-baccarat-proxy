import test from 'node:test'
import assert from 'node:assert/strict'
import { createTablePerformanceTracker, evaluateFiveRoadPrediction } from '../src/stable-report.js'

function bankerBiasedTable() {
  return {
    displayName: 'MT百家樂第5桌',
    beadPlateRaw: 'B,B,B,B,B,P,B,B',
    bigRoadRaw: 'B,B,B,B,B,P,B,B',
    bankerCount: 42,
    playerCount: 18,
  }
}

test('v036 weak-table strategy applies explicit deweight status and caps confidence below 55', () => {
  const tracker = createTablePerformanceTracker()
  ;[
    ['莊', '閒'], ['莊', '閒'], ['莊', '閒'], ['閒', '莊'], ['莊', '閒'],
  ].forEach(([prediction, winner]) => tracker.record({ prediction, winner }))

  const prediction = evaluateFiveRoadPrediction(bankerBiasedTable(), { tablePerformance: tracker.summary() })

  assert.equal(prediction.tablePerformance.tier, 'low')
  assert.equal(prediction.strategyAdjustment.mode, 'weak-table-deweight')
  assert.equal(prediction.strategyAdjustment.statusText, '弱桌降權中')
  assert.ok(prediction.confidence <= 55)
  assert.ok(prediction.confidence >= 30)
})

test('v036 reverse correction activates only for weak table with three misses and opposite road signal', () => {
  const tracker = createTablePerformanceTracker()
  ;[
    ['莊', '閒'], ['莊', '閒'], ['莊', '閒'],
  ].forEach(([prediction, winner]) => tracker.record({ prediction, winner }))

  const prediction = evaluateFiveRoadPrediction(bankerBiasedTable(), { tablePerformance: tracker.summary() })

  assert.equal(prediction.tablePerformance.currentMissStreak, 3)
  assert.equal(prediction.strategyAdjustment.mode, 'reverse-correction')
  assert.equal(prediction.strategyAdjustment.statusText, '反向修正啟用')
  assert.equal(prediction.main, '閒')
  assert.ok(prediction.confidence <= 55)
})

test('v036 strong table applies conservative boost while keeping confidence within 80 cap', () => {
  const tracker = createTablePerformanceTracker()
  ;[
    ['莊', '莊'], ['莊', '莊'], ['閒', '閒'], ['莊', '莊'], ['閒', '閒'], ['莊', '莊'],
  ].forEach(([prediction, winner]) => tracker.record({ prediction, winner }))

  const prediction = evaluateFiveRoadPrediction(bankerBiasedTable(), { tablePerformance: tracker.summary() })

  assert.equal(prediction.tablePerformance.tier, 'strong')
  assert.equal(prediction.strategyAdjustment.mode, 'strong-table-boost')
  assert.equal(prediction.strategyAdjustment.statusText, '強桌加權中')
  assert.ok(prediction.confidence <= 80)
})
