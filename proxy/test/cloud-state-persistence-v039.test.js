import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'

test('v039 server persists cloud capture status and snapshots when tables change', async () => {
  const calls = []
  const supabaseClient = {
    configured: true,
    writeCloudCaptureStatus: async (payload) => calls.push(['status', payload]),
    writeCloudTableSnapshot: async (payload) => calls.push(['snapshot', payload]),
  }
  const app = createApp({ autoConnect: false, deployMode: 'cloud', captureSource: 'cloud_browser', supabaseClient })

  app.state.setStatus({ connected: true, authenticated: true })
  app.state.setTables([{ tableId: 'BAG01', displayName: 'MT百家樂第1桌' }])

  const status = await app.inject({ method: 'GET', url: '/api/status' })
  assert.equal(JSON.parse(status.body).persistenceStatus, 'ok')
  assert.deepEqual(calls.map(([kind]) => kind), ['status', 'snapshot'])
  assert.equal(calls[1][1].tables[0].tableId, 'BAG01')
})
