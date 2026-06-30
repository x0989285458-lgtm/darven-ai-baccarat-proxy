import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCloudCaptureStatusRow,
  buildCloudTableSnapshotRow,
  buildCloudRoundEventRow,
  buildCloudStrategyReportRow,
  buildStrategyAdjustmentStatsRows,
  createSupabaseIngestionClient,
} from '../src/supabase-writer.js'

test('v039 builds cloud capture status row without leaking tokenized URL', () => {
  const row = buildCloudCaptureStatusRow({
    sessionId: 'session-1',
    captureSource: 'cloud_browser',
    status: { connected: true, authenticated: true, tableCount: 9, errorMessage: 'url token=abc123secret failed' },
    metadata: { worker: 'browserless' },
  })

  assert.equal(row.session_id, 'session-1')
  assert.equal(row.capture_source, 'cloud_browser')
  assert.equal(row.connected, true)
  assert.equal(row.authenticated, true)
  assert.equal(row.table_count, 9)
  assert.equal(row.error_message, 'url token=[redacted] failed')
  assert.deepEqual(row.metadata, { worker: 'browserless' })
})

test('v039 builds cloud table snapshot row with normalized table summary', () => {
  const row = buildCloudTableSnapshotRow({
    sessionId: 'session-1',
    tables: [{ tableId: 'BAG01', displayName: 'MT百家樂第1桌', shoe: 3, round: 12 }],
    status: { captureSource: 'cloud_browser' },
  })

  assert.equal(row.session_id, 'session-1')
  assert.equal(row.capture_source, 'cloud_browser')
  assert.equal(row.table_count, 1)
  assert.equal(row.tables[0].tableId, 'BAG01')
  assert.equal(row.table_summary[0].round, 12)
})

test('v039 builds cloud round, strategy report, and adjustment stats rows', () => {
  const round = buildCloudRoundEventRow({
    sessionId: 'session-1',
    round: { tableId: 'BAG01', shoe: 3, round: 12, winner: 'banker', receivedAt: '2026-06-30T00:00:00.000Z' },
    table: { displayName: 'MT百家樂第1桌' },
  })
  assert.equal(round.session_id, 'session-1')
  assert.equal(round.table_id, 'BAG01')
  assert.equal(round.main_result, 'banker')

  const report = buildCloudStrategyReportRow({
    report: { version: '039', total: { rounds: 300, hits: 168, misses: 132, pushes: 0, hitRate: 56 } },
    reportPath: 'reports/v039.png',
  })
  assert.equal(report.strategy_version, '039')
  assert.equal(report.rounds, 300)
  assert.equal(report.main_hit_rate, 56)

  const stats = buildStrategyAdjustmentStatsRows({
    reportId: 'report-1',
    stats: {
      normal: { hits: 10, misses: 8, evaluated: 18, hitRate: 55.56 },
      reverseCorrection: { hits: 4, misses: 2, evaluated: 6, hitRate: 66.67 },
    },
  })
  assert.equal(stats.length, 2)
  assert.deepEqual(stats.map((row) => row.strategy_mode), ['normal', 'reverse_correction'])
})

test('v039 client writes cloud capture data to Supabase REST tables', async () => {
  const requests = []
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co',
    serviceKey: 'sb_secret_test_key',
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init, body: JSON.parse(init.body) })
      return { ok: true, status: 201, text: async () => '' }
    },
  })

  await client.writeCloudCaptureStatus({ sessionId: 'session-1', status: { connected: true, tableCount: 9 } })
  await client.writeCloudTableSnapshot({ sessionId: 'session-1', tables: [{ tableId: 'BAG01' }] })
  await client.writeCloudRoundEvent({ sessionId: 'session-1', round: { tableId: 'BAG01', round: 1, winner: 'player' } })
  await client.writeCloudStrategyReport({ report: { version: '039', total: { rounds: 300, hits: 168, misses: 132, hitRate: 56 } } })
  await client.writeStrategyAdjustmentStats({ reportId: 'report-1', stats: { normal: { hits: 1, misses: 1, evaluated: 2, hitRate: 50 } } })

  assert.deepEqual(requests.map((request) => new URL(request.url).pathname), [
    '/rest/v1/cloud_capture_status',
    '/rest/v1/cloud_table_snapshots',
    '/rest/v1/cloud_table_rounds',
    '/rest/v1/cloud_strategy_reports',
    '/rest/v1/cloud_strategy_adjustment_stats',
  ])
  assert.equal(requests[0].init.headers.Authorization, 'Bearer sb_secret_test_key')
})

test('v047 client reads latest cloud capture status and table snapshot from Supabase REST', async () => {
  const requests = []
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co',
    serviceKey: 'sb_secret_test_key',
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init })
      if (String(url).includes('cloud_table_snapshots')) {
        return { ok: true, json: async () => [{ session_id: 'local-vpn', tables: [{ tableId: 'BAG01' }] }], text: async () => '' }
      }
      return { ok: true, json: async () => [{ session_id: 'local-vpn', connected: true, table_count: 1 }], text: async () => '' }
    },
  })

  const snapshot = await client.getLatestCloudTableSnapshot()
  const status = await client.getLatestCloudCaptureStatus()

  assert.equal(snapshot.tables[0].tableId, 'BAG01')
  assert.equal(status.connected, true)
  assert.deepEqual(requests.map((request) => new URL(request.url).searchParams.get('order')), ['snapshot_at.desc', 'updated_at.desc'])
})
