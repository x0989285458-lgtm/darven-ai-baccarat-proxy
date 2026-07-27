import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const migrationUrl = new URL('../../supabase/migrations/20260727200000_v105_shadow_v6.sql', import.meta.url)

test('v105-shadow-v6-road-pattern migration is additive, repeatable, enabled, and starts an independent counter at zero', () => {
  assert.equal(fs.existsSync(migrationUrl), true, 'v105 shadow V6 migration must exist')
  const sql = fs.readFileSync(migrationUrl, 'utf8')
  for (const table of ['runtime_settings', 'sequence_counters', 'issuances', 'settlements']) {
    assert.match(sql, new RegExp(`create table if not exists public\\.v105_shadow_v6_${table}`, 'i'))
  }
  assert.match(sql, /values\s*\(\s*'v105-shadow-v6-road-pattern'\s*,\s*'v105-shadow-v6-road-pattern'\s*,\s*'shadow'\s*,\s*true\s*,\s*'v105'/i)
  assert.match(sql, /insert into public\.v105_shadow_v6_sequence_counters[\s\S]{0,160}values\s*\(\s*'v105-shadow-v6-road-pattern'\s*,\s*0\s*\)[\s\S]{0,100}on conflict/i)
  for (const counter of ['main_action_count','tie_action_count','super_six_action_count','banker_dragon_action_count','player_dragon_action_count','banker_pair_action_count','player_pair_action_count']) {
    assert.match(sql, new RegExp(`${counter} bigint not null default 0`, 'i'))
  }
  assert.match(sql, /'action_sequences'\s*,\s*jsonb_build_object/i)
  assert.match(sql, /create or replace function public\.issue_v105_shadow_v6_prediction\(p_prediction jsonb\)/i)
  assert.match(sql, /create or replace function public\.settle_v105_shadow_v6_prediction\(p_settlement jsonb\)/i)
  assert.match(sql, /create or replace view public\.v105_shadow_v6_history/i)
  assert.doesNotMatch(sql, /v105_shadow_v1|v105_shadow_v3|v105_shadow_v4|v105_shadow_v5/i)
  assert.doesNotMatch(sql, /insert into public\.v104_|update public\.v104_|from public\.v104_/i)
  assert.doesNotMatch(sql, /\b(drop|truncate|delete)\b/i)
})

test('v105 shadow V6 SQL rejects old identities, is service_role only, and hard-codes the formal ten-table allowlist', () => {
  assert.equal(fs.existsSync(migrationUrl), true, 'v105 shadow V6 migration must exist')
  const sql = fs.readFileSync(migrationUrl, 'utf8')
  assert.match(sql, /strategy_version\s*=\s*'v105-shadow-v6-road-pattern'/i)
  assert.match(sql, /active_strategy_version\s*=\s*'v105'/i)
  assert.match(sql, /table_id\s+text\s+not null\s+check\s*\(table_id\s+in\s*\('BAG01','BAG02','BAG03','BAG03A','BAG05','BAG06','BAG07','BAG08','BAG09','BAG10'\)\)/i)
  assert.match(sql, /p_prediction->>'strategy_version'\s+is distinct from\s+'v105-shadow-v6-road-pattern'/i)
  assert.match(sql, /p_settlement->>'strategy_version'\s+is distinct from\s+'v105-shadow-v6-road-pattern'/i)
  assert.match(sql, /settlement_final\s+boolean\s+not null\s+check\s*\(settlement_final\s*=\s*true\)/i)
  for (const fn of ['issue_v105_shadow_v6_prediction', 'settle_v105_shadow_v6_prediction']) {
    assert.match(sql, new RegExp(`revoke all on function public\\.${fn}\\(jsonb\\) from public,anon,authenticated,service_role`, 'i'))
    assert.match(sql, new RegExp(`grant execute on function public\\.${fn}\\(jsonb\\) to service_role`, 'i'))
  }
})

test('v105 shadow V6 SQL binds immutable road evidence and all duplicated main semantics', () => {
  const sql = fs.readFileSync(migrationUrl, 'utf8')
  assert.match(sql, /jsonb_typeof\(p_prediction->'prediction_payload'->'roadPatternSignal'\) is distinct from 'object'/i)
  assert.match(sql, /jsonb_typeof\(p_prediction->'prediction_payload'->'decodedRecentRuns'\) is distinct from 'array'/i)
  assert.match(sql, /jsonb_typeof\(p_prediction->'prediction_payload'->'roadPatternWindows'\) is distinct from 'object'/i)
  for (const window of ['near6', 'near12', 'background24']) {
    assert.match(sql, new RegExp(`jsonb_typeof\\(p_prediction->'prediction_payload'->'roadPatternWindows'->'${window}'\\) is distinct from 'array'`, 'i'))
  }
  assert.match(sql, /p_prediction->'prediction_payload'->>'predictedResult' is distinct from p_prediction->>'predicted_result'/i)
  assert.match(sql, /\(p_prediction->'prediction_payload'->>'confidence'\)::numeric is distinct from \(p_prediction->>'confidence'\)::numeric/i)
  assert.match(sql, /\(p_prediction->'prediction_payload'->>'sameSideStreak'\)::integer is distinct from \(p_prediction->>'same_side_streak'\)::integer/i)
})

test('v105 shadow V6 settlement replay conflicts on a changed verified Final source action', () => {
  const sql = fs.readFileSync(migrationUrl, 'utf8')
  assert.match(sql, /existing\.settlement_source_action is distinct from p_settlement->>'settlement_source_action'/i)
})
