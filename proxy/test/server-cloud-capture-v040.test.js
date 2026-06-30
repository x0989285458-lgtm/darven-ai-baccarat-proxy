import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'

test('v040 server starts cloud capture worker when cloud_browser source has URL', async () => {
  const app = createApp({
    port: 0,
    autoConnect: true,
    deployMode: 'cloud',
    captureSource: 'cloud_browser',
    cloudBrowserUrl: 'https://cloud-worker.example/snapshot',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ connected: true, authenticated: true, sessionId: 'server-cloud-1', tables: [{ tableId: 'BAG09' }] }),
    }),
  })

  await app.start()
  await app.cloudCaptureClient.tick()
  const status = await app.inject({ method: 'GET', url: '/api/status' })
  await app.stop()

  const body = JSON.parse(status.body)
  assert.equal(body.captureSource, 'cloud_browser')
  assert.equal(body.captureSessionId, 'server-cloud-1')
  assert.equal(body.tableCount, 1)
})
