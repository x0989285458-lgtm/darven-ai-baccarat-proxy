import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const schema = fs.readFileSync(new URL('../../frontend/supabase/schema_v104_iteration_shadow.sql', import.meta.url), 'utf8')
const disable = fs.readFileSync(new URL('../../frontend/supabase/disable_v104_iteration_shadow.sql', import.meta.url), 'utf8')
const rollback = fs.readFileSync(new URL('../../frontend/supabase/rollback_v104_iteration_shadow.sql', import.meta.url), 'utf8')

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
