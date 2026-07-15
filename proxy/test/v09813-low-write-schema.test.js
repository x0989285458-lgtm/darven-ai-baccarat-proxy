import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const sql = readFileSync(new URL('../../frontend/supabase/schema_v09813_low_write_storage.sql', import.meta.url), 'utf8')

test('v098.13 migration exposes a latest-snapshot update RPC without requiring a new unique constraint', () => {
  assert.match(sql, /create or replace function public\.persist_latest_cloud_table_snapshot\(p_snapshot jsonb\)/i)
  assert.match(sql, /perform pg_advisory_xact_lock/i)
  assert.match(sql, /update public\.cloud_table_snapshots/i)
  assert.match(sql, /where id = \(\s*select id[\s\S]*session_id is not distinct from snapshot_session/i)
  assert.match(sql, /if not found then[\s\S]*insert into public\.cloud_table_snapshots/i)
  assert.match(sql, /table_summary[\s\S]*'\[\]'::jsonb/i)
})

test('v098.13 migration provides an explicit transactional compaction that preserves one latest snapshot per session', () => {
  assert.match(sql, /create or replace function public\.compact_cloud_table_snapshots\(\)/i)
  assert.match(sql, /lock table public\.cloud_table_snapshots in access exclusive mode/i)
  assert.match(sql, /select distinct on \(session_id\)/i)
  assert.match(sql, /order by session_id, snapshot_at desc/i)
  assert.match(sql, /truncate table public\.cloud_table_snapshots/i)
  assert.match(sql, /insert into public\.cloud_table_snapshots/i)
  assert.doesNotMatch(sql, /select public\.compact_cloud_table_snapshots\(\)/i)
})
