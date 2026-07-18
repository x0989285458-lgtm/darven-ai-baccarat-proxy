import test from 'node:test'
import assert from 'node:assert/strict'
import { createCloudCaptureClient } from '../src/cloud-capture.js'
import { createApp } from '../src/server.js'

test('cloud capture default poll interval is reduced to avoid Supabase/API pressure', () => {
  const timers = []
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  globalThis.setInterval = (handler, ms) => {
    const timer = { handler, ms, unref() {} }
    timers.push(timer)
    return timer
  }
  globalThis.clearInterval = () => {}
  try {
    const client = createCloudCaptureClient({
      url: 'https://worker.example/snapshot',
      state: { setStatus() {}, setTables() {}, upsertRoundEvent() {}, recordError() {} },
      fetchImpl: async () => ({ ok: true, json: async () => ({ tables: [] }) }),
    })
    client.start()
    client.stop()
    assert.equal(timers[0].ms, 5000)
  } finally {
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
  }
})

test('cloud capture control endpoints require configured control token', async () => {
  const app = createApp({
    port: 0,
    autoConnect: false,
    deployMode: 'cloud',
    captureSource: 'cloud_browser',
    cloudBrowserUrl: 'https://cloud-worker.example/snapshot',
    controlToken: 'control-secret',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ tables: [] }) }),
  })

  const denied = await app.inject({ method: 'POST', url: '/api/cloud-capture/start' })
  assert.equal(denied.statusCode, 401)
  assert.match(JSON.parse(denied.body).error, /control token/i)

  const queryDenied = await app.inject({ method: 'POST', url: '/api/cloud-capture/start?controlToken=control-secret' })
  assert.equal(queryDenied.statusCode, 401)

  const bodyDenied = await app.inject({ method: 'POST', url: '/api/cloud-capture/start', body: { controlToken: 'control-secret' } })
  assert.equal(bodyDenied.statusCode, 401)

  const allowed = await app.inject({ method: 'POST', url: '/api/cloud-capture/start', headers: { 'x-control-token': 'control-secret' } })
  assert.equal(allowed.statusCode, 200)
  assert.equal(JSON.parse(allowed.body).ok, true)
})

test('control endpoints reject non-allowed Origin when configured', async () => {
  const app = createApp({
    port: 0,
    autoConnect: false,
    deployMode: 'cloud',
    captureSource: 'cloud_browser',
    cloudBrowserUrl: 'https://cloud-worker.example/snapshot',
    controlToken: 'control-secret',
    controlAllowedOrigin: 'https://darven-ai-baccarat.pages.dev',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ tables: [] }) }),
  })

  const response = await app.inject({
    method: 'POST',
    url: '/api/cloud-capture/stop',
    headers: { 'x-control-token': 'control-secret', origin: 'https://evil.example' },
  })
  assert.equal(response.statusCode, 403)
})

test('production control endpoints fail closed when no control key is configured', async () => {
  const app = createApp({ autoConnect: false, production: true, deployMode: 'cloud', controlToken: '', cloudBrowserUrl: 'https://worker.example/snapshot' })
  const response = await app.inject({ method: 'POST', url: '/api/cloud-capture/start', headers: { 'x-forwarded-proto': 'https' } })
  assert.equal(response.statusCode, 503)
})
