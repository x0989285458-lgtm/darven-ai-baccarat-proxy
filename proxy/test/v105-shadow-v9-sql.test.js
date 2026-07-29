import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const migrationUrl = new URL('../../supabase/migrations/20260729050000_v105_shadow_v9.sql', import.meta.url)
const VERSION = 'v105-shadow-v9-weighted-v7-v8'

test('V9 SQL is additive, idempotent, service-role-only, and starts an independent counter at zero', () => {
  const sql = readFileSync(migrationUrl, 'utf8')
  for (const table of ['runtime_settings', 'sequence_counters', 'issuances', 'settlements']) {
    assert.match(sql, new RegExp(`create table if not exists public\\.v105_shadow_v9_${table}`, 'i'))
    assert.match(sql, new RegExp(`alter table public\\.v105_shadow_v9_${table} enable row level security`, 'i'))
  }
  assert.match(sql, new RegExp(`values\\s*\\(\\s*'${VERSION}'\\s*,\\s*'${VERSION}'\\s*,\\s*'shadow'\\s*,\\s*true\\s*,\\s*'v105'`, 'i'))
  assert.match(sql, new RegExp(`insert into public\\.v105_shadow_v9_sequence_counters[\\s\\S]{0,180}values\\s*\\(\\s*'${VERSION}'\\s*,\\s*0\\s*\\)[\\s\\S]{0,120}on conflict`, 'i'))
  for (const fn of ['issue_v105_shadow_v9_prediction', 'settle_v105_shadow_v9_prediction']) {
    assert.match(sql, new RegExp(`create or replace function public\\.${fn}\\(p_(?:prediction|settlement) jsonb\\)`, 'i'))
    assert.match(sql, new RegExp(`revoke all on function public\\.${fn}\\(jsonb\\) from public,anon,authenticated,service_role`, 'i'))
    assert.match(sql, new RegExp(`grant execute on function public\\.${fn}\\(jsonb\\) to service_role`, 'i'))
  }
  assert.match(sql, /create or replace view public\.v105_shadow_v9_history/i)
  assert.doesNotMatch(sql, /\b(drop|truncate|delete\s+from)\b/i)
  assert.doesNotMatch(sql, /\b(alter|insert\s+into|update)\s+(table\s+)?public\.(v105_shadow_v[678]|v104_iteration_shadow_v5)_/i)
})

test('V9 SQL rejects all pre-V9 strategy identities', () => {
  const sql = readFileSync(migrationUrl, 'utf8')
  assert.match(sql, new RegExp(`p_prediction->>'strategy_version'\\s+is distinct from\\s+'${VERSION}'`, 'i'))
  assert.match(sql, new RegExp(`p_settlement->>'strategy_version'\\s+is distinct from\\s+'${VERSION}'`, 'i'))
  assert.match(sql, new RegExp(`issued\\.strategy_version\\s*<>\\s*'${VERSION}'`, 'i'))
})
