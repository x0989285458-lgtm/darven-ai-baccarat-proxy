import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'

test('v047 cloud proxy reads latest Supabase cloud snapshot when in-memory tables are empty', async () => {
  const supabaseClient = {
    configured: true,
    getLatestCloudTableSnapshot: async () => ({
      session_id: 'local-vpn-capture',
      capture_source: 'local_chrome',
      table_count: 1,
      tables: [{ tableId: 'BAG01', displayName: 'MT百家樂第1桌', round: 8 }],
      snapshot_at: '2026-06-30T00:00:00.000Z',
    }),
    getLatestCloudCaptureStatus: async () => ({
      session_id: 'local-vpn-capture',
      capture_source: 'local_chrome',
      connected: true,
      authenticated: true,
      table_count: 1,
      last_message_at: '2026-06-30T00:00:00.000Z',
      status_text: '本機VPN抓牌已同步',
      updated_at: '2026-06-30T00:00:00.000Z',
    }),
    writeCloudCaptureStatus: async () => {},
    writeCloudTableSnapshot: async () => {},
  }
  const app = createApp({ autoConnect: false, deployMode: 'cloud', captureSource: 'cloud_browser', supabaseClient })

  const tables = await app.inject({ method: 'GET', url: '/api/tables' })
  assert.deepEqual(JSON.parse(tables.body), [{ tableId: 'BAG01', displayName: 'MT百家樂第1桌', round: 8 }])

  const status = await app.inject({ method: 'GET', url: '/api/status' })
  const body = JSON.parse(status.body)
  assert.equal(body.connected, true)
  assert.equal(body.authenticated, true)
  assert.equal(body.tableCount, 1)
  assert.equal(body.captureSource, 'local_chrome')
  assert.equal(body.statusText, '本機VPN抓牌已同步1桌')
})

test('v048 cloud-data status prefers fresh 15-table local snapshot over stale one-table test status', async () => {
  const supabaseClient = {
    configured: true,
    countTodayPredictionRounds: async () => 93,
    getLatestCloudTableSnapshot: async () => ({
      session_id: 'local-local_chrome',
      capture_source: 'local_chrome',
      table_count: 15,
      tables: Array.from({ length: 15 }, (_, index) => ({ tableId: `BAG${String(index + 1).padStart(2, '0')}` })),
      snapshot_at: '2026-07-01T07:13:30.102Z',
    }),
    getLatestCloudCaptureStatus: async () => ({
      session_id: 'local-offline',
      capture_source: 'offline',
      connected: false,
      authenticated: false,
      table_count: 1,
      status_text: '離線模式',
      updated_at: '2026-07-01T07:11:04.911Z',
    }),
    writeCloudCaptureStatus: async () => {},
    writeCloudTableSnapshot: async () => {},
  }
  const app = createApp({ autoConnect: false, deployMode: 'cloud', captureSource: 'cloud_browser', supabaseClient, licenseAdminClient: { getCloudDataStatus: async () => ({ message: 'MT自動登入未啟用' }) } })

  const response = await app.inject({ method: 'GET', url: '/api/cloud-data/status' })
  const body = JSON.parse(response.body)
  assert.equal(body.tableCount, 15)
  assert.equal(body.captureSource, 'local_chrome')
  assert.equal(body.todayRoundCount, 93)
})
