import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const migrationUrl = new URL('../../supabase/migrations/20260802010000_v105_shadow_v10.sql', import.meta.url)
const stopUrl = new URL('../../supabase/operations/stop_v105_shadow_v10_issuance.sql', import.meta.url)
const finalizeUrl = new URL('../../supabase/operations/finalize_v105_shadow_v10_stop.sql', import.meta.url)
const VERSION = 'v105-shadow-v10-uncommon-road-structure'

test('V10 SQL is additive, idempotent, RLS-protected, service-role-only, and starts independent counters at zero', () => {
  const sql = readFileSync(migrationUrl, 'utf8')
  for (const table of ['runtime_settings', 'sequence_counters', 'issuances', 'settlements']) {
    assert.match(sql, new RegExp(`create table if not exists public\\.v105_shadow_v10_${table}`, 'i'))
    assert.match(sql, new RegExp(`alter table public\\.v105_shadow_v10_${table} enable row level security`, 'i'))
  }
  assert.match(sql, new RegExp(`values\\s*\\(\\s*'${VERSION}'\\s*,\\s*'${VERSION}'\\s*,\\s*'shadow'\\s*,\\s*true\\s*,\\s*'v105'`, 'i'))
  assert.match(sql, new RegExp(`insert into public\\.v105_shadow_v10_sequence_counters[\\s\\S]{0,180}values\\s*\\(\\s*'${VERSION}'\\s*,\\s*0\\s*\\)[\\s\\S]{0,120}on conflict`, 'i'))
  for (const fn of ['issue_v105_shadow_v10_prediction', 'settle_v105_shadow_v10_prediction']) {
    assert.match(sql, new RegExp(`create or replace function public\\.${fn}\\(p_(?:prediction|settlement) jsonb\\)`, 'i'))
    assert.match(sql, new RegExp(`revoke all on function public\\.${fn}\\(jsonb\\) from public,anon,authenticated,service_role`, 'i'))
    assert.match(sql, new RegExp(`grant execute on function public\\.${fn}\\(jsonb\\) to service_role`, 'i'))
  }
  assert.match(sql, /create or replace function public\.get_v105_shadow_v10_compact_history\(p_per_table_limit integer\)/i)
  assert.match(sql, /create or replace view public\.v105_shadow_v10_history/i)
  assert.doesNotMatch(sql, /\b(drop|truncate|delete\s+from)\b/i)
  assert.doesNotMatch(sql, /\b(alter|insert\s+into|update)\s+(table\s+)?public\.(v105_shadow_v(?:6|7|8|9)|v104_iteration_shadow_v5|ai_predictions|prediction_issuances)_/i)
})

test('V10 SQL enforces the V10 identity, conservative weights, structure diagnostics, and unchanged safety flags', () => {
  const sql = readFileSync(migrationUrl, 'utf8')
  assert.match(sql, new RegExp(`p_prediction->>'strategy_version'\\s+is distinct from\\s+'${VERSION}'`, 'i'))
  assert.match(sql, new RegExp(`p_settlement->>'strategy_version'\\s+is distinct from\\s+'${VERSION}'`, 'i'))
  assert.match(sql, /"v7RoadCycle":0\.315/i)
  assert.match(sql, /"v8AskRoad":0\.315/i)
  assert.match(sql, /"recentPracticalCalibration":0\.18/i)
  assert.match(sql, /"shoeBankerPlayerBias":0\.09/i)
  assert.match(sql, /"uncommonRoadStructure":0\.10/i)
  assert.match(sql, /prediction_payload'->'structureDiagnostics/i)
  assert.match(sql, /score_banker\s*:=/i)
  assert.match(sql, /score_player\s*:=/i)
  assert.match(sql, /expected_direction\s*:=/i)
  assert.match(sql, /expected_confidence\s*:=/i)
  assert.match(sql, /v9BaseDirection/i)
  assert.match(sql, /heads'->'main'->>'predictedResult'[\s\S]{0,120}expected_direction/i)
  assert.match(sql, /scoreTotals'->>'banker'[\s\S]{0,180}score_banker/i)
  assert.match(sql, /scoreTotals'->>'player'[\s\S]{0,180}score_player/i)
  for (const [flag, value] of [['shadowOnly', 'true'], ['activationEligible', 'false'], ['memberVisible', 'false'], ['writesSideActions', 'false']]) {
    assert.match(sql, new RegExp(`prediction_payload'->'${flag}' is distinct from '${value}'::jsonb`, 'i'))
  }
})

test('V10 stop and finalize operations are drain-safe and never alter older identities or formal tables', () => {
  const stop = readFileSync(stopUrl, 'utf8')
  const finalize = readFileSync(finalizeUrl, 'utf8')
  assert.match(stop, /revoke execute on function public\.issue_v105_shadow_v10_prediction\(jsonb\) from service_role/i)
  assert.match(stop, /settle_v105_shadow_v10_prediction\(jsonb\).*EXECUTE/is)
  assert.match(finalize, /pending_count\s*<>\s*0/i)
  assert.match(finalize, /revoke execute on function public\.settle_v105_shadow_v10_prediction\(jsonb\) from service_role/i)
  for (const sql of [stop, finalize]) {
    assert.doesNotMatch(sql, /\b(drop|truncate|delete\s+from)\b/i)
    assert.doesNotMatch(sql, /public\.v105_shadow_v(?:6|7|8|9)_/i)
    assert.doesNotMatch(sql, /\b(update|insert\s+into)\s+public\.(ai_|v105_shadow_v(?:6|7|8|9)|v104_)/i)
  }
})
