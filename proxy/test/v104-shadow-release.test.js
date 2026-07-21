import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

const repo = new URL('../../', import.meta.url)
const read = (relative) => readFileSync(new URL(relative, repo), 'utf8')

test('v104 manifest adds one shadow while v102 remains Active and v103 continues unchanged', () => {
  const path = new URL('release/v104-shadow-release-manifest.json', repo)
  assert.equal(existsSync(path), true)
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(manifest.releaseCandidate, 'v104.0.0-shadow.1')
  assert.deepEqual(manifest.active, { productVersion: 'v102', proxyBuildVersion: 'v102', workerBuildVersion: '102', protocolVersion: 'v102', strategyVersion: 'v102' })
  assert.deepEqual(manifest.existingShadow, { releaseCandidate: 'v103.0.0-shadow.1', strategyVersion: 'v103', status: 'shadow', continues: true })
  assert.deepEqual(manifest.shadow.directionWeights, {
    roadmap_trend_signals: 0.275, ask_road_signals: 0.275,
    shoe_banker_player_bias: 0.35, neutral_reserve: 0.10,
  })
  assert.deepEqual(manifest.shadow.shoeBias, { priorSampleSize: 8, maximumEdge: 0.08, priorCenter: 0.5 })
  assert.deepEqual(manifest.shadow.lockGuard, {
    startsAtSameSideStreak: 5,
    requiredIndependentSupports: 2,
    suppressesShoeBiasWhenInsufficient: true,
    conflictPrimarySource: 'roadmap_trend_signals',
    suppressesDerivedAskRoadOnConflict: true,
    forcesOppositeDirection: false,
  })
  assert.equal(manifest.shadow.calibrationDirectionContribution, 0)
  assert.equal(manifest.frontendChanged, false)
  assert.equal(manifest.workerChanged, false)
})

test('v104 migration is additive, idempotent, sole-v102-Active, and service-role SELECT plus RPC only', () => {
  const migration = read('frontend/supabase/schema_v104_shadow.sql')
  const disable = read('frontend/supabase/disable_v104_shadow.sql')
  for (const table of ['v104_shadow_runtime_settings', 'v104_shadow_issuances', 'v104_shadow_settlements']) {
    assert.match(migration, new RegExp(`create table if not exists public\\.${table}`, 'i'))
    assert.match(migration, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated`, 'i'))
    assert.match(migration, new RegExp(`revoke all on table public\\.${table} from service_role`, 'i'))
    assert.match(migration, new RegExp(`grant select on table public\\.${table} to service_role`, 'i'))
  }
  for (const fn of ['issue_v104_shadow_prediction', 'settle_v104_shadow_prediction', 'get_v104_shadow_history']) {
    assert.match(migration, new RegExp(`function public\\.${fn}`, 'i'))
    assert.match(migration, new RegExp(`revoke all on function public\\.${fn}[\\s\\S]*from public, anon, authenticated`, 'i'))
    assert.match(migration, new RegExp(`grant execute on function public\\.${fn}[\\s\\S]*to service_role`, 'i'))
  }
  assert.equal((migration.match(/security definer/gi) ?? []).length, 3)
  assert.equal((migration.match(/set search_path = pg_catalog, public, extensions/gi) ?? []).length, 3)
  assert.match(migration, /status\s*=\s*'active'[^\n]+version\s*=\s*'v102'/i)
  assert.match(migration, /count\(\*\)[\s\S]*status\s*=\s*'active'[\s\S]*<>\s*1/i)
  assert.match(migration, /same_side_streak/i)
  assert.match(migration, /independent_support_count/i)
  assert.match(migration, /shoe_bias_suppressed/i)
  assert.match(migration, /lock_risk/i)
  assert.match(migration, /left join public\.v104_shadow_settlements/i)
  assert.match(migration, /i\.prediction_payload/i)
  assert.match(migration, /order by prediction_issued_at desc[\s\S]*limit least\(10000[\s\S]*order by prediction_issued_at asc/i)
  assert.doesNotMatch(migration, /grant\s+[^;]*(?:insert|update|delete)[^;]*to service_role/i)
  assert.doesNotMatch(migration + disable, /drop\s+(?:table|function)|truncate|delete\s+from/i)
  assert.doesNotMatch(migration + disable, /(?:update|insert\s+into|revoke)[^;]+v10[23]_/i)
  assert.match(disable, /enabled\s*=\s*false/i)
  assert.match(disable, /revoke execute on function public\.issue_v104_shadow_prediction\(jsonb\) from service_role/i)
})

test('v104 SQL enforces immutable first-write-wins, verified Final, PUSH, and payload diagnostics', () => {
  const migration = read('frontend/supabase/schema_v104_shadow.sql')
  assert.match(migration, /on conflict \(source, table_id, shoe_no, round_no, strategy_version\) do nothing/i)
  assert.match(migration, /conflicting v104 shadow issuance/i)
  assert.match(migration, /conflicting v104 shadow settlement/i)
  assert.match(migration, /show_poker/i)
  for (const action of ['summary', '/summary', '/api/v1/gametype/*/game/*/room/*/table/*/summary', 'show_win', '/show_win', '/api/v1/gametype/*/game/*/room/*/table/*/show_win']) {
    assert.equal(migration.includes(`'${action}'`), true)
  }
  assert.match(migration, /settlement_status[^\n]+push/i)
  assert.match(migration, /sameSideStreak/i)
  assert.match(migration, /independentSupportCount/i)
  assert.match(migration, /shoeBiasSuppressed/i)
  assert.match(migration, /lockRisk/i)
})

test('deployment guide promotes v104 coherently and preserves rollback and shadow history', () => {
  const deployment = read('proxy/deploy/DEPLOYMENT.md')
  assert.match(deployment, /v104\.0\.0-formal\.2/i)
  assert.match(deployment, /V103_SHADOW_ENABLED=true/i)
  assert.match(deployment, /V104_SHADOW_ENABLED=false/i)
  assert.match(deployment, /schema_v104_formal\.sql/i)
  assert.match(deployment, /disable_v104_shadow\.sql/i)
  assert.match(deployment, /rollback_v104_to_v102\.sql/i)
  assert.match(deployment, /Frontend、Proxy、Worker、Push Protocol、策略與監控身分統一為v104/i)
  assert.match(deployment, /\/health`為v104/i)
})
