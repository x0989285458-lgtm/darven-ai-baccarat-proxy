import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createStableReportSession,
  createTablePerformanceTracker,
  evaluateFiveRoadPrediction,
} from '../src/stable-report.js'

function bankerBiasedTable(overrides = {}) {
  return {
    tableId: 'BAG08',
    shoe: 1,
    round: 0,
    displayName: 'MT百家樂第8桌',
    bankerCount: 30,
    playerCount: 10,
    tieCount: 2,
    bankerPairCount: 1,
    playerPairCount: 1,
    beadPlateRaw: '02#02#02#02#02#01#02#02',
    bigRoadRaw: '0102,0202,#0102,#0102,#0102',
    nextBankerRaw: '111',
    nextPlayerRaw: '222',
    ...overrides,
  }
}

test('low hit-rate table records actual-side bias and corrects direction faster', () => {
  const tracker = createTablePerformanceTracker({ windowSize: 8 })
  for (const winner of ['閒', '閒', '莊', '閒', '閒']) tracker.record({ prediction: '莊', winner })

  const prediction = evaluateFiveRoadPrediction(bankerBiasedTable(), { tablePerformance: tracker.summary() })

  assert.equal(prediction.tablePerformance.tier, 'low')
  assert.equal(prediction.tablePerformance.actualBias, '閒')
  assert.equal(prediction.main, '閒')
  assert.ok(prediction.confidence <= 42)
})

test('main prediction removes card/shoe weights and uses unified recent-trend weight', () => {
  const prediction = evaluateFiveRoadPrediction(bankerBiasedTable({
    // alternating tail should produce a road-trend score independent of raw bead/big counts
    beadPlateRaw: '02#01#02#01#02#01',
    bigRoadRaw: '0102,#0101,#0102,#0101,#0102,#0101',
  }))

  assert.equal(prediction.weights.cardPoints, undefined)
  assert.equal(prediction.weights.shoeRemaining, undefined)
  assert.equal(prediction.sourceScores.cardPoints, undefined)
  assert.equal(prediction.sourceScores.shoeRemaining, undefined)
  assert.equal(prediction.weights.recentTrend, 0.17)
  assert.ok(prediction.sourceScores.recentTrend)
  assert.ok(prediction.weightAblation.sources.some((item) => item.key === 'recentTrend'))
})

test('prediction exposes weight ablation and confidence calibration diagnostics', () => {
  const prediction = evaluateFiveRoadPrediction(bankerBiasedTable())

  assert.ok(prediction.weightAblation)
  assert.ok(Array.isArray(prediction.weightAblation.sources))
  assert.ok(prediction.weightAblation.sources.some((item) => item.key === 'shoeRoad'))
  assert.ok(prediction.confidenceCalibration)
  assert.equal(typeof prediction.confidenceCalibration.rawConfidence, 'number')
  assert.equal(typeof prediction.confidenceCalibration.finalConfidence, 'number')
})

test('stable report stores only immutable prediction identity diagnostics', () => {
  const session = createStableReportSession({ startedAt: '2026-01-01T00:00:00.000Z' })
  session.recordSnapshot({ status: { connected: true, authenticated: true, tableCount: 9 }, tables: [bankerBiasedTable()] }, 't0')
  session.recordSnapshot({ status: { connected: true, authenticated: true, tableCount: 9 }, tables: [bankerBiasedTable({ round: 1, lastRound: { tableId: 'BAG08', shoe: 1, round: 1, winner: 1 } })] }, 't1')
  session.recordSnapshot({ status: { connected: true, authenticated: true, tableCount: 9 }, tables: [bankerBiasedTable({ round: 2, lastRound: { tableId: 'BAG08', shoe: 1, round: 2, winner: 2 } })] }, 't2')
  const report = session.getReport('2026-01-01T00:10:00.000Z')

  assert.equal(report.version, '100')
  assert.deepEqual(Object.keys(report.tables[0].predictionDiagnostics).sort(), ['predictionTiming', 'strategyVersion'])
})
