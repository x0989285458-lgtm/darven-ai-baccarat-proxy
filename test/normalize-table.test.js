import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeMtTable, normalizeMtTables } from '../src/normalize-table.js'

test('normalizes one MT baccarat table for frontend/backend payloads', () => {
  const raw = {
    table_id: 'BAG01',
    table_name: '1',
    table_type: 'BAC',
    trend: {
      current_round: 42,
      current_shoe: 18,
      total_round_banker: 20,
      total_round_player: 18,
      total_round_tie: 4,
      bead_plate2: '010203',
      big2: '0402,,,,,#0901',
      big_eye2: '1,,,,#2',
      small2: '2,,,,#1',
      cockroach2: '2,2,,,,#1',
      next_banker2: { bead_plate: '010202' },
      next_player2: { bead_plate: '010201' },
    },
  }

  assert.deepEqual(normalizeMtTable(raw, 0), {
    tableId: 'BAG01',
    displayName: 'MT百家樂第1桌',
    tableType: 'BAC',
    shoe: 18,
    round: 42,
    bankerCount: 20,
    playerCount: 18,
    tieCount: 4,
    bankerPairCount: 0,
    playerPairCount: 0,
    beadPlateRaw: '010203',
    bigRoadRaw: '0402,,,,,#0901',
    bigEyeRaw: '1,,,,#2',
    smallRoadRaw: '2,,,,#1',
    cockroachRaw: '2,2,,,,#1',
    nextBankerRaw: { bead_plate: '010202' },
    nextPlayerRaw: { bead_plate: '010201' },
    dealerName: null,
    totalPlayers: 0,
    roomId: null,
    state: null,
    orderState: null,
    sourceUpdatedAt: null,
  })
})

test('filters non baccarat tables and sorts by table id', () => {
  const rows = normalizeMtTables([
    { table_id: 'XYZ99', table_type: 'SLOT', trend: {} },
    { table_id: 'BAG02', table_type: 'BAC', trend: { current_round: 2 } },
    { table_id: 'BAG01', table_type: 'BAS', trend: { current_round: 1 } },
  ])
  assert.deepEqual(rows.map((row) => row.tableId), ['BAG01', 'BAG02'])
})
