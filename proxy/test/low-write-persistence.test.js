import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCloudTableSnapshotRow, createSupabaseIngestionClient } from '../src/supabase-writer.js'

test('snapshot keeps fallback tables but no duplicate table_summary payload', () => {
  const row = buildCloudTableSnapshotRow({
    sessionId: 'worker-1',
    tables: [{ tableId: 'BAG01', shoe: 7, round: 12, beadPlateRaw: '0102', bigRoadRaw: '0102' }],
    status: { connected: true, authenticated: true },
  })
  assert.equal(row.tables.length, 1)
  assert.deepEqual(row.table_summary, [])
  assert.equal(row.tables[0].tableId, 'BAG01')
})

test('snapshot writer updates one latest row through the bounded RPC', async () => {
  const requests = []
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'sb_secret_test_key',
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) })
      return { ok: true, status: 200, text: async () => JSON.stringify({ persisted: true, inserted: false }) }
    },
  })
  await client.writeCloudTableSnapshot({ sessionId: 'worker-1', tables: [{ tableId: 'BAG01' }], status: { connected: true } })
  assert.equal(new URL(requests[0].url).pathname, '/rest/v1/rpc/persist_latest_cloud_table_snapshot')
  assert.equal(requests[0].body.p_snapshot.session_id, 'worker-1')
  assert.deepEqual(requests[0].body.p_snapshot.table_summary, [])
})

test('snapshot writer limits large fallback payloads to a sixty-second heartbeat', async () => {
  let nowMs = 0
  const requests = []
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'sb_secret_test_key', now: () => nowMs,
    snapshotHeartbeatMs: 60000,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) })
      return { ok: true, status: 200, text: async () => JSON.stringify({ persisted: true, inserted: false }) }
    },
  })
  const base = { sessionId: 'worker-1', tables: [{ tableId: 'BAG01', round: 1 }], status: { connected: true, authenticated: true } }
  assert.equal((await client.writeCloudTableSnapshot(base)).ok, true)
  nowMs = 10000
  assert.equal((await client.writeCloudTableSnapshot({ ...base, tables: [{ tableId: 'BAG01', round: 2 }] })).skipped, true)
  nowMs = 60000
  assert.equal((await client.writeCloudTableSnapshot({ ...base, tables: [{ tableId: 'BAG01', round: 3 }] })).ok, true)
  assert.equal(requests.length, 2)
})

test('capture status writes on state change or sixty-second heartbeat only', async () => {
  let nowMs = 0
  const requests = []
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'sb_secret_test_key', now: () => nowMs,
    captureStatusHeartbeatMs: 60000,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) })
      return { ok: true, status: 201, text: async () => '' }
    },
  })
  const payload = { sessionId: 'worker-1', status: { connected: true, authenticated: true, tableCount: 15, lastMessageAt: '2026-07-15T00:00:00Z' } }
  assert.equal((await client.writeCloudCaptureStatus(payload)).ok, true)
  nowMs = 10000
  assert.equal((await client.writeCloudCaptureStatus({ ...payload, status: { ...payload.status, lastMessageAt: '2026-07-15T00:00:10Z' } })).skipped, true)
  nowMs = 60000
  assert.equal((await client.writeCloudCaptureStatus({ ...payload, status: { ...payload.status, lastMessageAt: '2026-07-15T00:01:00Z' } })).ok, true)
  assert.equal(requests.length, 2)
})
