import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { materializeCurrentV105V10MainSuccessorManifest, verifyCurrentV105V10MainReleaseReportContract, verifyManifestDigests, verifyV105V10MainManifestDigests } from '../../scripts/verify-v105-mt-api-release.mjs'

const manifest = JSON.parse(readFileSync(new URL('../../release/v105-v10-main-release-manifest.json', import.meta.url)))
const predecessorManifest = JSON.parse(readFileSync(new URL('../../release/v105-v10-main22-source-fence-release-manifest.json', import.meta.url)))
const successorManifest = JSON.parse(readFileSync(new URL('../../release/v105-v10-main26-formal-prediction-release-manifest.json', import.meta.url)))
const dependencyManifest = materializeCurrentV105V10MainSuccessorManifest(successorManifest, predecessorManifest)
const releaseReport = JSON.parse(readFileSync(new URL('../../release/v105-v10-main-release-report.json', import.meta.url)))
const formalConsumerDockerfile = readFileSync(new URL('../Dockerfile.formal-consumer', import.meta.url), 'utf8')

test('V105 Main26 preserves formal prediction while releasing Parent read-only strategy verification', () => {
  assert.equal(manifest.releaseVersion, 'v105-v10-main.26')
  assert.equal(manifest.formalStrategyVersion, 'v105')
  assert.deepEqual(manifest.releaseScope, {
    predictionMainOnly: false,
    productRuntimeChanged: true,
    databaseMigrationRequired: false,
    proxyChanged: true,
    workerChanged: false,
    captureWorkerChanged: false,
    formalConsumerChanged: true,
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
    sameSessionOutboxBatchLimit: 10,
    atomicOutboxBatchLeaseAck: true,
    httpParentExternalConsumerIsolation: true,
    externalFormalConsumerChanged: true,
    transportRebindMigrationBound: true,
    backendFinalTriggersPredictionBeforeOutboxAck: true,
    predictionIssuanceFailureRetainsExactLease: true,
  })
  assert.equal(manifest.prediction.mainSource, 'v105-shadow-v10-big-road-uncommon-structure-rank-synchronized')
  assert.equal(manifest.prediction.beadPlateUsed, false)
  assert.equal(manifest.prediction.sideOutputs, 'exact-existing-v105')
  assert.match(formalConsumerDockerfile, /ENV CAPTURE_OUTBOX_CONSUMER_ENABLED=true/)
  assert.match(formalConsumerDockerfile, /ENV CAPTURE_OUTBOX_POLL_MS=3000/)
  assert.equal(releaseReport.releaseVersion, manifest.releaseVersion)
  assert.equal(releaseReport.title, 'V105主預測V10穩定版26 後端Final自動發行修復正式發布報告')
  assert.equal(releaseReport.formalStrategyVersion, 'v105')
  assert.equal(releaseReport.applicationVersion, manifest.applicationVersion)
  assert.equal(releaseReport.baseCommit, manifest.baseCommit)
  assert.equal(releaseReport.scope, 'V105與V10預測規則、權重、門檻、Worker、Capture Worker及前端業務行為不變；Main26修正External Formal Consumer在每筆Final後由後端自動發行下一局Prediction，發行失敗保留Exact Outbox Lease重試，不再依賴前台輪詢')
  assert.deepEqual(releaseReport.review, {
    predictionRulesChanged: false,
    predictionWeightsChanged: false,
    predictionThresholdsChanged: false,
    receiverOwnershipChanged: false,
    proxyChanged: true,
    workerChanged: false,
    captureWorkerChanged: false,
    formalConsumerChanged: true,
    externalConsumerOwnsFormalLifecycle: true,
    httpParentStartsPredictionRuntimes: false,
  })
})

