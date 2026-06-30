import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'

test('v041 cloud capture management endpoints expose status, tick, start, and stop', async () => {
  let fetchCount = 0
  const app = createApp({
    port: 0,
    autoConnect: false,
    deployMode: 'cloud',
    captureSource: 'cloud_browser',
    cloudBrowserUrl: 'https://cloud-worker.example/snapshot',
    fetchImpl: async () => {
      fetchCount += 1
      return {
        ok: true,
        status: 200,
        json: async () => ({ connected: true, authenticated: true, sessionId: 'v041-session', tables: [{ tableId: 'BAG01' }] }),
      }
    },
  })

  const initial = await app.inject({ method: 'GET', url: '/api/cloud-capture/status' })
  assert.equal(initial.statusCode, 200)
  assert.equal(JSON.parse(initial.body).workerConfigured, true)

  const tick = await app.inject({ method: 'POST', url: '/api/cloud-capture/tick' })
  assert.equal(tick.statusCode, 200)
  assert.equal(JSON.parse(tick.body).ok, true)
  assert.equal(fetchCount, 1)

  const start = await app.inject({ method: 'POST', url: '/api/cloud-capture/start' })
  assert.equal(start.statusCode, 200)
  assert.equal(JSON.parse(start.body).running, true)

  const stop = await app.inject({ method: 'POST', url: '/api/cloud-capture/stop' })
  assert.equal(stop.statusCode, 200)
  assert.equal(JSON.parse(stop.body).running, false)
})

test('v041 cloud capture management refuses start when worker URL is missing', async () => {
  const app = createApp({ autoConnect: false, deployMode: 'cloud', captureSource: 'cloud_browser', cloudBrowserUrl: '' })
  const start = await app.inject({ method: 'POST', url: '/api/cloud-capture/start' })
  assert.equal(start.statusCode, 400)
  assert.match(JSON.parse(start.body).error, /CLOUD_BROWSER_URL/)
})
