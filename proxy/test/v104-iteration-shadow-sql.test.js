import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const schema = fs.readFileSync(new URL('../../frontend/supabase/schema_v104_iteration_shadow.sql', import.meta.url), 'utf8')
const disable = fs.readFileSync(new URL('../../frontend/supabase/disable_v104_iteration_shadow.sql', import.meta.url), 'utf8')
const rollback = fs.readFileSync(new URL('../../frontend/supabase/rollback_v104_iteration_shadow.sql', import.meta.url), 'utf8')
const schemaV2Url = new URL('../../frontend/supabase/schema_v104_iteration_shadow_v2.sql', import.meta.url)
const rollbackV2Url = new URL('../../frontend/supabase/rollback_v104_iteration_shadow_v2.sql', import.meta.url)
const schemaV2 = fs.existsSync(schemaV2Url) ? fs.readFileSync(schemaV2Url, 'utf8') : ''
const rollbackV2 = fs.existsSync(rollbackV2Url) ? fs.readFileSync(rollbackV2Url, 'utf8') : ''
const schemaV3Url = new URL('../../frontend/supabase/schema_v104_iteration_shadow_v3.sql', import.meta.url)
const rollbackV3Url = new URL('../../frontend/supabase/rollback_v104_iteration_shadow_v3.sql', import.meta.url)
const schemaV3 = fs.existsSync(schemaV3Url) ? fs.readFileSync(schemaV3Url, 'utf8') : ''
const rollbackV3 = fs.existsSync(rollbackV3Url) ? fs.readFileSync(rollbackV3Url, 'utf8') : ''

test('iteration shadow migration is additive, v104-active-only, and disables old shadows', () => {
  assert.match(schema, /version\s*=\s*'v104'/i)
  assert.match(schema, /v103_shadow_runtime_settings[\s\S]*enabled\s*=\s*false/i)
  assert.match(schema, /v104_shadow_runtime_settings[\s\S]*enabled\s*=\s*false/i)
  assert.doesNotMatch(schema, /update\s+public\.ai_strategy_versions\s+set\s+status/i)
  assert.doesNotMatch(schema, /insert\s+into\s+public\.ai_strategy_versions/i)
  assert.doesNotMatch(schema, /drop\s+table/i)
})

test('schema isolates immutable seven-head issuance and verified Final settlement', () => {
  assert.match(schema, /unique\s*\(source,\s*table_id,\s*shoe_no,\s*round_no,\s*strategy_version\)/i)
  assert.match(schema, /count\(\*\)[\s\S]*jsonb_object_keys\([^)]*heads[^)]*\)[\s\S]*<>\s*7/i)
  for (const head of ['main','tie','superSix','bankerDragon','playerDragon','bankerPair','playerPair']) assert.match(schema, new RegExp(`'${head}'`))
  assert.match(schema, /show_poker is provisional/i)
  assert.match(schema, /new\.settlement_sequence\s*>\s*2000[\s\S]*raise exception 'v104 iteration shadow 2000-settlement hard stop'/i)
  assert.match(schema, /before insert on public\.v104_iteration_shadow_settlements/i)
  assert.match(schema, /conflicting v104 iteration shadow issuance/i)
  assert.match(schema, /conflicting v104 iteration shadow settlement/i)
  assert.match(schema, /bankerCardRanks[\s\S]*playerCardRanks[\s\S]*actual facts do not match exact cards/i)
  assert.match(schema, /value::numeric<0\.05/i)
})

test('all shadow tables are RLS service-read-only and writes are RPC-only', () => {
  for (const table of ['runtime_settings','issuances','settlements']) {
    assert.match(schema, new RegExp(`alter table public\\.v104_iteration_shadow_${table} enable row level security`, 'i'))
    assert.match(schema, new RegExp(`revoke all on table public\\.v104_iteration_shadow_${table} from public, anon, authenticated, service_role`, 'i'))
    assert.match(schema, new RegExp(`grant select on table public\\.v104_iteration_shadow_${table} to service_role`, 'i'))
  }
  assert.match(schema, /grant execute on function public\.issue_v104_iteration_shadow_prediction\(jsonb\) to service_role/i)
  assert.match(schema, /revoke all on function public\.issue_v104_iteration_shadow_prediction\(jsonb\) from public,anon,authenticated/i)
})

test('disable and rollback preserve all shadow evidence', () => {
  assert.match(disable, /enabled=false/i)
  assert.match(rollback, /enabled=false/i)
  assert.doesNotMatch(disable + rollback, /delete\s+from|truncate|drop\s+table/i)
  for (const rpc of [
    'issue_v104_iteration_shadow_prediction\\(jsonb\\)',
    'settle_v104_iteration_shadow_prediction\\(jsonb\\)',
    'persist_v104_iteration_shadow_artifacts\\(jsonb,jsonb\\)',
    'review_v104_iteration_shadow_suggestion\\(text,text,text\\)',
  ]) assert.match(rollback, new RegExp(`revoke execute on function public\\.${rpc} from service_role`, 'i'))
})

