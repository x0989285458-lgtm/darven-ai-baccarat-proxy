import test from 'node:test'
import assert from 'node:assert/strict'
import { createProxyState } from '../src/state-store.js'

test('v098.16 builds a temporary road from contiguous exact real rounds when a new-shoe MT table is sparse', () => {
  const state = createProxyState()
  state.setTables([{
    tableId: 'BAG01', displayName: 'MT百家樂第1桌', tableType: 'BAC',
    shoe: 14504, round: 1,
    bankerCount: 0, playerCount: 0, tieCount: 0,
    beadPlateRaw: '', bigRoadRaw: '',
  }])

  state.upsertRoundEvent(exactRound({ round: 1, winner: 'player' }))
  state.upsertRoundEvent(exactRound({ round: 2, winner: 'tie' }))
  state.upsertRoundEvent(exactRound({ round: 3, winner: 'banker' }))

  const table = state.snapshot().tables[0]
  assert.equal(table.beadPlateRaw, '010302')
  assert.notEqual(table.bigRoadRaw, '')
  assert.equal(table.playerCount, 1)
  assert.equal(table.tieCount, 1)
  assert.equal(table.bankerCount, 1)
  assert.equal(table.roadSource, 'real_round_fallback')
})

test('v098.16 does not publish table updates from completed-round ingestion and cannot create post-result predictions', () => {
  const tableUpdates = []
  const state = createProxyState({ onTablesUpdated: (tables) => tableUpdates.push(tables) })
  state.setTables([sparseTable({ shoe: 14504, round: 1 })])
  assert.equal(tableUpdates.length, 1)

  state.upsertRoundEvent(exactRound({ round: 1, winner: 'player' }))

  assert.equal(tableUpdates.length, 1)
  assert.equal(state.snapshot().tables[0].beadPlateRaw, '01')
})

test('v098.16 preserves a real-round fallback road across newer sparse snapshots in the same shoe', () => {
  const state = createProxyState()
  state.setTables([{
    tableId: 'BAG01', displayName: 'MT百家樂第1桌', tableType: 'BAC',
    shoe: 14504, round: 1, bankerCount: 0, playerCount: 0, tieCount: 0,
    beadPlateRaw: '', bigRoadRaw: '',
  }])
  state.upsertRoundEvent(exactRound({ round: 1, winner: 'player' }))

  state.setTables([{
    tableId: 'BAG01', displayName: 'MT百家樂第1桌', tableType: 'BAC',
    shoe: 14504, round: 2, bankerCount: 0, playerCount: 0, tieCount: 0,
    beadPlateRaw: '', bigRoadRaw: '',
  }])

  const table = state.snapshot().tables[0]
  assert.equal(table.beadPlateRaw, '01')
  assert.notEqual(table.bigRoadRaw, '')
  assert.equal(table.roadSource, 'real_round_fallback')
})

test('v098.16 lays out long runs on the six-row big road and does not create a standalone tie cell', () => {
  const state = createProxyState()
  state.setTables([{
    tableId: 'BAG01', displayName: 'MT百家樂第1桌', tableType: 'BAC',
    shoe: 14504, round: 1, bankerCount: 0, playerCount: 0, tieCount: 0,
    beadPlateRaw: '', bigRoadRaw: '',
  }])
  for (let round = 1; round <= 7; round += 1) state.upsertRoundEvent(exactRound({ round, winner: 'player' }))
  state.upsertRoundEvent(exactRound({ round: 8, winner: 'tie' }))
  state.upsertRoundEvent(exactRound({ round: 9, winner: 'banker' }))

  const table = state.snapshot().tables[0]
  assert.equal(table.beadPlateRaw, '010101010101010302')
  assert.equal(table.bigRoadRaw, '01,01,01,01,01,01#02,,,,,01')
})

test('v098.16 lets a complete MT road replace the temporary fallback road', () => {
  const state = createProxyState()
  state.setTables([sparseTable({ shoe: 14504, round: 1 })])
  state.upsertRoundEvent(exactRound({ round: 1, winner: 'player' }))

  state.setTables([{
    ...sparseTable({ shoe: 14504, round: 2 }),
    bankerCount: 1, playerCount: 1, tieCount: 0,
    beadPlateRaw: '0102', bigRoadRaw: '0901#0802',
  }])

  const table = state.snapshot().tables[0]
  assert.equal(table.beadPlateRaw, '0102')
  assert.equal(table.bigRoadRaw, '0901#0802')
  assert.equal(table.roadSource, undefined)
})

test('v098.16 never carries a fallback road into a new shoe', () => {
  const state = createProxyState()
  state.setTables([sparseTable({ shoe: 14504, round: 1 })])
  state.upsertRoundEvent(exactRound({ round: 1, winner: 'player' }))

  state.setTables([sparseTable({ shoe: 14505, round: 1 })])

  const table = state.snapshot().tables[0]
  assert.equal(table.shoe, 14505)
  assert.equal(table.beadPlateRaw, '')
  assert.equal(table.bigRoadRaw, '')
  assert.equal(table.roadSource, undefined)
})

