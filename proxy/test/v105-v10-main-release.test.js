import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { verifyV105V10MainManifestDigests } from '../../scripts/verify-v105-mt-api-release.mjs'

const manifest = JSON.parse(readFileSync(new URL('../../release/v105-v10-main-release-manifest.json', import.meta.url)))
const dependencyManifest = JSON.parse(readFileSync(new URL('../../release/v105-v10-main21-source-fence-release-manifest.json', import.meta.url)))
const releaseReport = JSON.parse(readFileSync(new URL('../../release/v105-v10-main-release-report.json', import.meta.url)))
const formalConsumerDockerfile = readFileSync(new URL('../Dockerfile.formal-consumer', import.meta.url), 'utf8')

test('V105 Main21 preserves formal prediction while changing receiver ownership', () => {
  assert.equal(manifest.releaseVersion, 'v105-v10-main.21')
  assert.equal(manifest.formalStrategyVersion, 'v105')
  assert.deepEqual(manifest.releaseScope, {
    predictionMainOnly: false,
    productRuntimeChanged: true,
    databaseMigrationRequired: true,
    captureWorkerChanged: false,
    frontendChanged: true,
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
    sameSessionOutboxBatchLimit: 10,
    atomicOutboxBatchLeaseAck: true,
    httpParentExternalConsumerIsolation: true,
    externalFormalConsumerChanged: true,
    transportRebindMigrationBound: true,
  })
  assert.equal(manifest.prediction.mainSource, 'v105-shadow-v10-big-road-uncommon-structure-rank-synchronized')
  assert.equal(manifest.prediction.beadPlateUsed, false)
  assert.equal(manifest.prediction.sideOutputs, 'exact-existing-v105')
  assert.match(formalConsumerDockerfile, /ENV CAPTURE_OUTBOX_CONSUMER_ENABLED=true/)
  assert.match(formalConsumerDockerfile, /ENV CAPTURE_OUTBOX_POLL_MS=3000/)
  assert.equal(releaseReport.releaseVersion, manifest.releaseVersion)
  assert.equal(releaseReport.title, 'V105主預測V10穩定版21接收器隔離正式發布報告')
  assert.equal(releaseReport.formalStrategyVersion, 'v105')
  assert.equal(releaseReport.applicationVersion, manifest.applicationVersion)
  assert.equal(releaseReport.baseCommit, manifest.baseCommit)
  assert.equal(releaseReport.scope, 'V105與V10預測規則、權重、門檻及Formal身份不變；Main21將HTTP Parent限制為被動Tables與狀態更新，Formal Outbox與Shadow lifecycle僅由External Consumer擁有')
  assert.deepEqual(releaseReport.review, {
    predictionRulesChanged: false,
    predictionWeightsChanged: false,
    predictionThresholdsChanged: false,
    receiverOwnershipChanged: true,
    externalConsumerOwnsFormalLifecycle: true,
    httpParentStartsPredictionRuntimes: false,
  })
})

