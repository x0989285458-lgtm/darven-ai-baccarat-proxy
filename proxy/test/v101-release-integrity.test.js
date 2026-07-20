import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { BUILD_VERSION as PROXY_BUILD_VERSION } from '../src/build-version.js'
import { ALL_MT_EQUAL_STRATEGY_VERSION, SIDE_PREDICTION_THRESHOLDS } from '../src/supabase-writer.js'

const repo = new URL('../../', import.meta.url)
const read = (relative) => readFileSync(new URL(relative, repo), 'utf8')

test('v101 release manifest keeps every active product surface on one identity', () => {
  const manifestPath = new URL('release/v101-release-manifest.json', repo)
  assert.equal(existsSync(manifestPath), true, 'v101 release manifest must exist')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.deepEqual(manifest.identity, {
    productVersion: 'v101',
    releaseVersion: 'v101.0.5',
    proxyBuildVersion: 'v101',
    workerBuildVersion: '101',
    protocolVersion: 'v101',
    strategyVersion: 'v101',
    packageVersion: '1.0.10',
  })
  assert.deepEqual(manifest.sideThresholds, {
    tie: 30,
    superSix: 50,
    bankerPair: 50,
    playerPair: 50,
    bankerDragon: 40,
    playerDragon: 40,
  })
  assert.equal(PROXY_BUILD_VERSION, 'v101')
  assert.equal(ALL_MT_EQUAL_STRATEGY_VERSION, 'v101')
  assert.deepEqual(SIDE_PREDICTION_THRESHOLDS, manifest.sideThresholds)
})

test('v101 active frontend proxy worker protocol and RPC files match the manifest', () => {
  assert.match(read('frontend/src/lib/buildVersion.ts'), /buildVersion:\s*'v101'[\s\S]*strategyVersion:\s*'v101'/)
  assert.match(read('frontend/package.json'), /"version":\s*"1\.0\.9"/)
  assert.match(read('proxy/package.json'), /"name":\s*"draven-mt-data-proxy-v101"[\s\S]*"version":\s*"1\.0\.9"/)
  const server = read('proxy/src/server.js')
  assert.match(server, /WORKER_PROTOCOL_BUILD_VERSION\s*=\s*'101'[\s\S]*WORKER_PROTOCOL_VERSION\s*=\s*'v101'/)
  assert.match(server, /expectedProtocolVersion:\s*WORKER_PROTOCOL_VERSION[\s\S]*receivedProtocolVersion:\s*WORKER_PROTOCOL_VERSION/)
  assert.doesNotMatch(server, /expectedProtocolVersion:\s*'v100'|receivedProtocolVersion:\s*'v100'/)
  assert.match(read('proxy/src/cloud-capture.js'), /v101RuntimeStatus[\s\S]*v101RuntimeError/)
  assert.doesNotMatch(read('proxy/src/cloud-capture.js'), /v100RuntimeStatus|v100RuntimeError/)
  assert.doesNotMatch(read('proxy/src/test-report-persistence.js'), /strategyVersion\s*=\s*'v100'/)
  assert.match(read('proxy/src/test-report-persistence.js'), /strategyVersion\s*=\s*'v101'/)
  assert.match(read('proxy/src/stable-report.js'), /## v101 已保存預測結算報表/)
  assert.match(read('cloud-browser-worker/src/runtime-config.js'), /BUILD_VERSION\s*=\s*'101'/)
  assert.match(read('cloud-browser-worker/Dockerfile'), /org\.opencontainers\.image\.version="v101"/)
  assert.doesNotMatch(read('cloud-browser-worker/src/snapshot-pusher.js'), /protocolVersion:\s*'v100'/)
  assert.match(read('cloud-browser-worker/src/snapshot-pusher.js'), /protocolVersion:\s*'v101'/)
  assert.match(read('cloud-browser-worker/package.json'), /"version":\s*"1\.0\.10"[\s\S]*v101/)
  assert.match(read('cloud-browser-worker/deploy/vm/release.env.example'), /WORKER_IMAGE=darven-worker:v101-REVIEWED_SHA/)
  assert.match(read('proxy/deploy/DEPLOYMENT.md'), /schema_v101_latest_only\.sql[\s\S]*v101:active[\s\S]*v101\.0\.0-formal\.1/)
  const writer = read('proxy/src/supabase-writer.js')
  for (const rpc of ['apply_v101_rank_ledger_event','reconcile_v101_prediction_lifecycle','issue_v101_prediction','settle_v101_prediction','persist_v101_settled_round','get_v101_prediction_lifecycle_stats']) assert.match(writer, new RegExp(`rpc/${rpc}`))
})

test('v101 additive migration and rollback preserve v100 as inactive history', () => {
  const migrationPath = new URL('frontend/supabase/schema_v101_latest_only.sql', repo)
  const rollbackPath = new URL('frontend/supabase/rollback_v101_to_v100.sql', repo)
  assert.equal(existsSync(migrationPath), true, 'v101 additive migration must exist')
  assert.equal(existsSync(rollbackPath), true, 'v101 rollback must exist')
  const migration = read('frontend/supabase/schema_v101_latest_only.sql')
  const rollback = read('frontend/supabase/rollback_v101_to_v100.sql')
  for (const fn of ['issue_v101_prediction','settle_v101_prediction','reconcile_v101_prediction_lifecycle','get_v101_prediction_lifecycle_stats','persist_v101_settled_round','apply_v101_rank_ledger_event']) assert.match(migration, new RegExp(`function public\\.${fn}`, 'i'))
  assert.match(migration, /insert into public\.v101_formal_release_previous_active\(version\)[\s\S]*select 'v100'[\s\S]*exists \(select 1 from public\.ai_strategy_versions where version = 'v100'\)/i)
  assert.match(migration, /revoke execute on function public\.issue_v100_prediction\(jsonb\) from service_role/i)
  assert.match(migration, /revoke execute on function public\.apply_v100_rank_ledger_event\(jsonb, jsonb\) from service_role/i)
  assert.doesNotMatch(migration, /drop\s+(?:table|function)|truncate|delete\s+from/i)
  assert.match(migration, /'tie',\s*30/)
  assert.match(migration, /'superSix',\s*50/)
  assert.match(migration, /'bankerPair',\s*50/)
  assert.match(migration, /'playerPair',\s*50/)
  assert.match(migration, /'bankerDragon',\s*40/)
  assert.match(migration, /'playerDragon',\s*40/)
  assert.match(migration, /update public\.ai_strategy_versions[\s\S]*status\s*=\s*'archived'/i)
  assert.match(migration, /insert into public\.ai_strategy_versions[\s\S]*'v101'/i)
  assert.match(rollback, /version\s*=\s*'v100'/i)
  assert.match(rollback, /revoke execute on function public\.issue_v101_prediction\(jsonb\) from service_role/i)
  assert.match(rollback, /grant execute on function public\.issue_v100_prediction\(jsonb\) to service_role/i)
  assert.doesNotMatch(rollback, /drop\s+(?:table|function)|truncate|delete\s+from/i)
})
