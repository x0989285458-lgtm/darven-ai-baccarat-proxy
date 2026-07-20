import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { BUILD_VERSION as PROXY_BUILD_VERSION } from '../src/build-version.js'
import { ALL_MT_EQUAL_STRATEGY_VERSION, ALL_MT_EQUAL_MAIN_WEIGHTS, SIDE_PREDICTION_THRESHOLDS } from '../src/supabase-writer.js'

const repo = new URL('../../', import.meta.url)
const read = (relative) => readFileSync(new URL(relative, repo), 'utf8')

test('v102 release manifest and runtime share one identity and approved main policy', () => {
  const path = new URL('release/v102-release-manifest.json', repo)
  assert.equal(existsSync(path), true)
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  assert.deepEqual(manifest.identity, {
    productVersion: 'v102', proxyBuildVersion: 'v102', workerBuildVersion: '102',
    protocolVersion: 'v102', strategyVersion: 'v102', packageVersion: '1.0.10',
  })
  assert.equal(PROXY_BUILD_VERSION, 'v102')
  assert.equal(ALL_MT_EQUAL_STRATEGY_VERSION, 'v102')
  assert.deepEqual(ALL_MT_EQUAL_MAIN_WEIGHTS, manifest.mainWeights)
  assert.deepEqual(SIDE_PREDICTION_THRESHOLDS, manifest.sideThresholds)
})

test('v102 active frontend proxy worker protocol and deployment surfaces match', () => {
  assert.match(read('frontend/src/lib/buildVersion.ts'), /buildVersion:\s*'v102'[\s\S]*strategyVersion:\s*'v102'/)
  assert.match(read('frontend/package.json'), /"version":\s*"1\.0\.10"/)
  assert.match(read('proxy/package.json'), /"name":\s*"draven-mt-data-proxy-v102"[\s\S]*"version":\s*"1\.0\.10"/)
  assert.match(read('proxy/src/server.js'), /WORKER_PROTOCOL_BUILD_VERSION\s*=\s*'102'[\s\S]*WORKER_PROTOCOL_VERSION\s*=\s*'v102'/)
  assert.match(read('proxy/src/cloud-capture.js'), /buildVersion\s*!==\s*'102'/)
  assert.match(read('cloud-browser-worker/src/runtime-config.js'), /BUILD_VERSION\s*=\s*'102'/)
  assert.match(read('cloud-browser-worker/src/snapshot-pusher.js'), /protocolVersion:\s*'v102'/)
  assert.match(read('cloud-browser-worker/Dockerfile'), /org\.opencontainers\.image\.version="v102"/)
  assert.match(read('cloud-browser-worker/package.json'), /"version":\s*"1\.0\.10"/)
  assert.match(read('cloud-browser-worker/deploy/vm/release.env.example'), /WORKER_IMAGE=darven-worker:v102-REVIEWED_SHA/)
})

test('v102 additive migration activates v102 and rollback restores v101 without deletion', () => {
  for (const relative of ['frontend/supabase/schema_v102_latest_only.sql', 'frontend/supabase/rollback_v102_to_v101.sql']) assert.equal(existsSync(new URL(relative, repo)), true)
  const migration = read('frontend/supabase/schema_v102_latest_only.sql')
  const rollback = read('frontend/supabase/rollback_v102_to_v101.sql')
  for (const fn of ['issue_v102_prediction','settle_v102_prediction','reconcile_v102_prediction_lifecycle','get_v102_prediction_lifecycle_stats','persist_v102_settled_round','apply_v102_rank_ledger_event']) assert.match(migration, new RegExp(`function public\\.${fn}`, 'i'))
  assert.match(migration, /select 'v101'[\s\S]*version = 'v101'/i)
  assert.match(migration, /insert into public\.ai_strategy_versions[\s\S]*'v102'/i)
  assert.match(rollback, /version\s*=\s*'v101'/i)
  assert.doesNotMatch(migration + rollback, /drop\s+(?:table|function)|truncate|delete\s+from/i)
})
