import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('v039 Supabase schema defines cloud capture and strategy tables with RLS', () => {
  const sql = readFileSync(new URL('../../frontend/supabase/schema_v039_cloud_capture.sql', import.meta.url), 'utf8')
  for (const table of ['cloud_capture_sessions', 'cloud_capture_status', 'cloud_table_snapshots', 'cloud_table_rounds', 'cloud_strategy_reports', 'cloud_strategy_adjustment_stats']) {
    assert.match(sql, new RegExp(`create table if not exists public\\.${table}`))
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`))
  }
  assert.match(sql, /service role can manage cloud_capture_status/i)
  assert.match(sql, /anon can read cloud_table_snapshots/i)
})
