import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'

test('server starts cloud capture worker when cloud_browser source has URL', async () => {
  const app = createApp({
    port: 0,
    autoConnect: true,
    deployMode: 'cloud',
    captureSource: 'cloud_browser',
    cloudBrowserUrl: 'https://cloud-worker.example/snapshot',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ buildVersion: '105', connected: true, authenticated: true, sessionId: 'server-cloud-1', tables: [{ tableId: 'BAG09' }] }),
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

test('server honors AUTO_CONNECT=true env for cloud capture on Render', async () => {
  const previous = process.env.AUTO_CONNECT
  process.env.AUTO_CONNECT = 'true'
  const app = createApp({
    port: 0,
    deployMode: 'cloud',
    captureSource: 'cloud_browser',
    cloudBrowserUrl: 'https://cloud-worker.example/snapshot',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ buildVersion: '105', connected: true, authenticated: true, sessionId: 'server-cloud-env', tables: [{ tableId: 'BAG10' }] }),
    }),
  })

  try {
    await app.start()
    assert.equal(app.cloudCaptureClient.isRunning(), true)
    await app.cloudCaptureClient.tick()
    const status = await app.inject({ method: 'GET', url: '/api/status' })
    const body = JSON.parse(status.body)
    assert.equal(body.captureSessionId, 'server-cloud-env')
    assert.equal(body.tableCount, 1)
  } finally {
    await app.stop()
    if (previous === undefined) delete process.env.AUTO_CONNECT
    else process.env.AUTO_CONNECT = previous
  }
})