test('V105 V10 main release binding covers the exact prediction implementation and required migration', () => {
  assert.match(manifest.releaseBinding.implementationTree.sha256, /^[a-f0-9]{64}$/)
  for (const required of ['cloud-browser-worker/src/snapshot-pusher.js', 'cloud-browser-worker/test/snapshot-pusher.test.js', 'cloud-browser-worker/src/worker-source-runtime.js', 'cloud-browser-worker/test/worker-source-runtime.test.js', 'proxy/src/cloud-capture.js', 'proxy/src/v100-formal-runtime.js', 'proxy/test/v100-formal-runtime.test.js', 'proxy/src/license-admin.js', 'proxy/src/server.js', 'proxy/src/state-store.js', 'proxy/src/supabase-writer.js', 'proxy/test/cloud-capture.test.js', 'proxy/test/capture-outbox-ack.test.js', 'proxy/test/capture-outbox-writer.test.js', 'proxy/test/v105-formal-ingest-backpressure-contract.test.js', 'proxy/test/admin-side-actions.test.js', 'proxy/test/prediction-integrity.test.js', 'proxy/test/prediction-safety.test.js', 'proxy/src/v105-formal-runtime.js', 'proxy/src/v105-v10-main-strategy.js', 'proxy/src/v105-shadow-v10-contract.js', 'proxy/src/v105-shadow-v10-structure.js', 'frontend/src/lib/onlineLicenseClient.ts', 'frontend/src/lib/onlineLicenseClient.test.ts', 'frontend/src/App.tsx', 'frontend/src/App.test.tsx', 'proxy/Dockerfile.formal-consumer', 'proxy/Dockerfile.formal-consumer.dockerignore', 'release/v105-v10-main-release-report.json', 'supabase/migrations/20260823113000_v105_zero_final_heartbeat_outbox_fast_complete.sql', 'supabase/migrations/20260824010000_v105_capture_outbox_same_session_batch.sql', 'supabase/migrations/20260824143000_v105_capture_transport_rebind_idempotency.sql']) {
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
    'cloud-browser-worker/Dockerfile', 'cloud-browser-worker/Dockerfile.dockerignore',
    'cloud-browser-worker/package.json', 'cloud-browser-worker/package-lock.json',
    'cloud-browser-worker/src', 'shared',
  ])
  assert.match(manifest.releaseBinding.workerBuildInput.sha256, /^[a-f0-9]{64}$/)
})

test('V105 V10 main canonical verifier loads the immutable Main26 tree and rejects duplicate or drifted batch authority', async () => {
  const root = new URL('../..', import.meta.url)
  const candidateIndexTree = execFileSync('git', ['rev-parse', 'v105-v10-main.26^{tree}'], { cwd: root, encoding: 'utf8' }).trim()
  const result = await verifyV105V10MainManifestDigests({ manifest, dependencyManifest, repoRoot: root, candidateIndexTree })
  assert.equal(result.mainImplementationTreeSha256, manifest.releaseBinding.implementationTree.sha256)
  const duplicateProxy = structuredClone(manifest)
  duplicateProxy.deploymentOrder.unshift('deploy-verified-proxy-image-by-digest')
  await assert.rejects(verifyV105V10MainManifestDigests({ manifest: duplicateProxy, dependencyManifest, repoRoot: root, candidateIndexTree }), /v105_v10_main_deployment_order_invalid/)
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
  await assert.rejects(verifyV105V10MainManifestDigests({ manifest: unexpectedMainBindingShape, dependencyManifest, repoRoot: root, candidateIndexTree }), /v105_v10_main_build_input_scope_invalid/)
  const unexpectedMainTopLevel = structuredClone(manifest)
  unexpectedMainTopLevel.unexpectedIdentity = 'MUTATION'
  await assert.rejects(verifyV105V10MainManifestDigests({ manifest: unexpectedMainTopLevel, dependencyManifest, repoRoot: root, candidateIndexTree }), /v105_v10_main_manifest_keys_invalid/)
  for (const nested of ['prediction', 'rollbackFromCurrentV106']) {
    const unexpectedNested = structuredClone(manifest)
    unexpectedNested[nested].unexpected = true
    await assert.rejects(verifyV105V10MainManifestDigests({ manifest: unexpectedNested, dependencyManifest, repoRoot: root, candidateIndexTree }), /v105_v10_main_nested_shape_invalid/)
  }
  const unexpectedMainTopLevelBinding = structuredClone(manifest)
  unexpectedMainTopLevelBinding.releaseBinding.attackerControlledBinding = { algorithm: 'sha256' }
  await assert.rejects(verifyV105V10MainManifestDigests({ manifest: unexpectedMainTopLevelBinding, dependencyManifest, repoRoot: root, candidateIndexTree }), /v105_v10_main_binding_keys_invalid/)
  const narrowedFormalBuildScope = structuredClone(dependencyManifest)
  narrowedFormalBuildScope.releaseBinding.formalConsumerBuildInput.excludedPaths = ['proxy/src/server.js']
  await assert.rejects(verifyManifestDigests({ manifest: narrowedFormalBuildScope, repoRoot: root, candidateIndexTree }), /release_build_input_scope_invalid/)
  const driftedDependencyWorker = structuredClone(dependencyManifest)
  driftedDependencyWorker.releaseBinding.workerBuildInput.excludedPaths = ['cloud-browser-worker/src/index.js']
  await assert.rejects(verifyV105V10MainManifestDigests({ manifest, dependencyManifest: driftedDependencyWorker, repoRoot: root, candidateIndexTree }), /v105_v10_main_dependency_contract_invalid/)
  const driftedDependencyZeroFinal = structuredClone(dependencyManifest)
  driftedDependencyZeroFinal.releaseBinding.zeroFinalHeartbeatMigration.algorithm = 'sha512'
  await assert.rejects(verifyV105V10MainManifestDigests({ manifest, dependencyManifest: driftedDependencyZeroFinal, repoRoot: root, candidateIndexTree }), /v105_v10_main_dependency_contract_invalid/)
  const missingTrustedImagesGate = structuredClone(manifest)
  missingTrustedImagesGate.deploymentOrder = missingTrustedImagesGate.deploymentOrder.filter((step) => step !== 'verify-sigstore-three-role-images')
  await assert.rejects(verifyV105V10MainManifestDigests({ manifest: missingTrustedImagesGate, dependencyManifest, repoRoot: root, candidateIndexTree }), /v105_v10_main_deployment_order_invalid/)

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
    [(value) => { value.behavior.receiverOwnershipChanged = true }, /v105_v10_main_dependency_behavior_invalid/],
  ]) {
    const drifted = structuredClone(dependencyManifest)
    mutate(drifted)
    await assert.rejects(verifyV105V10MainManifestDigests({ manifest, dependencyManifest: drifted, repoRoot: root, candidateIndexTree }), expected)
  }
})

