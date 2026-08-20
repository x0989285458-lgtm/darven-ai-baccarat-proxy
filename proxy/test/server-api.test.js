import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'

test('HTTP API exposes health, status, tables and latest snapshot', async () => {
  const app = createApp({ autoConnect: false })
  app.state.setStatus({ connected: true, lastMessageAt: '2026-06-25T12:00:00.000Z' })
  app.state.setTables([{ tableId: 'BAG01', displayName: 'MT百家樂第1桌', shoe: 88, round: 12 }])

  const health = await app.inject({ method: 'GET', url: '/health' })
  assert.equal(health.statusCode, 200)
  assert.deepEqual(JSON.parse(health.body), {
    ok: true, service: 'Draven MT資料代理伺服器', version: 'v106', buildVersion: 'v106',
    releaseVersion: 'v106.0.0-formal.23', packageVersion: '1.0.80', commit: null, deployMode: 'local',
    health: 'ok', degraded: false, reason: null,
    runtimeStatus: { ready: false, degraded: false, reason: 'active_strategy_not_verified', activeStrategyVersion: null },
  })

  const status = await app.inject({ method: 'GET', url: '/api/status' })
  assert.equal(status.statusCode, 200)
  assert.equal(JSON.parse(status.body).connected, true)

  const tables = await app.inject({ method: 'GET', url: '/api/tables' })
  assert.equal(tables.statusCode, 200)
  const tablePayload = JSON.parse(tables.body)[0]
  assert.equal(tablePayload.tableId, 'BAG01')
  assert.equal(tablePayload.prediction.source, 'backend')
  assert.equal(String(tablePayload.prediction.targetTableId), String(tablePayload.tableId))
  assert.equal(String(tablePayload.prediction.targetShoe), String(tablePayload.shoe))
  assert.equal(Number(tablePayload.prediction.targetRound), Number(tablePayload.round))

  const snapshot = await app.inject({ method: 'GET', url: '/api/snapshot' })
  assert.equal(snapshot.statusCode, 200)
  assert.equal(JSON.parse(snapshot.body).tables.length, 1)
})
