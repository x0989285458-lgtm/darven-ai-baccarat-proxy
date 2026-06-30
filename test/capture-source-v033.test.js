import test from 'node:test'
import assert from 'node:assert/strict'
import { createProxyState } from '../src/state-store.js'
import { describeCaptureStatus, chooseCaptureSource } from '../src/capture-source.js'
import { extractTablesFromCdpFrame } from '../src/chrome-capture.js'

test('v033 status distinguishes node websocket, local chrome, and future cloud browser capture sources', () => {
  const state = createProxyState()
  state.setStatus({ captureSource: 'node_ws', connected: false, errorMessage: 'Unexpected server response: 403' })
  assert.equal(describeCaptureStatus(state.snapshot().status), 'Token直連被拒絕：Unexpected server response: 403')

  state.setStatus({ captureSource: 'local_chrome', chromeStarted: true, connected: true, authenticated: false, errorMessage: null })
  assert.equal(describeCaptureStatus(state.snapshot().status), 'Chrome已連接，等待MT登入驗證')

  state.setStatus({ captureSource: 'cloud_browser', connected: true, authenticated: true, tableCount: 9 })
  assert.equal(describeCaptureStatus(state.snapshot().status), '雲端瀏覽器已抓到9桌')
})

test('v033 keeps one normalized snapshot interface for chrome frames and future cloud ingestion', () => {
  const tables = extractTablesFromCdpFrame(JSON.stringify({
    action: '/api/v1/table/tables',
    msg: { tables: [{ id: 1, name: 'MT百家樂第1桌', game_type: 3, shoe: 8, round: 12, roads: { bead: ['B', 'P'] } }] },
  }))
  const state = createProxyState()
  state.setStatus({ captureSource: 'local_chrome', cloudReady: true })
  state.setTables(tables)
  const snapshot = state.snapshot()

  assert.equal(snapshot.status.captureSource, 'local_chrome')
  assert.equal(snapshot.status.cloudReady, true)
  assert.equal(snapshot.status.tableCount, 1)
  assert.equal(snapshot.tables[0].id ?? snapshot.tables[0].tableId, 1)
})

test('v033 chooses chrome capture before node token direct when chrome url is available', () => {
  assert.equal(chooseCaptureSource({ chromeCaptureUrl: 'https://gsa.ofalive99.net/?token=abc', token: 'abc' }), 'local_chrome')
  assert.equal(chooseCaptureSource({ chromeCaptureUrl: '', token: 'abc' }), 'node_ws')
  assert.equal(chooseCaptureSource({ chromeCaptureUrl: '', token: '' }), 'offline')
})
