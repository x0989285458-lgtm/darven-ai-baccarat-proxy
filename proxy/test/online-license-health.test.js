import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'
import { createLicenseAdminClient } from '../src/license-admin.js'

test('license client connection check performs a minimal database probe', async () => {
  const queries = []
  const client = createLicenseAdminClient({ pool: { async query(sql) { queries.push(sql); return { rows: [{ ok: 1 }] } } } })
  assert.equal(await client.checkConnection(), true)
  assert.deepEqual(queries, ['select 1 as ok'])
})

test('public license health probes connectivity without exposing protected status data', async () => {
  let statusCalls = 0
  const licenseAdminClient = {
    configured: true,
    async checkConnection() { return true },
    async getStatus() { statusCalls += 1; return { configured: true, managers: [{ username: 'secret' }], licenses: [{ code: 'secret' }] } },
  }
  const app = createApp({ autoConnect: false, licenseAdminClient })

  const health = await app.inject({ method: 'GET', url: '/api/online-license/health' })
  assert.equal(health.statusCode, 200)
  assert.deepEqual(JSON.parse(health.body), { configured: true, connected: true })
  assert.equal(statusCalls, 0)

  const protectedStatus = await app.inject({ method: 'GET', url: '/api/online-license/status' })
  assert.equal(protectedStatus.statusCode, 401)
})

test('public license health fails closed when the database probe fails', async () => {
  const licenseAdminClient = {
    configured: true,
    async checkConnection() { throw new Error('database unavailable') },
  }
  const app = createApp({ autoConnect: false, licenseAdminClient })

  const health = await app.inject({ method: 'GET', url: '/api/online-license/health' })
  assert.equal(health.statusCode, 503)
  assert.deepEqual(JSON.parse(health.body), { configured: true, connected: false })
})
