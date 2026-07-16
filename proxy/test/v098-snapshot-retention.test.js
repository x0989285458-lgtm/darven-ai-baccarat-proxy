import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildCloudTableSnapshotRow, createSupabaseIngestionClient } from '../src/supabase-writer.js'

test('v098 snapshot SQL applies 30-second same-session limit with only round shoe or connection transition exceptions and 24h retention', () => {
  const sql = readFileSync(new URL('../../frontend/supabase/schema_v098_snapshot_safety.sql', import.meta.url), 'utf8')
  const limiter = sql.match(/create or replace function public\.limit_cloud_table_snapshot_writes[\s\S]*?\$\$;/i)?.[0] ?? ''

  assert.match(limiter, /interval '30 seconds'/i)
  assert.match(limiter, /table_summary/i)
  assert.match(limiter, /connectionState/i)
  assert.match(limiter, /return null/i)
  assert.match(sql, /delete from public\.cloud_table_snapshots[\s\S]*snapshot_at < now\(\) - interval '24 hours'/i)
  assert.match(sql, /ctid[\s\S]*select[\s\S]*snapshot_at < now\(\) - interval '24 hours'[\s\S]*limit 500/i)
})

test('v098 snapshot row persists the connection state needed by the SQL exception contract', () => {
  const row = buildCloudTableSnapshotRow({
    sessionId: 'session-1', tables: [{ tableId: 'BAG01', shoe: 8, round: 20 }],
    status: { connected: true, authenticated: false },
  })

  assert.deepEqual(row.metadata.connectionState, { connected: true, authenticated: false })
})

test('v098 durable cloud snapshot stamps buildVersion 098 on every table and prediction', () => {
  const row = buildCloudTableSnapshotRow({
    sessionId: 'session-1',
    tables: [{ tableId: 'BAG01', shoe: 8, round: 20 }],
  })

  assert.equal(row.tables[0].buildVersion, '098.22')
  assert.equal(row.tables[0].prediction.buildVersion, '098.22')
})

test('v098.13 writer accepts the durable latest-snapshot RPC acknowledgement', async () => {
  const client = createSupabaseIngestionClient({
    url: 'https://example.invalid', serviceKey: 'fixture-key', retryAttempts: 1,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ persisted: true, inserted: false }) }),
  })

  const result = await client.writeCloudTableSnapshot({ sessionId: 'session-1', tables: [{ tableId: 'BAG01' }] })
  assert.equal(result.ok, true)
  assert.equal(result.result.persisted, true)
  assert.equal(result.result.inserted, false)
})
