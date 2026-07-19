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
  assert.match(health.headers['cache-control'], /\bno-store\b/)

  const protectedStatus = await app.inject({ method: 'GET', url: '/api/online-license/status' })
  assert.equal(protectedStatus.statusCode, 401)
})

test('public license health accepts GET only and preserves CORS preflight', async () => {
  const licenseAdminClient = { configured: true, async checkConnection() { return true } }
  const app = createApp({ autoConnect: false, licenseAdminClient, frontendOrigin: 'https://frontend.example' })

  const post = await app.inject({ method: 'POST', url: '/api/online-license/health', headers: { origin: 'https://frontend.example' } })
  assert.equal(post.statusCode, 404)

  const options = await app.inject({ method: 'OPTIONS', url: '/api/online-license/health', headers: { origin: 'https://frontend.example', 'access-control-request-method': 'GET' } })
  assert.equal(options.statusCode, 204)
  assert.equal(options.headers['access-control-allow-origin'], 'https://frontend.example')
})

test('public license health reports an unconfigured database without probing', async () => {
  let probes = 0
  const licenseAdminClient = { configured: false, async checkConnection() { probes += 1; return true } }
  const app = createApp({ autoConnect: false, licenseAdminClient })

  const health = await app.inject({ method: 'GET', url: '/api/online-license/health' })
  assert.equal(health.statusCode, 503)
  assert.deepEqual(JSON.parse(health.body), { configured: false, connected: false })
  assert.equal(probes, 0)
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
