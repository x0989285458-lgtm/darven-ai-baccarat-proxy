import test from 'node:test'
import assert from 'node:assert/strict'
import { extractRoundEventFromCdpFrame } from '../src/chrome-capture.js'
import { createProxyState } from '../src/state-store.js'

test('v010 extracts table-specific summary result after entering a baccarat table', () => {
  const frame = JSON.stringify({
    action: '/api/v1/gametype/*/game/*/room/*/table/*/summary',
    err: 0,
    body: {
      table_id: 'BAG03',
      shoe: 912,
      round: 43,
      result: [26, 20, 39, 23, 14, 0, -1, -1, 1, 7],
    },
  })

  const event = extractRoundEventFromCdpFrame(frame)

  assert.equal(event.tableId, 'BAG03')
  assert.equal(event.shoe, 912)
  assert.equal(event.round, 43)
  assert.equal(event.playerPoint, 1)
  assert.equal(event.bankerPoint, 7)
  assert.deepEqual(event.rawResult, [26, 20, 39, 23, 14, 0, -1, -1, 1, 7])
})

test('v010 keeps table data fresh from table-specific frames even when /tables frames stop', () => {
  const state = createProxyState()
  state.setTables([
    { tableId: 'BAG03', displayName: 'MT百家樂第3桌', tableType: 'BAC', round: 42, shoe: 912, beadPlateRaw: '01', bigRoadRaw: '01' },
  ])

  state.upsertRoundEvent({
    tableId: 'BAG03',
    shoe: 912,
    round: 43,
    playerPoint: 1,
    bankerPoint: 7,
    rawResult: [26, 20, 39, 23, 14, 0, -1, -1, 1, 7],
    sourceAction: '/api/v1/gametype/*/game/*/room/*/table/*/summary',
  })

  const snapshot = state.snapshot()
  assert.equal(snapshot.status.lastRoundAt.includes('T'), true)
  assert.equal(snapshot.tables[0].round, 43)
  assert.equal(snapshot.tables[0].shoe, 912)
  assert.equal(snapshot.tables[0].lastRound.playerPoint, 1)
  assert.equal(snapshot.tables[0].lastRound.bankerPoint, 7)
})