test('V105 Main26 release report is exact and cannot self-approve production gates', () => {
  assert.deepEqual(verifyCurrentV105V10MainReleaseReportContract(releaseReport, manifest.releaseVersion), { ok: true })
  const mutations = [
    (value) => { value.status = 'review-pass' },
    (value) => { value.tests.proxyFullSerial = '1015/1016 PASS' },
    (value) => { value.tests.unreviewed = 'PASS' },
    (value) => { value.productionGates.exactCommitReview = true },
    (value) => { delete value.productionGates.tenTables },
    (value) => { value.unexpectedTopLevel = true },
  ]
  for (const mutate of mutations) {
    const drifted = structuredClone(releaseReport)
    mutate(drifted)
    assert.throws(() => verifyCurrentV105V10MainReleaseReportContract(drifted, manifest.releaseVersion), /v105_v10_main_release_report_invalid/)
  }
})

test('V105 Main26 rebuilds three trusted roles and deploys the changed proxy plus Formal Consumer before E2E', () => {
  assert.deepEqual(manifest.deploymentOrder, [
    'verify-active-outbox-zero',
    'verify-sigstore-three-role-images',
    'resolve-release-tags-to-verified-digests',
    'deploy-verified-proxy-image-by-digest',
    'readback-render-proxy-image-digest',
    'public-readiness-v105-main26',
    'verify-active-outbox-zero-before-formal-consumer-cutover',
    'deploy-verified-formal-consumer-image-by-digest',
    'readback-formal-consumer-image-digest',
    'verify-formal-consumer-ready-self-drain',
    'verify-worker-unchanged-queue-cursor-journal-preserved',
    'ten-table-final-ack-v10-prediction-e2e',
    'member-session-frontend-e2e',
  ])
  assert.equal(manifest.releaseScope.proxyChanged, true)
  assert.equal(manifest.releaseScope.workerChanged, false)
  assert.equal(manifest.releaseScope.captureWorkerChanged, false)
  assert.equal(manifest.releaseScope.formalConsumerChanged, true)
  assert.equal(manifest.releaseScope.httpParentExternalConsumerIsolation, true)
})

test('V105 Main26 trusted workflow rebuilds all roles only from the exact frozen tag with GitHub Sigstore provenance', () => {
  const root = new URL('../..', import.meta.url)
  const candidateIndexTree = execFileSync('git', ['rev-parse', 'v105-v10-main.26^{tree}'], { cwd: root, encoding: 'utf8' }).trim()
  const workflow = execFileSync('git', ['show', `${candidateIndexTree}:.github/workflows/trusted-release-images.yml`], { cwd: root, encoding: 'utf8' })
  assert.match(workflow, /tags:\s*\n\s*- v105-v10-main\.26/)
  assert.match(workflow, /if: github\.ref == 'refs\/tags\/v105-v10-main\.26'/)
  assert.match(workflow, /runs-on: ubuntu-latest/)
  assert.match(workflow, /ref: refs\/tags\/v105-v10-main\.26/)
  assert.match(workflow, /test "\$\{GITHUB_REF\}" = "refs\/tags\/v105-v10-main\.26"/)
  assert.match(workflow, /test "\$\(git rev-parse HEAD\)" = "\$\{GITHUB_SHA\}"/)
  for (const role of ['proxy', 'formal-consumer', 'worker']) assert.match(workflow, new RegExp(`role: ${role}`))
  assert.match(workflow, /id-token: write/)
  assert.match(workflow, /actions\/attest-build-provenance@[a-f0-9]{40}/)
  assert.match(workflow, /subject-digest: \$\{\{ steps\.build\.outputs\.digest \}\}/)
  assert.match(workflow, /push-to-registry: true/)
})
