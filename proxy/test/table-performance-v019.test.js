import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createStableReportSession,
  createTablePerformanceTracker,
  evaluateFiveRoadPrediction,
} from '../src/stable-report.js'

function makeTable(overrides = {}) {
  return {
    tableId: 'BAG01',
    displayName: 'MT百家樂第1桌',
    bankerCount: 20,
    playerCount: 18,
    tieCount: 2,
    bankerPairCount: 1,
    playerPairCount: 1,
    beadPlateRaw: '02#02#02#02#01#01#02#01',
    bigRoadRaw: '0102,0202,#0102,#0101,#0102',
    nextBankerRaw: '111',
    nextPlayerRaw: '222',
    ...overrides,
  }
}

test('v019 table performance tracker keeps banker/player prediction but lowers confidence for weak tables', () => {
  const tracker = createTablePerformanceTracker({ windowSize: 6 })
  for (const hit of [false, false, true, false, false, false]) tracker.record({ prediction: '莊', winner: hit ? '莊' : '閒' })
  const prediction = evaluateFiveRoadPrediction(makeTable(), { tablePerformance: tracker.summary() })
  assert.equal(['莊', '閒'].includes(prediction.main), true)
  assert.equal(prediction.tablePerformance.hitRate, 16.7)
  assert.equal(prediction.tablePerformance.tier, 'low')
  assert.ok(prediction.confidence <= 52)
  assert.equal(prediction.weights.tablePerformance, 0.10)
})

test('v019 stable report continuously verifies each table hit rate while still outputting banker/player prediction', () => {
  const session = createStableReportSession({ startedAt: '2026-01-01T00:00:00.000Z' })
  session.recordSnapshot({ status: { connected: true, authenticated: true, tableCount: 9 }, tables: [makeTable({ lastRound: { tableId: 'BAG01', shoe: 1, round: 1, winner: 1 } })] }, 't1')
  session.recordSnapshot({ status: { connected: true, authenticated: true, tableCount: 9 }, tables: [makeTable({ lastRound: { tableId: 'BAG01', shoe: 1, round: 2, winner: 2 } })] }, 't2')
  const report = session.getReport('2026-01-01T00:10:00.000Z')
  assert.equal(report.version, '037')
  assert.equal(report.tables[0].mainEvaluated, 2)
  assert.equal(['莊', '閒'].includes(report.tables[0].lastPrediction), true)
  assert.ok(report.tables[0].tablePerformance.windowSize >= 2)
  assert.match(report.tables[0].tablePerformance.tier, /low|normal|strong|learning/)
})
