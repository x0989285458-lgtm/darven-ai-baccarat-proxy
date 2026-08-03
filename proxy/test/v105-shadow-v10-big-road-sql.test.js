import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const migrationUrl = new URL('../../supabase/migrations/20260803113000_v105_shadow_v10_big_road.sql', import.meta.url)
const VERSION = 'v105-shadow-v10-big-road-uncommon-structure'
const PREFIX = 'v105_shadow_v10_big_road'

test('new big-road-only V10 creates an isolated zero-counter database without mutating old V10 evidence', async () => {
  const sql = await readFile(migrationUrl, 'utf8')
  for (const table of ['runtime_settings','sequence_counters','issuances','settlements']) {
    assert.match(sql, new RegExp(`create table if not exists public\\.${PREFIX}_${table}`, 'i'))
    assert.match(sql, new RegExp(`alter table public\\.${PREFIX}_${table} enable row level security`, 'i'))
  }
  assert.match(sql, new RegExp(`values\\s*\\(\\s*'${VERSION}'\\s*,\\s*'${VERSION}'\\s*,\\s*'shadow'\\s*,\\s*true\\s*,\\s*'v105'`, 'i'))
  assert.match(sql, new RegExp(`insert into public\\.${PREFIX}_sequence_counters[\\s\\S]{0,180}values\\s*\\(\\s*'${VERSION}'\\s*,\\s*0\\s*\\)`, 'i'))
  for (const fn of ['issue_v105_shadow_v10_big_road_prediction','settle_v105_shadow_v10_big_road_prediction']) {
    assert.match(sql, new RegExp(`create or replace function public\\.${fn}\\(p_(?:prediction|settlement) jsonb\\)`, 'i'))
  }
  assert.match(sql, /create or replace function public\.get_v105_shadow_v10_big_road_compact_history\(p_per_table_limit integer\)/i)
  assert.match(sql, /create or replace view public\.v105_shadow_v10_big_road_history/i)
  assert.doesNotMatch(sql, /\b(drop|truncate|delete\s+from)\b/i)
  assert.doesNotMatch(sql, /\b(?:drop|truncate|delete\s+from|update)\b[^;]*public\.v105_shadow_v10_(?!big_road)/i)
})

test('new V10 RPCs and tables are service-role-only and functions use a fixed catalog search path', async () => {
  const sql = await readFile(migrationUrl, 'utf8')
  assert.match(sql, /set search_path\s*=\s*pg_catalog/i)
  assert.doesNotMatch(sql, /grant\s+(?:select|insert|update|delete|execute)[^;]*\bto\s+(?:anon|authenticated|public)\b/i)
  assert.match(sql, /grant execute on function public\.issue_v105_shadow_v10_big_road_prediction\(jsonb\) to service_role/i)
  assert.match(sql, /grant execute on function public\.settle_v105_shadow_v10_big_road_prediction\(jsonb\) to service_role/i)
  assert.match(sql, /grant execute on function public\.get_v105_shadow_v10_big_road_compact_history\(integer\) to service_role/i)
})
