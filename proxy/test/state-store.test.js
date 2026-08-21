import test from 'node:test'
import assert from 'node:assert/strict'
import { createProxyState } from '../src/state-store.js'

test('state store keeps normalized tables and connection status for admin/frontend', () => {
  const state = createProxyState()
  state.setStatus({ connected: true, lastMessageAt: '2026-06-25T12:00:00.000Z', reconnectCount: 2 })
  state.setTables([
    { tableId: 'BAG01', displayName: 'MT百家樂第1桌', round: 8 },
    { tableId: 'BAG02', displayName: 'MT百家樂第2桌', round: 9 },
  ])

  const snapshot = state.snapshot()
  assert.equal(snapshot.status.connected, true)
  assert.equal(snapshot.status.reconnectCount, 2)
  assert.equal(snapshot.tables.length, 2)
  assert.equal(snapshot.tables[0].tableId, 'BAG01')
})

test('strict real-card mode does not emit inferred no-card rounds from table deltas', () => {
  const emitted = []
  const state = createProxyState({ inferSnapshotRounds: false, onRoundEvent: (round) => emitted.push(round) })
  state.setTables([{ tableId: 'BAG01', tableType: 'BAC', shoe: 1, round: 10, bankerCount: 5, playerCount: 5, tieCount: 0 }])
  state.setTables([{ tableId: 'BAG01', tableType: 'BAC', shoe: 1, round: 11, bankerCount: 6, playerCount: 5, tieCount: 0 }])
  assert.equal(emitted.length, 0)

  state.upsertRoundEvent({ tableId: 'BAG01', shoe: 1, round: 11, winner: 'banker', rawResult: [1, 2, 3, 4, 0, 0, -1, -1, 5, 4] })
  assert.equal(emitted.length, 1)
})

test('passive table mounting updates UI state without inferred round or notification work', () => {
  const emitted = []
  const notified = []
  const state = createProxyState({
    onRoundEvent: (round) => emitted.push(round),
    onTablesUpdated: (tables) => notified.push(tables),
  })
  state.setTables([{ tableId: 'BAG01', tableType: 'BAC', shoe: 1, round: 10, bankerCount: 5, playerCount: 5, tieCount: 0 }], { notify: false, inferRounds: false })
  state.setTables([{ tableId: 'BAG01', tableType: 'BAC', shoe: 1, round: 11, bankerCount: 6, playerCount: 5, tieCount: 0 }], { notify: false, inferRounds: false })
  assert.equal(state.snapshot().tables[0].round, 11)
  assert.equal(emitted.length, 0)
  assert.equal(notified.length, 0)
})

test('state store records errors without exposing token secrets', () => {
  const state = createProxyState()
  state.recordError('connect failed token=abc123 secret=hidden')
  const snapshot = state.snapshot()
  assert.equal(snapshot.status.connected, false)
  assert.match(snapshot.status.errorMessage, /connect failed token=\[redacted\]/)
  assert.doesNotMatch(snapshot.status.errorMessage, /abc123|hidden/)
})