test('V105 V10 main release binding covers the exact prediction implementation and required migration', () => {
  assert.match(manifest.releaseBinding.implementationTree.sha256, /^[a-f0-9]{64}$/)
  for (const required of ['cloud-browser-worker/src/snapshot-pusher.js', 'cloud-browser-worker/test/snapshot-pusher.test.js', 'proxy/src/cloud-capture.js', 'proxy/src/v100-formal-runtime.js', 'proxy/test/v100-formal-runtime.test.js', 'proxy/src/license-admin.js', 'proxy/src/server.js', 'proxy/src/state-store.js', 'proxy/src/supabase-writer.js', 'proxy/test/cloud-capture.test.js', 'proxy/test/capture-outbox-ack.test.js', 'proxy/test/capture-outbox-writer.test.js', 'proxy/test/v105-formal-ingest-backpressure-contract.test.js', 'proxy/test/admin-side-actions.test.js', 'proxy/test/prediction-integrity.test.js', 'proxy/test/prediction-safety.test.js', 'proxy/src/v105-formal-runtime.js', 'proxy/src/v105-v10-main-strategy.js', 'proxy/src/v105-shadow-v10-contract.js', 'proxy/src/v105-shadow-v10-structure.js', 'frontend/src/lib/onlineLicenseClient.ts', 'frontend/src/lib/onlineLicenseClient.test.ts', 'frontend/src/App.tsx', 'frontend/src/App.test.tsx', 'proxy/Dockerfile.formal-consumer', 'proxy/Dockerfile.formal-consumer.dockerignore', 'release/v105-v10-main-release-report.json', 'supabase/migrations/20260823113000_v105_zero_final_heartbeat_outbox_fast_complete.sql', 'supabase/migrations/20260824010000_v105_capture_outbox_same_session_batch.sql', 'supabase/migrations/20260824143000_v105_capture_transport_rebind_idempotency.sql']) {
    assert.ok(manifest.releaseBinding.implementationTree.paths.includes(required), required)
  }
  assert.equal(manifest.releaseBinding.zeroFinalHeartbeatMigration.path, 'supabase/migrations/20260823113000_v105_zero_final_heartbeat_outbox_fast_complete.sql')
  assert.match(manifest.releaseBinding.zeroFinalHeartbeatMigration.sha256, /^[a-f0-9]{64}$/)
  assert.equal(manifest.releaseBinding.sameSessionOutboxBatchMigration.path, 'supabase/migrations/20260824010000_v105_capture_outbox_same_session_batch.sql')
  assert.match(manifest.releaseBinding.sameSessionOutboxBatchMigration.sha256, /^[a-f0-9]{64}$/)
  assert.equal(manifest.releaseBinding.transportRebindMigration.path, 'supabase/migrations/20260824143000_v105_capture_transport_rebind_idempotency.sql')
  assert.match(manifest.releaseBinding.transportRebindMigration.sha256, /^[a-f0-9]{64}$/)
  assert.deepEqual(manifest.releaseBinding.formalConsumerBuildInput.paths, [
    'proxy/Dockerfile.formal-consumer', 'proxy/Dockerfile.formal-consumer.dockerignore',
    'proxy/package.json', 'proxy/package-lock.json', 'proxy/src', 'shared',
  ])
  assert.match(manifest.releaseBinding.formalConsumerBuildInput.sha256, /^[a-f0-9]{64}$/)
  assert.deepEqual(manifest.releaseBinding.workerBuildInput.paths, [
    'cloud-browser-worker/.dockerignore', 'cloud-browser-worker/Dockerfile',
    'cloud-browser-worker/package.json', 'cloud-browser-worker/package-lock.json',
    'cloud-browser-worker/src', 'shared',
  ])
  assert.match(manifest.releaseBinding.workerBuildInput.sha256, /^[a-f0-9]{64}$/)
})

