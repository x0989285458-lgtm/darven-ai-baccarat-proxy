import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { ALL_MT_EQUAL_STRATEGY_VERSION, SIDE_PREDICTION_THRESHOLDS } from '../src/supabase-writer.js'

const repo = new URL('../../', import.meta.url)
const read = (relative) => readFileSync(new URL(relative, repo), 'utf8')

test('historical v105 release manifest remains internally coherent and preserves its frozen strategy contract', () => {
  const path = new URL('release/v105-formal-release-manifest.json', repo)
  assert.equal(existsSync(path), true)
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(manifest.packageVersion, '1.0.15')
  assert.equal(manifest.productVersion, 'v105')
  assert.equal(manifest.proxyBuildVersion, 'v105')
  assert.equal(manifest.workerBuildVersion, '105')
  assert.equal(manifest.protocolVersion, 'v105')
  assert.equal(manifest.strategyVersion, 'v105')
  assert.equal(ALL_MT_EQUAL_STRATEGY_VERSION, 'v105')
  assert.deepEqual(SIDE_PREDICTION_THRESHOLDS, {
    tie: 30, superSix: 50, bankerPair: 50, playerPair: 50, bankerDragon: 40, playerDragon: 40,
  })
  assert.deepEqual(manifest.deploymentOrder, ['database-additive', 'database-memory-additive', 'database-performance-additive', 'database-performance-rpc-additive', 'database-hotfix', 'proxy', 'worker', 'frontend', 'live-e2e', 'memory-activation', 'v104-pending-drain-zero', 'database-finalize'])
  assert.equal(manifest.rollbackTarget, 'v104')
  assert.deepEqual(manifest.rollbackRequires, ['v105-issuance-fenced', 'v105-active-pending-zero'])
})

test('v106 frontend and proxy remain coherent while the unchanged worker protocol stays v105', () => {
  assert.match(read('frontend/src/lib/buildVersion.ts'), /buildVersion:\s*'v106'[\s\S]*strategyVersion:\s*'v106'/)
  assert.match(read('frontend/package.json'), /"version":\s*"1\.0\.63"/)
  assert.match(read('proxy/package.json'), /"name":\s*"draven-mt-data-proxy-v106"[\s\S]*"version":\s*"1\.0\.81"/)
  assert.match(read('proxy/src/server.js'), /WORKER_PROTOCOL_BUILD_VERSION\s*=\s*'105'[\s\S]*WORKER_PROTOCOL_VERSION\s*=\s*'v105'/)
  assert.match(read('proxy/src/cloud-capture.js'), /buildVersion\s*!==\s*'105'/)
  assert.match(read('cloud-browser-worker/src/runtime-config.js'), /BUILD_VERSION\s*=\s*'105'/)
  assert.match(read('cloud-browser-worker/src/snapshot-pusher.js'), /protocolVersion:\s*'v105'/)
  assert.match(read('cloud-browser-worker/Dockerfile'), /org\.opencontainers\.image\.version="v105"/)
  assert.match(read('cloud-browser-worker/package.json'), /"version":\s*"1\.0\.63"/)
  assert.match(read('cloud-browser-worker/deploy/vm/release.env.example'), /WORKER_IMAGE=darven-worker:v105-REVIEWED_SHA/)
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