test('v2 migration is isolated, changes only player-pair threshold, and has no automatic settlement cap', () => {
  assert.match(schemaV2, /v104-seven-head-shadow-v2-player-pair-threshold-41/i)
  assert.match(schemaV2, /v104\.2\.0-seven-head-shadow\.2/i)
  for (const table of ['runtime_settings','sequence_counters','issuances','settlements','cycle_reports','weight_suggestions']) {
    assert.match(schemaV2, new RegExp(`public\\.v104_iteration_shadow_v2_${table}`, 'i'))
  }
  assert.match(schemaV2, /playerPair[\s\S]{0,300}threshold["']?\s*[^\n]*41/i)
  for (const [top, payload] of [
    ['predicted_result', 'predictedResult'], ['confidence', 'confidence'],
    ['same_side_streak', 'sameSideStreak'], ['independent_support_count', 'independentSupportCount'],
    ['shoe_bias_suppressed', 'shoeBiasSuppressed'], ['lock_risk', 'lockRisk'],
  ]) assert.match(schemaV2, new RegExp(`p_prediction->>'${top}'[\\s\\S]{0,180}prediction_payload'->>'${payload}'`, 'i'))
  for (const rpc of [
    'issue_v104_iteration_shadow_v2_prediction', 'settle_v104_iteration_shadow_v2_prediction',
    'persist_v104_iteration_shadow_v2_artifacts', 'review_v104_iteration_shadow_v2_suggestion',
  ]) assert.match(schemaV2, new RegExp(`function public\\.${rpc}[\\s\\S]{0,1200}for share[\\s\\S]{0,120}if not found`, 'i'))
  assert.match(schemaV2, /insert into public\.v104_iteration_shadow_v2_runtime_settings[\s\S]{0,500}on conflict \(release_candidate\) do nothing/i)
  assert.match(schemaV2, /manual stop only; no fixed settlement cap/i)
  assert.doesNotMatch(schemaV2, /new\.settlement_sequence\s*>\s*\d+/i)
  assert.match(schemaV2, /issue_v104_iteration_shadow_v2_prediction\(jsonb\)/i)
  assert.match(schemaV2, /settle_v104_iteration_shadow_v2_prediction\(jsonb\)/i)
  assert.doesNotMatch(schemaV2, /delete\s+from|truncate|drop\s+table/i)
  assert.match(rollbackV2, /enabled=false/i)
  assert.doesNotMatch(rollbackV2, /delete\s+from|truncate|drop\s+table/i)
})

test('v3 migration starts independent counters, freezes v2, and validates approved weights', () => {
  assert.match(schemaV3, /v104-seven-head-shadow-v3-main-player-pair-reweight/i)
  assert.match(schemaV3, /v104\.3\.0-seven-head-shadow\.3/i)
  for (const table of ['runtime_settings','sequence_counters','issuances','settlements','cycle_reports','weight_suggestions']) {
    assert.match(schemaV3, new RegExp(`public\\.v104_iteration_shadow_v3_${table}`, 'i'))
  }
  assert.match(schemaV3, /update public\.v104_iteration_shadow_v2_runtime_settings[\s\S]{0,300}enabled=false/i)
  assert.match(schemaV3, /values \('v104\.3\.0-seven-head-shadow\.3'\)[\s\S]{0,100}on conflict \(release_candidate\) do nothing/i)
  assert.match(schemaV3, /roadmap_trend_signals[\s\S]{0,120}0\.25/i)
  assert.match(schemaV3, /ask_road_signals[\s\S]{0,120}0\.35/i)
  assert.match(schemaV3, /shoe_banker_player_bias[\s\S]{0,120}0\.30/i)
  assert.match(schemaV3, /remaining_rank_pressure[\s\S]{0,120}0\.25/i)
  assert.match(schemaV3, /shoe_stage[\s\S]{0,120}0\.05/i)
  assert.match(schemaV3, /player_pair_count[\s\S]{0,120}0\.25/i)
  assert.match(schemaV3, /player_pair_residual[\s\S]{0,120}0\.15/i)
  assert.match(schemaV3, /pair_shared_factor[\s\S]{0,120}0\.30/i)
  assert.match(schemaV3, /manual stop only; no fixed settlement cap/i)
  assert.doesNotMatch(schemaV3, /new\.settlement_sequence\s*>\s*\d+/i)
  assert.doesNotMatch(schemaV3, /delete\s+from|truncate|drop\s+table/i)
  assert.match(rollbackV3, /enabled=false/i)
  assert.doesNotMatch(rollbackV3, /delete\s+from|truncate|drop\s+table/i)
})