test('V105 V10 main canonical verifier loads both manifests and rejects duplicate or drifted batch authority', async () => {
  const root = new URL('../..', import.meta.url)
  const candidateIndexTree = execFileSync('git', ['write-tree'], { cwd: root, encoding: 'utf8' }).trim()
  const result = await verifyV105V10MainManifestDigests({ manifest, dependencyManifest, repoRoot: root, candidateIndexTree })
  assert.equal(result.mainImplementationTreeSha256, manifest.releaseBinding.implementationTree.sha256)
  const duplicateProxy = structuredClone(manifest)
  duplicateProxy.deploymentOrder.unshift('deploy-exact-v105-v10-main21-proxy')
  await assert.rejects(verifyV105V10MainManifestDigests({ manifest: duplicateProxy, dependencyManifest, repoRoot: root, candidateIndexTree }), /v105_v10_main_deployment_order_duplicate/)
  const driftedDependency = structuredClone(dependencyManifest)
  driftedDependency.gitTag = 'v105-v10-main.18'
  await assert.rejects(verifyV105V10MainManifestDigests({ manifest, dependencyManifest: driftedDependency, repoRoot: root, candidateIndexTree }), /v105_v10_main_dependency_identity_invalid/)
  const driftedDependencyBase = structuredClone(dependencyManifest)
  driftedDependencyBase.baseCommit = '0'.repeat(40)
  await assert.rejects(verifyV105V10MainManifestDigests({ manifest, dependencyManifest: driftedDependencyBase, repoRoot: root, candidateIndexTree }), /v105_v10_main_dependency_identity_invalid/)
  const driftedFormalConsumer = structuredClone(dependencyManifest)
  driftedFormalConsumer.releaseBinding.formalConsumerBuildInput = structuredClone(driftedFormalConsumer.releaseBinding.workerBuildInput)
  await assert.rejects(verifyV105V10MainManifestDigests({ manifest, dependencyManifest: driftedFormalConsumer, repoRoot: root, candidateIndexTree }), /v105_v10_main_dependency_contract_invalid/)
  const driftedFormalShape = structuredClone(dependencyManifest)
  driftedFormalShape.releaseBinding.formalConsumerBuildInput.algorithm = 'sha512'
  driftedFormalShape.releaseBinding.formalConsumerBuildInput.excludedPaths = ['proxy/src/server.js']
  await assert.rejects(verifyV105V10MainManifestDigests({ manifest, dependencyManifest: driftedFormalShape, repoRoot: root, candidateIndexTree }), /v105_v10_main_dependency_contract_invalid/)
  const unexpectedMainBindingShape = structuredClone(manifest)
  for (const key of ['implementationTree', 'zeroFinalHeartbeatMigration', 'sameSessionOutboxBatchMigration', 'transportRebindMigration', 'formalConsumerBuildInput', 'workerBuildInput']) {
    unexpectedMainBindingShape.releaseBinding[key].unexpectedShapeField = 'MUTATION'
  }
  await assert.rejects(verifyV105V10MainManifestDigests({ manifest: unexpectedMainBindingShape, dependencyManifest, repoRoot: root, candidateIndexTree }), /v105_v10_main_binding_shape_invalid/)
  const driftedDependencyWorker = structuredClone(dependencyManifest)
  driftedDependencyWorker.releaseBinding.workerBuildInput.excludedPaths = ['cloud-browser-worker/src/index.js']
  await assert.rejects(verifyV105V10MainManifestDigests({ manifest, dependencyManifest: driftedDependencyWorker, repoRoot: root, candidateIndexTree }), /v105_v10_main_dependency_contract_invalid/)
  const driftedDependencyZeroFinal = structuredClone(dependencyManifest)
  driftedDependencyZeroFinal.releaseBinding.zeroFinalHeartbeatMigration.algorithm = 'sha512'
  await assert.rejects(verifyV105V10MainManifestDigests({ manifest, dependencyManifest: driftedDependencyZeroFinal, repoRoot: root, candidateIndexTree }), /v105_v10_main_dependency_contract_invalid/)
  const missingTransportReadback = structuredClone(manifest)
  missingTransportReadback.deploymentOrder = missingTransportReadback.deploymentOrder.filter((step) => step !== 'transport-rebind-idempotency-catalog-acl-readback')
  await assert.rejects(verifyV105V10MainManifestDigests({ manifest: missingTransportReadback, dependencyManifest, repoRoot: root, candidateIndexTree }), /v105_v10_main_deployment_order_duplicate/)

  for (const [mutate, expected] of [
    [(value) => { value.releaseName = 'drifted' }, /v105_v10_main_release_identity_invalid/],
    [(value) => { value.applicationVersion = '1.0.64' }, /v105_v10_main_release_identity_invalid/],
    [(value) => { value.releaseScope.httpParentExternalConsumerIsolation = false }, /v105_v10_main_release_scope_invalid/],
  ]) {
    const drifted = structuredClone(manifest)
    mutate(drifted)
    await assert.rejects(verifyV105V10MainManifestDigests({ manifest: drifted, dependencyManifest, repoRoot: root, candidateIndexTree }), expected)
  }

  for (const [mutate, expected] of [
    [(value) => { value.releaseName = 'drifted' }, /v105_v10_main_dependency_identity_invalid/],
    [(value) => { value.applicationVersion = '1.0.64' }, /v105_v10_main_dependency_identity_invalid/],
    [(value) => { value.releaseScope.mode = 'drifted' }, /v105_v10_main_dependency_scope_invalid/],
    [(value) => { value.behavior.predictionRulesChanged = true }, /v105_v10_main_dependency_behavior_invalid/],
    [(value) => { value.behavior.predictionWeightsChanged = true }, /v105_v10_main_dependency_behavior_invalid/],
    [(value) => { value.behavior.predictionThresholdsChanged = true }, /v105_v10_main_dependency_behavior_invalid/],
    [(value) => { value.behavior.receiverOwnershipChanged = false }, /v105_v10_main_dependency_behavior_invalid/],
  ]) {
    const drifted = structuredClone(dependencyManifest)
    mutate(drifted)
    await assert.rejects(verifyV105V10MainManifestDigests({ manifest, dependencyManifest: drifted, repoRoot: root, candidateIndexTree }), expected)
  }
})

test('V105 Main21 deploys DB and receiver ownership before restarting the unchanged worker', () => {
  assert.deepEqual(manifest.deploymentOrder, [
    'verify-producer-stopped',
    'verify-active-outbox-zero',
    'transport-rebind-idempotency-migration',
    'transport-rebind-idempotency-catalog-acl-readback',
    'deploy-exact-v105-v10-main21-proxy',
    'public-readiness-v105-main21',
    'build-exact-v105-formal-consumer-image',
    'verify-exact-formal-consumer-image-commit-digest',
    'deploy-exact-v105-formal-consumer',
    'verify-external-consumer-ready-self-drain',
    'start-existing-v105-api-worker',
    'verify-worker-queue-cursor-journal-preserved',
    'ten-table-final-ack-v10-prediction-e2e',
    'member-session-frontend-e2e',
  ])
  assert.equal(manifest.releaseScope.captureWorkerChanged, false)
  assert.equal(manifest.releaseScope.httpParentExternalConsumerIsolation, true)
})
