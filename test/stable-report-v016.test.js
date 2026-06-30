import test from 'node:test'
import assert from 'node:assert/strict'
import { createStableReportSession, SIDE_PREDICTION_THRESHOLDS } from '../src/stable-report.js'

function makeTable(overrides = {}) {
  return {
    tableId: 'BAG01',
    displayName: 'MT百家樂第1桌',
    bankerCount: 10,
    playerCount: 8,
    tieCount: 1,
    bankerPairCount: 1,
    playerPairCount: 1,
    beadPlateRaw: '02#01#02#01',
    lastRound: null,
    ...overrides,
  }
}

test('v016 main hit-rate excludes tie rounds from denominator', () => {
  const session = createStableReportSession({ startedAt: '2026-01-01T00:00:00.000Z' })
  session.recordSnapshot({ status: { connected: true, authenticated: true, tableCount: 9 }, tables: [makeTable({ lastRound: { tableId: 'BAG01', shoe: 1, round: 1, winner: 2 } })] }, 't1')
  session.recordSnapshot({ status: { connected: true, authenticated: true, tableCount: 9 }, tables: [makeTable({ bankerCount: 11, playerCount: 8, tieCount: 1, lastRound: { tableId: 'BAG01', shoe: 1, round: 2, winner: 3 } })] }, 't2')
  const report = session.getReport('2026-01-01T00:10:00.000Z')
  assert.equal(report.version, '037')
  assert.equal(report.total.rounds, 2)
  assert.equal(report.total.hits, 1)
  assert.equal(report.total.misses, 0)
  assert.equal(report.total.pushes, 1)
  assert.equal(report.total.mainEvaluated, 1)
  assert.equal(report.total.hitRate, 100)
})

test('v016 side predictions are recorded every round but actions require per-item thresholds', () => {
  assert.deepEqual(SIDE_PREDICTION_THRESHOLDS, {
    tie: 14,
    superSix: 8,
    bankerPair: 9,
    playerPair: 9,
    bankerDragon: 10,
    playerDragon: 10,
  })
  const session = createStableReportSession({ startedAt: '2026-01-01T00:00:00.000Z' })
  session.recordSnapshot({ status: { connected: true, authenticated: true, tableCount: 9 }, tables: [makeTable({ tieCount: 4, bankerPairCount: 2, playerPairCount: 2, lastRound: { tableId: 'BAG01', shoe: 1, round: 1, winner: 1 } })] }, 't1')
  const report = session.getReport('2026-01-01T00:10:00.000Z')
  assert.equal(report.total.sideLearningSamples, 6)
  assert.ok(report.total.sideActions >= 1)
  assert.equal(typeof report.tables[0].sidePredictions.tie.probability, 'number')
  assert.equal(typeof report.tables[0].sidePredictions.tie.actionable, 'boolean')
})

test('v016 confidence is clamped between 30 and 80', () => {
  const session = createStableReportSession({ startedAt: '2026-01-01T00:00:00.000Z' })
  session.recordSnapshot({ status: { connected: true, authenticated: true, tableCount: 9 }, tables: [makeTable({ bankerCount: 999, playerCount: 1, beadPlateRaw: '02#02#02#02#02#02#02#02#02#02', lastRound: { tableId: 'BAG01', shoe: 1, round: 1, winner: 2 } })] }, 't1')
  const report = session.getReport('2026-01-01T00:10:00.000Z')
  assert.equal(report.tables[0].lastConfidence, 80)
})
