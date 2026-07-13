import test from 'node:test'
import assert from 'node:assert/strict'
import { createStableReportSession, formatReportText } from '../src/stable-report.js'

function makeTable(overrides = {}) {
  return {
    tableId: 'BAG05',
    shoe: 1,
    displayName: 'MT百家樂第5桌',
    tableType: 'BAC',
    round: 1,
    bankerCount: 42,
    playerCount: 18,
    tieCount: 0,
    beadPlateRaw: '02#02#02#02#02#01#02#02',
    bigRoadRaw: '0102,0202,0302,0402,#0101,#0102,0202',
    ...overrides,
  }
}

function snapshot(table) {
  return { status: { connected: true, authenticated: true, tableCount: 9 }, tables: [table] }
}

test('v037 report aggregates strategy adjustment AB hit rates across evaluated rounds', () => {
  const session = createStableReportSession({ startedAt: '2026-01-01T00:00:00.000Z' })

  session.recordSnapshot(snapshot(makeTable({ round: 0, lastRound: null })), 't0')
  session.recordSnapshot(snapshot(makeTable({ round: 1, lastRound: { tableId: 'BAG05', shoe: 1, round: 1, winner: 1 } })), 't1')
  session.recordSnapshot(snapshot(makeTable({ round: 2, lastRound: { tableId: 'BAG05', shoe: 1, round: 2, winner: 1 } })), 't2')
  session.recordSnapshot(snapshot(makeTable({ round: 3, lastRound: { tableId: 'BAG05', shoe: 1, round: 3, winner: 1 } })), 't3')
  session.recordSnapshot(snapshot(makeTable({ round: 4, lastRound: { tableId: 'BAG05', shoe: 1, round: 4, winner: 1 } })), 't4')
  session.recordSnapshot(snapshot(makeTable({ round: 5, lastRound: { tableId: 'BAG05', shoe: 1, round: 5, winner: 1 } })), 't5')
  session.recordSnapshot(snapshot(makeTable({ round: 6, lastRound: { tableId: 'BAG05', shoe: 1, round: 6, winner: 1 } })), 't6')

  const report = session.getReport('2026-01-01T00:10:00.000Z')

  assert.equal(report.version, '037')
  assert.deepEqual(report.strategyAdjustmentSummary, {
    totalEvaluated: 6,
    byMode: {
      normal: { evaluated: 3, hits: 0, misses: 3, hitRate: 0 },
      weakTableDeweight: { evaluated: 0, hits: 0, misses: 0, hitRate: 0 },
      reverseCorrection: { evaluated: 3, hits: 0, misses: 3, hitRate: 0 },
      strongTableBoost: { evaluated: 0, hits: 0, misses: 0, hitRate: 0 },
    },
  })
  assert.equal(report.tables[0].strategyAdjustment.mode, 'reverse-correction')
  assert.equal(report.tables[0].lastConfidence, 48)

  const text = formatReportText(report)
  assert.match(text, /策略調整成效/)
  assert.match(text, /反向修正/)
})
