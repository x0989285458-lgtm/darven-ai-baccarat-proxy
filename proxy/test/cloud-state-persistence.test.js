import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'

test('status reads are side-effect free because cloud ingest already persists changed state', async () => {
  const calls = []
  const supabaseClient = {
    configured: true,
    writeCloudCaptureStatus: async (payload) => calls.push(['status', payload]),
    writeCloudTableSnapshot: async (payload) => calls.push(['snapshot', payload]),
  }
  const app = createApp({ autoConnect: false, deployMode: 'cloud', captureSource: 'cloud_browser', supabaseClient })

  app.state.setStatus({ connected: true, authenticated: true, persistenceStatus: 'ok' })
  app.state.setTables([{ tableId: 'BAG01', displayName: 'MT百家樂第1桌' }])

  const first = await app.inject({ method: 'GET', url: '/api/status' })
  const second = await app.inject({ method: 'GET', url: '/api/status' })

  assert.equal(JSON.parse(first.body).persistenceStatus, 'ok')
  assert.equal(JSON.parse(second.body).persistenceStatus, 'ok')
  assert.deepEqual(calls, [])
})
