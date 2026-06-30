import test from 'node:test'
import assert from 'node:assert/strict'
import { createStableReportSession, parseDurationMs, formatReportText } from '../src/stable-report.js'

function makeTable(index, overrides = {}) {
  const labels = ['1', '2', '3', '3A', '5', '6', '7', '8', '9']
  return {
    tableId: `BAG${String(index + 1).padStart(2, '0')}`,
    displayName: `MT百家樂第${labels[index]}桌`,
    tableType: 'BAC',
    bankerCount: 10,
    playerCount: 6,
    tieCount: 1,
    round: 20,
    shoe: 8,
    ...overrides,
  }
}

function makeSnapshot(tables, status = {}) {
  return {
    status: {
      connected: true,
      authenticated: true,
      tableCount: tables.length,
      captureMode: 'chrome',
      ...status,
    },
    tables,
  }
}

test('v015 preflight requires connected authenticated chrome capture and at least 9 tables', () => {
  const session = createStableReportSession({ targetTableCount: 9, startedAt: '2026-06-27T00:00:00.000Z' })

  const good = session.preflight(makeSnapshot(Array.from({ length: 9 }, (_, index) => makeTable(index))))
  assert.equal(good.ok, true)
  assert.equal(good.tableCount, 9)

  const bad = session.preflight(makeSnapshot(Array.from({ length: 8 }, (_, index) => makeTable(index)), { connected: false }))
  assert.equal(bad.ok, false)
  assert.deepEqual(bad.failures, ['proxy not connected', 'tableCount 8 < 9'])
})

test('v015 records first 9 visible tables, hit rate, partial report, and ignores duplicate rounds', () => {
  const session = createStableReportSession({ targetTableCount: 9, startedAt: '2026-06-27T00:00:00.000Z' })
  const tables = Array.from({ length: 10 }, (_, index) => makeTable(index))

  session.recordSnapshot(makeSnapshot(tables), '2026-06-27T00:00:01.000Z')
  session.recordSnapshot(makeSnapshot(tables.map((table, index) => index === 1
    ? { ...table, round: 21, lastRound: { tableId: table.tableId, shoe: 8, round: 21, winner: 2, playerPoint: 3, bankerPoint: 7 } }
    : table
  )), '2026-06-27T00:00:06.000Z')
  session.recordSnapshot(makeSnapshot(tables.map((table, index) => index === 1
    ? { ...table, round: 21, lastRound: { tableId: table.tableId, shoe: 8, round: 21, winner: 2, playerPoint: 3, bankerPoint: 7 } }
    : table
  )), '2026-06-27T00:00:11.000Z')

  const report = session.getReport('2026-06-27T00:00:11.000Z')
  assert.equal(report.targetTableCount, 9)
  assert.equal(report.tables.length, 9)
  assert.equal(report.tables[1].displayName, 'MT百家樂第2桌')
  assert.equal(report.tables[1].rounds, 1)
  assert.equal(report.tables[1].hits, 1)
  assert.equal(report.tables[1].misses, 0)
  assert.equal(report.total.rounds, 1)
  assert.equal(report.total.hits, 1)
  assert.equal(report.total.hitRate, 100)
  assert.equal(report.tables.some((table) => table.displayName.includes('第10桌')), false)
})

test('v019 parses minutes/seconds duration and formats a Traditional Chinese report', () => {
  assert.equal(parseDurationMs('10m'), 600000)
  assert.equal(parseDurationMs('30s'), 30000)

  const session = createStableReportSession({ targetTableCount: 9, startedAt: '2026-06-27T00:00:00.000Z' })
  session.recordSnapshot(makeSnapshot(Array.from({ length: 9 }, (_, index) => makeTable(index))), '2026-06-27T00:00:01.000Z')
  const text = formatReportText(session.getReport('2026-06-27T00:00:05.000Z'))

  assert.match(text, /Draven v037 策略調整成效統計與AB追蹤報表/)
  assert.match(text, /主預測命中率/)
  assert.match(text, /副預測出手命中率/)
  assert.match(text, /MT百家樂第1桌/)
})
