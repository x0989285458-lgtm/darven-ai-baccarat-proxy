import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

const repo = new URL('../../', import.meta.url)
const read = (relative) => readFileSync(new URL(relative, repo), 'utf8')

test('v103 shadow release manifest keeps every active build and strategy on v102', () => {
  const path = new URL('release/v103-shadow-release-manifest.json', repo)
  assert.equal(existsSync(path), true)
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(manifest.releaseCandidate, 'v103.0.0-shadow.1')
  assert.deepEqual(manifest.active, { productVersion: 'v102', proxyBuildVersion: 'v102', workerBuildVersion: '102', protocolVersion: 'v102', strategyVersion: 'v102' })
  assert.deepEqual(manifest.shadow, { strategyVersion: 'v103', status: 'shadow', activationEligible: false, memberVisible: false, writesSideActions: false })
})

test('v103 migration is additive idempotent service-role-only and never changes the sole v102 Active row', () => {
  const migration = read('frontend/supabase/schema_v103_shadow.sql')
  const rollback = read('frontend/supabase/disable_v103_shadow.sql')
  for (const table of ['v103_shadow_runtime_settings', 'v103_shadow_issuances', 'v103_shadow_settlements']) assert.match(migration, new RegExp(`create table if not exists public\\.${table}`, 'i'))
  for (const fn of ['issue_v103_shadow_prediction', 'settle_v103_shadow_prediction', 'get_v103_shadow_history']) {
    assert.match(migration, new RegExp(`function public\\.${fn}`, 'i'))
    assert.match(migration, new RegExp(`revoke all on function public\\.${fn}[\\s\\S]*from public, anon, authenticated`, 'i'))
    assert.match(migration, new RegExp(`grant execute on function public\\.${fn}[\\s\\S]*to service_role`, 'i'))
  }
  assert.match(migration, /prediction_timing[^\n]+pre_result_context/i)
  assert.match(migration, /show_poker/i)
  assert.doesNotMatch(migration, /settlement_source_action[^\n]+~\*/i)
  for (const action of ['summary', '/summary', '/api/v1/gametype/*/game/*/room/*/table/*/summary', 'show_win', '/show_win', '/api/v1/gametype/*/game/*/room/*/table/*/show_win']) {
    assert.equal(migration.includes(`'${action}'`), true)
  }
  assert.equal((migration.match(/security definer/gi) ?? []).length, 3)
  assert.equal((migration.match(/set search_path = pg_catalog, public, extensions/gi) ?? []).length, 3)
  assert.match(migration, /get_v103_shadow_history[\s\S]*order by resolved_at desc/i)
  assert.match(migration, /settlement_status[^\n]+push/i)
  assert.match(migration, /strategy_version[^\n]+v103/i)
  assert.match(migration, /status\s*=\s*'active'[^\n]+version\s*=\s*'v102'/i)
  assert.doesNotMatch(migration + rollback, /drop\s+(?:table|function)|truncate|delete\s+from/i)
  assert.doesNotMatch(migration + rollback, /revoke[^;]+v102/i)
  for (const table of ['v103_shadow_runtime_settings', 'v103_shadow_issuances', 'v103_shadow_settlements']) {
    assert.match(migration, new RegExp(`revoke all on table public\\.${table} from service_role`, 'i'))
  }
  assert.doesNotMatch(migration, /grant\s+[^;]*(?:insert|update|delete)[^;]*to service_role/i)
  assert.match(migration, /grant select on table public\.v103_shadow_issuances to service_role/i)
  assert.match(migration, /shadowOnly[^\n]+true[\s\S]*activationEligible[^\n]+false[\s\S]*writesSideActions[^\n]+false/i)
  assert.match(rollback, /enabled\s*=\s*false/i)
})

test('formal readers remain pinned to daily_prediction_results v104 and never read shadow tables', () => {
  const writer = read('proxy/src/supabase-writer.js')
  const admin = read('proxy/src/license-admin.js')
  assert.match(writer, /ALL_MT_EQUAL_STRATEGY_VERSION\s*=\s*'v104'/)
  assert.match(writer, /getStablePredictionRows[\s\S]*getRest\('daily_prediction_results'[\s\S]*strategy_version:\s*`eq\.\$\{ALL_MT_EQUAL_STRATEGY_VERSION\}`/)
  assert.match(writer, /getRecentPredictionRows[\s\S]*getRest\('daily_prediction_results'[\s\S]*strategy_version:\s*`eq\.\$\{ALL_MT_EQUAL_STRATEGY_VERSION\}`/)
  assert.doesNotMatch(admin, /v103_shadow_/i)
})
