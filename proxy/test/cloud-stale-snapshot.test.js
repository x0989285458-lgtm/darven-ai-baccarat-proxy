import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'

const staleTime = new Date(Date.now() - 10 * 60 * 1000).toISOString()

test('api/tables does not serve stale Supabase cloud snapshots when live worker state is empty', async () => {
  const app = createApp({
    autoConnect: false,
    deployMode: 'cloud',
    captureSource: 'cloud_browser',
    supabaseClient: {
      configured: true,
      getLatestCloudTableSnapshot: async () => ({
        snapshot_at: staleTime,
        table_count: 17,
        tables: [{ tableId: 'BAG01', shoe: 14182, round: 35 }],
      }),
    },
  })

  const response = await app.inject({ method: 'GET', url: '/api/tables' })
  assert.deepEqual(JSON.parse(response.body), [])
})

test('api/status ignores stale cloud snapshot status instead of reporting connected 17 tables', async () => {
  const app = createApp({
    autoConnect: false,
    deployMode: 'cloud',
    captureSource: 'cloud_browser',
    supabaseClient: {
      configured: true,
      getLatestCloudCaptureStatus: async () => ({
        capture_source: 'cloud_browser',
        connected: true,
        authenticated: true,
        table_count: 17,
        last_message_at: staleTime,
      }),
      getLatestCloudTableSnapshot: async () => ({
        snapshot_at: staleTime,
        table_count: 17,
        tables: [{ tableId: 'BAG01', shoe: 14182, round: 35 }],
      }),
    },
  })

  const response = await app.inject({ method: 'GET', url: '/api/status' })
  const body = JSON.parse(response.body)
  assert.notEqual(body.connected, true)
  assert.notEqual(body.authenticated, true)
  assert.notEqual(body.tableCount, 17)
})
