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

test('state store records errors without exposing token secrets', () => {
  const state = createProxyState()
  state.recordError('connect failed token=abc123 secret=hidden')
  const snapshot = state.snapshot()
  assert.equal(snapshot.status.connected, false)
  assert.match(snapshot.status.errorMessage, /connect failed token=\[redacted\]/)
  assert.doesNotMatch(snapshot.status.errorMessage, /abc123|hidden/)
})
