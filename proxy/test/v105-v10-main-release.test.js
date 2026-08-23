import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync(new URL('../../release/v105-v10-main-release-manifest.json', import.meta.url)))

test('V105 V10 main release changes prediction main only', () => {
  assert.equal(manifest.releaseVersion, 'v105-v10-main.17')
  assert.equal(manifest.formalStrategyVersion, 'v105')
  assert.deepEqual(manifest.releaseScope, {
    predictionMainOnly: true,
    productRuntimeChanged: true,
    databaseMigrationRequired: true,
    captureWorkerChanged: true,
    frontendChanged: false,
    sidePredictionChanged: false,
    formalIdentityChanged: false,
    zeroFinalHeartbeatFastAck: true,
    finalIdentityRankHydrationOnly: true,
    boundedLoginTimeoutMs: 30000,
    transientLoginRetryCount: 1,
    browserNetworkLoginRetry: true,
    singleConnectionLicensePool: true,
    zeroFinalHeartbeatOutboxFastComplete: true,
    superAdminSingleQueryLogin: true,
    boundedCurrentDayAnalytics: true,
    historicalJsonAnalyticsRemoved: true,
    rawAckReservedPoolSlot: true,
    outboxReplayPublishesLiveSnapshot: false,
    workerBacklogDrainCollectsOncePerTick: true,
    crossTableFormalSettlementConcurrency: 3,
    crossIdentityRankLedgerConcurrency: 3,
    failedEnvelopeDrainsAllTableBranches: true,
  })
  assert.equal(manifest.prediction.mainSource, 'v105-shadow-v10-big-road-uncommon-structure-rank-synchronized')
  assert.equal(manifest.prediction.beadPlateUsed, false)
  assert.equal(manifest.prediction.sideOutputs, 'exact-existing-v105')
})

test('V105 V10 main release binding covers the exact prediction implementation and required migration', () => {
  assert.match(manifest.releaseBinding.implementationTree.sha256, /^[a-f0-9]{64}$/)
  for (const required of ['cloud-browser-worker/src/snapshot-pusher.js', 'cloud-browser-worker/test/snapshot-pusher.test.js', 'proxy/src/cloud-capture.js', 'proxy/src/v100-formal-runtime.js', 'proxy/test/v100-formal-runtime.test.js', 'proxy/src/license-admin.js', 'proxy/src/server.js', 'proxy/src/state-store.js', 'proxy/src/supabase-writer.js', 'proxy/test/cloud-capture.test.js', 'proxy/test/v105-formal-ingest-backpressure-contract.test.js', 'proxy/test/admin-side-actions.test.js', 'proxy/test/prediction-integrity.test.js', 'proxy/test/prediction-safety.test.js', 'proxy/src/v105-formal-runtime.js', 'proxy/src/v105-v10-main-strategy.js', 'proxy/src/v105-shadow-v10-contract.js', 'proxy/src/v105-shadow-v10-structure.js', 'frontend/src/lib/onlineLicenseClient.ts', 'frontend/src/lib/onlineLicenseClient.test.ts', 'supabase/migrations/20260823113000_v105_zero_final_heartbeat_outbox_fast_complete.sql']) {
    assert.ok(manifest.releaseBinding.implementationTree.paths.includes(required), required)
  }
  assert.equal(manifest.releaseBinding.zeroFinalHeartbeatMigration.path, 'supabase/migrations/20260823113000_v105_zero_final_heartbeat_outbox_fast_complete.sql')
  assert.match(manifest.releaseBinding.zeroFinalHeartbeatMigration.sha256, /^[a-f0-9]{64}$/)
  assert.deepEqual(manifest.releaseBinding.workerBuildInput.paths, [
    'cloud-browser-worker/.dockerignore', 'cloud-browser-worker/Dockerfile',
    'cloud-browser-worker/package.json', 'cloud-browser-worker/package-lock.json',
    'cloud-browser-worker/src', 'shared',
  ])
  assert.match(manifest.releaseBinding.workerBuildInput.sha256, /^[a-f0-9]{64}$/)
})

test('V105 restore uses the immutable reviewed V106 terminalizer and rollback artifacts', () => {
  const root = new URL('../..', import.meta.url)
  const tag = manifest.rollbackFromCurrentV106.authorityTag
  for (const [pathKey, blobKey] of [['terminalizerPath', 'terminalizerBlob'], ['rollbackPath', 'rollbackBlob']]) {
    const actual = execFileSync('git', ['rev-parse', `${tag}:${manifest.rollbackFromCurrentV106[pathKey]}`], { cwd: root, encoding: 'utf8' }).trim()
    assert.equal(actual, manifest.rollbackFromCurrentV106[blobKey])
  }
  assert.deepEqual(manifest.deploymentOrder.slice(0, 8), [
    'verify-producer-stopped', 'archive-v106-backlog-evidence', 'run-bound-v106-terminalizer',
    'run-bound-v106-to-v105-rollback', 'verify-v105-sole-active',
    'apply-zero-final-heartbeat-outbox-migration', 'verify-zero-final-heartbeat-outbox-migration',
    'deploy-exact-v105-v10-main-proxy',
  ])
  assert.deepEqual(manifest.deploymentOrder.slice(8, 14), [
    'public-readiness-v105',
    'build-exact-v105-v10-main-worker-image',
    'verify-exact-worker-image-commit-digest',
    'deploy-exact-v105-v10-main-worker',
    'verify-worker-queue-cursor-journal-preserved',
    'ten-table-final-ack-v10-prediction-e2e',
  ])
})
