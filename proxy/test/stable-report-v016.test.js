import test from 'node:test'
import assert from 'node:assert/strict'
import { createStableReportSession, MAIN_ACTION_CONFIDENCE_THRESHOLD, SIDE_PREDICTION_THRESHOLDS } from '../src/stable-report.js'

function makeTable(overrides = {}) {
  return {
    tableId: 'BAG01',
    shoe: 1,
    round: 0,
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
  const confidentBankerTable = { bankerCount: 30, playerCount: 1, tieCount: 0, beadPlateRaw: '02#02#02#02#02#02#02#02', bigRoadRaw: '0202,0202,0202,0202' }
  session.recordSnapshot({ status: { connected: true, authenticated: true, tableCount: 9 }, tables: [makeTable(confidentBankerTable)] }, 't0')
  session.recordSnapshot({ status: { connected: true, authenticated: true, tableCount: 9 }, tables: [makeTable({ ...confidentBankerTable, round: 1, lastRound: { tableId: 'BAG01', shoe: 1, round: 1, winner: 2 } })] }, 't1')
  session.recordSnapshot({ status: { connected: true, authenticated: true, tableCount: 9 }, tables: [makeTable({ ...confidentBankerTable, round: 2, lastRound: { tableId: 'BAG01', shoe: 1, round: 2, winner: 3 } })] }, 't2')
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
    tie: 25,
    superSix: 45,
    bankerPair: 43,
    playerPair: 43,
    bankerDragon: 30,
    playerDragon: 30,
  })
  const session = createStableReportSession({ startedAt: '2026-01-01T00:00:00.000Z' })
  const table = makeTable({ bankerCount: 5, playerCount: 5, tieCount: 90, bankerPairCount: 2, playerPairCount: 2 })
  session.recordSnapshot({ status: { connected: true, authenticated: true, tableCount: 9 }, tables: [table] }, 't0')
  session.recordSnapshot({ status: { connected: true, authenticated: true, tableCount: 9 }, tables: [{ ...table, round: 1, lastRound: { tableId: 'BAG01', shoe: 1, round: 1, winner: 1 } }] }, 't1')
  const report = session.getReport('2026-01-01T00:10:00.000Z')
  assert.deepEqual({
    sideLearningSamples: report.total.sideLearningSamples,
    sideActions: report.total.sideActions,
    sideHits: report.total.sideHits,
    tie: report.tables[0].sidePredictions.tie,
  }, {
    sideLearningSamples: 6,
    sideActions: 0,
    sideHits: 0,
    tie: { probability: 71.0466491458607, actionable: false, samples: 1, actions: 0, hits: 0, hitRate: 0 },
  })
})

test('v088 low-confidence main predictions stay visible and are still evaluated without observe', () => {
  assert.equal(MAIN_ACTION_CONFIDENCE_THRESHOLD, 30)
  const session = createStableReportSession({ startedAt: '2026-01-01T00:00:00.000Z' })
  session.recordSnapshot({ status: { connected: true, authenticated: true, tableCount: 9 }, tables: [makeTable({ bankerCount: 1, playerCount: 1, tieCount: 0, beadPlateRaw: '', bigRoadRaw: '' })] }, 't0')
  session.recordSnapshot({ status: { connected: true, authenticated: true, tableCount: 9 }, tables: [makeTable({
    bankerCount: 1,
    playerCount: 1,
    tieCount: 0,
    beadPlateRaw: '',
    bigRoadRaw: '',
    round: 1,
    lastRound: { tableId: 'BAG01', shoe: 1, round: 1, winner: 2 },
  })] }, 't1')
  const report = session.getReport('2026-01-01T00:10:00.000Z')
  assert.equal(report.tables[0].lastPrediction, '莊')
  assert.equal(report.tables[0].lastConfidence, 46)
  assert.equal(report.total.rounds, 1)
  assert.equal(report.total.mainEvaluated, 1)
  assert.deepEqual({ hits: report.total.hits, misses: report.total.misses }, { hits: 1, misses: 0 })
})

test('v088 confidence is clamped between 30 and 70', () => {
  const session = createStableReportSession({ startedAt: '2026-01-01T00:00:00.000Z' })
  const table = makeTable({ bankerCount: 999, playerCount: 1, beadPlateRaw: '02#02#02#02#02#02#02#02#02#02' })
  session.recordSnapshot({ status: { connected: true, authenticated: true, tableCount: 9 }, tables: [table] }, 't0')
  session.recordSnapshot({ status: { connected: true, authenticated: true, tableCount: 9 }, tables: [{ ...table, round: 1, lastRound: { tableId: 'BAG01', shoe: 1, round: 1, winner: 2 } }] }, 't1')
  const report = session.getReport('2026-01-01T00:10:00.000Z')
  assert.equal(report.tables[0].lastConfidence, 46)
})
