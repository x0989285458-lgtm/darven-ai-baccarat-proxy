import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createStableReportSession,
  createTablePerformanceTracker,
  evaluateFiveRoadPrediction,
} from '../src/stable-report.js'

function playerBiasedTable(overrides = {}) {
  return {
    tableId: 'BAG02',
    displayName: 'MT百家樂第2桌',
    bankerCount: 10,
    playerCount: 28,
    tieCount: 2,
    bankerPairCount: 1,
    playerPairCount: 1,
    beadPlateRaw: '01#01#01#01#01#02#01#01',
    bigRoadRaw: '0101,0201,#0101,#0101,#0101',
    nextBankerRaw: '222',
    nextPlayerRaw: '111',
    ...overrides,
  }
}

test('v020 detects three straight wrong predictions and applies reverse correction without observe', () => {
  const tracker = createTablePerformanceTracker({ windowSize: 8 })
  for (const winner of ['莊', '莊', '莊']) tracker.record({ prediction: '閒', winner })
  const prediction = evaluateFiveRoadPrediction(playerBiasedTable(), { tablePerformance: tracker.summary() })

  assert.equal(prediction.tablePerformance.currentMissStreak, 3)
  assert.equal(prediction.tablePerformance.reverseSignal, '莊')
  assert.equal(prediction.main, '莊')
  assert.equal(['莊', '閒'].includes(prediction.main), true)
  assert.ok(prediction.confidence <= 40)
})

test('v020 caps very low hit-rate tables faster even before the long window fills', () => {
  const tracker = createTablePerformanceTracker({ windowSize: 18 })
  for (const hit of [false, false, false, true, false]) tracker.record({ prediction: '莊', winner: hit ? '莊' : '閒' })
  const prediction = evaluateFiveRoadPrediction(playerBiasedTable({ bankerCount: 30, playerCount: 12 }), { tablePerformance: tracker.summary() })

  assert.equal(prediction.tablePerformance.tier, 'low')
  assert.equal(prediction.tablePerformance.hitRate, 20)
  assert.ok(prediction.confidence <= 40)
})

test('v020 stable report exposes reverse/deweight status and version 023', () => {
  const session = createStableReportSession({ startedAt: '2026-01-01T00:00:00.000Z' })
  session.recordSnapshot({ status: { connected: true, authenticated: true, tableCount: 9 }, tables: [playerBiasedTable({ lastRound: { tableId: 'BAG02', shoe: 1, round: 1, winner: 2 } })] }, 't1')
  session.recordSnapshot({ status: { connected: true, authenticated: true, tableCount: 9 }, tables: [playerBiasedTable({ lastRound: { tableId: 'BAG02', shoe: 1, round: 2, winner: 2 } })] }, 't2')
  session.recordSnapshot({ status: { connected: true, authenticated: true, tableCount: 9 }, tables: [playerBiasedTable({ lastRound: { tableId: 'BAG02', shoe: 1, round: 3, winner: 2 } })] }, 't3')
  const report = session.getReport('2026-01-01T00:10:00.000Z')

  assert.equal(report.version, '037')
  assert.equal(report.tables[0].tablePerformance.currentMissStreak, 3)
  assert.equal(report.tables[0].tablePerformance.reverseSignal, '莊')
  assert.equal(['莊', '閒'].includes(report.tables[0].lastPrediction), true)
})
