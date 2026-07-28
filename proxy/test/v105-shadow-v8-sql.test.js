import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const migrationUrl=new URL('../../supabase/migrations/20260727220000_v105_shadow_v8.sql',import.meta.url)
const stopIssuanceUrl=new URL('../../supabase/operations/stop_v105_shadow_v8_issuance.sql',import.meta.url)
const finalizeStopUrl=new URL('../../supabase/operations/finalize_v105_shadow_v8_stop.sql',import.meta.url)
const releaseManifestUrl=new URL('../../release/v105-shadow-v8-release-manifest.json',import.meta.url)

test('V8 migration is additive, idempotent, service-role-only, enabled, and starts an independent counter at zero',()=>{
  const sql=readFileSync(migrationUrl,'utf8')
  for(const table of ['runtime_settings','sequence_counters','issuances','settlements']) { assert.match(sql,new RegExp(`create table if not exists public\\.v105_shadow_v8_${table}`,'i')); assert.match(sql,new RegExp(`alter table public\\.v105_shadow_v8_${table} enable row level security`,'i')) }
  assert.match(sql,/values\s*\(\s*'v105-shadow-v8-run-length-ask-road'\s*,\s*'v105-shadow-v8-run-length-ask-road'\s*,\s*'shadow'\s*,\s*true\s*,\s*'v105'/i)
  assert.match(sql,/insert into public\.v105_shadow_v8_sequence_counters[\s\S]{0,180}values\s*\(\s*'v105-shadow-v8-run-length-ask-road'\s*,\s*0\s*\)[\s\S]{0,120}on conflict/i)
  assert.match(sql,/create or replace function public\.issue_v105_shadow_v8_prediction\(p_prediction jsonb\)/i)
  assert.match(sql,/create or replace function public\.settle_v105_shadow_v8_prediction\(p_settlement jsonb\)/i)
  assert.match(sql,/create or replace view public\.v105_shadow_v8_history/i)
  assert.match(sql,/prediction_payload'->'askRoadSignal'/i)
  assert.match(sql,/settlement_source_action' not in \('summary','show_win'\)/i)
  for(const fn of ['issue_v105_shadow_v8_prediction','settle_v105_shadow_v8_prediction']) { assert.match(sql,new RegExp(`revoke all on function public\\.${fn}\\(jsonb\\) from public,anon,authenticated,service_role`,'i')); assert.match(sql,new RegExp(`grant execute on function public\\.${fn}\\(jsonb\\) to service_role`,'i')) }
  assert.doesNotMatch(sql,/\b(drop|truncate|delete\s+from)\b/i)
  assert.doesNotMatch(sql,/\b(alter|insert\s+into|update)\s+(table\s+)?public\.(v105_shadow_v[67]|v104_iteration_shadow_v5)_/i)
})

test('V8 RPCs reject every old strategy identity',()=>{
  const sql=readFileSync(migrationUrl,'utf8')
  assert.match(sql,/p_prediction->>'strategy_version'\s+is distinct from\s+'v105-shadow-v8-run-length-ask-road'/i)
  assert.match(sql,/p_settlement->>'strategy_version'\s+is distinct from\s+'v105-shadow-v8-run-length-ask-road'/i)
  assert.match(sql,/issued\.strategy_version\s*<>\s*'v105-shadow-v8-run-length-ask-road'/i)
})

test('V8 issuance binds every duplicated risk field to the immutable payload',()=>{
  const sql=readFileSync(migrationUrl,'utf8')
  assert.match(sql,/prediction_payload'->>'independentSupportCount'[\s\S]*independent_support_count/i)
  assert.match(sql,/prediction_payload'->>'shoeBiasSuppressed'[\s\S]*shoe_bias_suppressed/i)
  assert.match(sql,/prediction_payload'->>'lockRisk'[\s\S]*lock_risk/i)
})

test('V8 settlement serializes concurrent replay on the immutable issuance row',()=>{
  const sql=readFileSync(migrationUrl,'utf8')
  assert.match(sql,/select \* into issued from public\.v105_shadow_v8_issuances[\s\S]*where id=\(p_settlement->>'prediction_id'\)::uuid for update;/i)
  assert.doesNotMatch(sql,/where id=\(p_settlement->>'prediction_id'\)::uuid for share;/i)
})

test('V8 settlement revalidates exact cards, main outcome, every head action, and payout in SQL',()=>{
  const sql=readFileSync(migrationUrl,'utf8')
  assert.match(sql,/V8 exact card ranks are required/i)
  assert.match(sql,/V8 actual facts do not match exact cards/i)
  assert.match(sql,/V8 main outcome is inconsistent/i)
  assert.match(sql,/V8 head action mismatch/i)
  assert.match(sql,/V8 payout mismatch/i)
})

test('V8 release has a DB-first manifest and a drain-safe manual stop',()=>{
  const stop=readFileSync(stopIssuanceUrl,'utf8')
  const finalize=readFileSync(finalizeStopUrl,'utf8')
  const manifest=JSON.parse(readFileSync(releaseManifestUrl,'utf8'))
  assert.match(stop,/update public\.v105_shadow_v8_runtime_settings[\s\S]*set enabled=false,status='shadow_disabled'/i)
  assert.match(stop,/revoke execute on function public\.issue_v105_shadow_v8_prediction\(jsonb\) from service_role/i)
  assert.doesNotMatch(stop,/revoke execute on function public\.settle_v105_shadow_v8_prediction/i)
  assert.match(finalize,/left join public\.v105_shadow_v8_settlements[\s\S]*where s\.prediction_id is null/i)
  assert.match(finalize,/if pending_count <> 0 then[\s\S]*raise exception/i)
  assert.match(finalize,/revoke execute on function public\.settle_v105_shadow_v8_prediction\(jsonb\) from service_role/i)
  assert.equal(manifest.release,'v105-shadow-v8.1')
  assert.equal(manifest.strategyVersion,'v105-shadow-v8-run-length-ask-road')
  assert.equal(manifest.formalStrategyVersion,'v105')
  assert.deepEqual(manifest.deployment.order,['database-additive','catalog-acl-readback','postgrest-smoke','render-proxy','production-e2e'])
  assert.equal(manifest.rollback.drainSafe,true)
})