test('v098.16 fails closed when exact real rounds are not contiguous from round one', () => {
  const state = createProxyState()
  state.setTables([sparseTable({ shoe: 14504, round: 2 })])

  state.upsertRoundEvent(exactRound({ round: 2, winner: 'banker' }))

  const table = state.snapshot().tables[0]
  assert.equal(table.beadPlateRaw, '')
  assert.equal(table.bigRoadRaw, '')
})

test('v098.16 rejects zero placeholders and non-exact round payloads from road fallback', () => {
  const state = createProxyState()
  state.setTables([sparseTable({ shoe: 14504, round: 1 })])
  state.upsertRoundEvent({ ...exactRound({ round: 1, winner: 'player' }), rawResult: [0, 0, 0, 0, 0, 0, -1, -1, 0, 0] })
  state.upsertRoundEvent({ ...exactRound({ round: 1, winner: 'player' }), rawResult: { inferred: true } })

  const table = state.snapshot().tables[0]
  assert.equal(table.beadPlateRaw, '')
  assert.equal(table.bigRoadRaw, '')
})

test('v098.16 rejects delayed previous-shoe events without regressing live table identity or road', () => {
  const state = createProxyState()
  state.setTables([sparseTable({ shoe: 14505, round: 1 })])
  state.upsertRoundEvent(exactRound({ shoe: 14505, round: 1, winner: 'player' }))

  state.upsertRoundEvent(exactRound({ shoe: 14504, round: 2, winner: 'banker' }))

  const table = state.snapshot().tables[0]
  assert.equal(table.shoe, 14505)
  assert.equal(table.round, 1)
  assert.equal(table.lastRound.shoe, 14505)
  assert.equal(table.beadPlateRaw, '01')
})

test('v098.16 records out-of-order same-shoe history without regressing round or lastRound', () => {
  const state = createProxyState()
  state.setTables([sparseTable({ shoe: 14504, round: 3 })])
  state.upsertRoundEvent(exactRound({ round: 1, winner: 'player' }))
  state.upsertRoundEvent(exactRound({ round: 2, winner: 'banker' }))
  state.upsertRoundEvent(exactRound({ round: 3, winner: 'player' }))

  state.upsertRoundEvent(exactRound({ round: 2, winner: 'banker' }))

  const table = state.snapshot().tables[0]
  assert.equal(table.round, 3)
  assert.equal(table.lastRound.round, 3)
  assert.equal(table.beadPlateRaw, '010201')
})

test('v098.16 prunes fallback history when a table leaves the active snapshot', () => {
  const state = createProxyState()
  state.setTables([sparseTable({ shoe: 14504, round: 1 })])
  state.upsertRoundEvent(exactRound({ round: 1, winner: 'player' }))
  state.setTables([])
  state.setTables([sparseTable({ shoe: 14504, round: 2 })])

  state.upsertRoundEvent(exactRound({ round: 2, winner: 'banker' }))

  assert.equal(state.snapshot().tables[0].beadPlateRaw, '')
})

test('v098.16 rejects impossible round numbers from fallback history', () => {
  const state = createProxyState()
  state.setTables([sparseTable({ shoe: 14504, round: 1 })])
  state.upsertRoundEvent(exactRound({ round: 101, winner: 'player' }))
  assert.equal(state.snapshot().tables[0].beadPlateRaw, '')
})

test('v098.16 rejects malformed values in all ten raw-result positions', () => {
  for (const rawResult of [
    [14, 7, 4, 9, 0, 0, -1, -1, 5, {}],
    [14, 7, 4, 9, 0, 0, -1, -1, 10, 6],
    [14, 7, 4, 9, 53, 0, -1, -1, 5, 6],
  ]) {
    const state = createProxyState()
    state.setTables([sparseTable({ shoe: 14504, round: 1 })])
    state.upsertRoundEvent({ ...exactRound({ round: 1, winner: 'player' }), rawResult })
    assert.equal(state.snapshot().tables[0].beadPlateRaw, '')
  }
})

function sparseTable({ shoe, round }) {
  return {
    tableId: 'BAG01', displayName: 'MT百家樂第1桌', tableType: 'BAC',
    shoe, round, bankerCount: 0, playerCount: 0, tieCount: 0,
    beadPlateRaw: '', bigRoadRaw: '',
  }
}

function exactRound({ shoe = 14504, round, winner }) {
  return {
    tableId: 'BAG01', shoe, round, winner,
    rawResult: [14, 7, 4, 9, 0, 0, -1, -1, 5, 6],
    sourceAction: '/api/v1/gametype/*/game/*/room/*/table/*/show_poker',
  }
}
