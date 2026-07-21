import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { BUILD_VERSION as PROXY_BUILD_VERSION } from '../src/build-version.js'
import { ALL_MT_EQUAL_STRATEGY_VERSION, SIDE_PREDICTION_THRESHOLDS } from '../src/supabase-writer.js'

const repo = new URL('../../', import.meta.url)
const read = (relative) => readFileSync(new URL(relative, repo), 'utf8')

test('v104 release manifest and runtime share one formal identity', () => {
  const path = new URL('release/v104-formal-release-manifest.json', repo)
  assert.equal(existsSync(path), true)
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(manifest.packageVersion, '1.0.11')
  assert.equal(manifest.productVersion, 'v104')
  assert.equal(manifest.proxyBuildVersion, 'v104')
  assert.equal(manifest.workerBuildVersion, '104')
  assert.equal(manifest.protocolVersion, 'v104')
  assert.equal(manifest.strategyVersion, 'v104')
  assert.equal(PROXY_BUILD_VERSION, 'v104')
  assert.equal(ALL_MT_EQUAL_STRATEGY_VERSION, 'v104')
  assert.deepEqual(SIDE_PREDICTION_THRESHOLDS, {
    tie: 30, superSix: 50, bankerPair: 50, playerPair: 50, bankerDragon: 40, playerDragon: 40,
  })
  assert.deepEqual(manifest.deploymentOrder, ['database-additive', 'proxy', 'worker', 'frontend', 'live-e2e', 'database-finalize'])
  assert.equal(manifest.rollbackTarget, 'v102')
})

test('v104 active frontend proxy worker protocol and deployment surfaces match', () => {
  assert.match(read('frontend/src/lib/buildVersion.ts'), /buildVersion:\s*'v104'[\s\S]*strategyVersion:\s*'v104'/)
  assert.match(read('frontend/package.json'), /"version":\s*"1\.0\.11"/)
  assert.match(read('proxy/package.json'), /"name":\s*"draven-mt-data-proxy-v104"[\s\S]*"version":\s*"1\.0\.11"/)
  assert.match(read('proxy/src/server.js'), /WORKER_PROTOCOL_BUILD_VERSION\s*=\s*'104'[\s\S]*WORKER_PROTOCOL_VERSION\s*=\s*'v104'/)
  assert.match(read('proxy/src/cloud-capture.js'), /buildVersion\s*!==\s*'104'/)
  assert.match(read('cloud-browser-worker/src/runtime-config.js'), /BUILD_VERSION\s*=\s*'104'/)
  assert.match(read('cloud-browser-worker/src/snapshot-pusher.js'), /protocolVersion:\s*'v104'/)
  assert.match(read('cloud-browser-worker/Dockerfile'), /org\.opencontainers\.image\.version="v104"/)
  assert.match(read('cloud-browser-worker/package.json'), /"version":\s*"1\.0\.11"/)
  assert.match(read('cloud-browser-worker/deploy/vm/release.env.example'), /WORKER_IMAGE=darven-worker:v104-REVIEWED_SHA/)
})

test('v102 additive migration activates v102 and rollback restores v101 without deletion', () => {
  for (const relative of ['frontend/supabase/schema_v102_latest_only.sql', 'frontend/supabase/finalize_v102_cutover.sql', 'frontend/supabase/rollback_v102_to_v101.sql']) assert.equal(existsSync(new URL(relative, repo)), true)
  const migration = read('frontend/supabase/schema_v102_latest_only.sql')
  const finalize = read('frontend/supabase/finalize_v102_cutover.sql')
  const rollback = read('frontend/supabase/rollback_v102_to_v101.sql')
  for (const fn of ['issue_v102_prediction','settle_v102_prediction','reconcile_v102_prediction_lifecycle','get_v102_prediction_lifecycle_stats','persist_v102_settled_round','apply_v102_rank_ledger_event']) assert.match(migration, new RegExp(`function public\\.${fn}`, 'i'))
  assert.match(migration, /select 'v101'[\s\S]*version = 'v101'/i)
  assert.match(migration, /insert into public\.ai_strategy_versions[\s\S]*'v102'/i)
  assert.match(migration, /jsonb_build_object\([\s\S]*'roadmap_trend_signals',\s*0\.35[\s\S]*'neutral_reserve',\s*0\.10[\s\S]*\)\s+as weights/i)
  assert.doesNotMatch(migration, /weights\s*\|\|\s*jsonb_build_object/i)
  assert.match(migration, /\{main_weights\}[\s\S]*'roadmap_trend_signals',\s*0\.35[\s\S]*'neutral_reserve',\s*0\.10/i)
  assert.doesNotMatch(migration, /revoke execute on function public\.issue_v101_prediction/i)
  for (const signature of [
    'get_v101_prediction_lifecycle_stats\\(\\)',
    'reconcile_v101_prediction_lifecycle\\(text, text, text, integer\\)',
    'persist_v101_settled_round\\(jsonb, jsonb\\)',
    'settle_v101_prediction\\(jsonb, jsonb\\)',
    'issue_v101_prediction\\(jsonb\\)',
    'apply_v101_rank_ledger_event\\(jsonb, jsonb\\)',
  ]) assert.match(migration, new RegExp(`grant execute on function public\\.${signature} to service_role`, 'i'))
  assert.match(finalize, /revoke execute on function public\.issue_v101_prediction\(jsonb\) from service_role/i)
  assert.match(rollback, /version\s*=\s*'v101'/i)
  assert.doesNotMatch(migration + finalize + rollback, /drop\s+(?:table|function)|truncate|delete\s+from/i)
})
