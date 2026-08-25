import crypto from 'node:crypto'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { readdir, readFile, lstat, realpath } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const MAIN21_RELEASE_NAME = 'V105主預測V10穩定版21接收器隔離'
const MAIN21_APPLICATION_VERSION = '1.0.63'
const MAIN21_BASE_COMMIT = '6461574c256bcfe94e0fdb6d79d974690be77a83'
const MAIN21_REPORT_TITLE = 'V105主預測V10穩定版21接收器隔離正式發布報告'
const MAIN21_REPORT_SCOPE = 'V105與V10預測規則、權重、門檻及Formal身份不變；Main21將HTTP Parent限制為被動Tables與狀態更新，Formal Outbox與Shadow lifecycle僅由External Consumer擁有'
const TRUSTED_SIGNER_WORKFLOW = 'x0989285458-lgtm/darven-ai-baccarat-proxy/.github/workflows/trusted-release-images.yml'
const TRUSTED_SOURCE_REF = 'refs/tags/v105-v10-main.21'
const TRUSTED_WORKFLOW_SHA256 = 'f1fa92544af0f8d88fd4d7a782f93331d094d7a053099e276eaa9cab865e3350'
const TRUSTED_READBACK_CAPABILITY = Symbol('trusted-readback-capability')
const MAIN21_SCOPE = Object.freeze({
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
const MAIN21_DEPENDENCY_SCOPE = Object.freeze({
  mode: 'single-session-api-primary',
  canonicalSource: 'api',
  workerEnvironment: { MT_SOURCE_MODE: 'api', MT_CAPTURE_ROLE: 'canonical' },
  browserEnabled: false,
  backupReplayEnabled: false,
  recordContract: 'unverified',
  gapPolicy: 'fail-closed-stop-ack-and-alert',
  deferred: ['second-independent-session-backup', 'record-replay'],
  httpParentExternalConsumerIsolation: true,
  captureWorkerChanged: false,
  frontendChanged: true,
})
const MAIN21_BEHAVIOR = Object.freeze({
  predictionRulesChanged: false,
  predictionWeightsChanged: false,
  predictionThresholdsChanged: false,
  receiverOwnershipChanged: true,
  uiChanged: false,
  v6ToV9Changed: false,
  versionChanged: true,
})
const MAIN21_BINDING_KEYS = Object.freeze([
  'formalConsumerBuildInput', 'implementationTree', 'sameSessionOutboxBatchMigration',
  'transportRebindMigration', 'workerBuildInput', 'zeroFinalHeartbeatMigration',
])
const MAIN21_MANIFEST_KEYS = Object.freeze([
  'applicationVersion', 'baseCommit', 'deploymentOrder', 'formalStrategyVersion', 'gitTag', 'prediction',
  'releaseBinding', 'releaseName', 'releaseScope', 'releaseVersion', 'rollbackFromCurrentV106',
])
const DEPENDENCY_MANIFEST_KEYS = Object.freeze([
  'adminSession', 'applicationVersion', 'applicationVersionChanged', 'baseCommit', 'behavior', 'browserColdBackup',
  'database', 'deploymentOrder', 'formalStrategyVersion', 'gitTag', 'newRoundDelivery', 'proxy', 'readbackGate',
  'releaseBinding', 'releaseName', 'releaseScope', 'releaseVersion', 'rollback', 'shadowHydrationHotfix',
  'shadowV10', 'shadowV9Isolation',
])
const DEPENDENCY_BINDING_KEYS = Object.freeze([
  'attestation', 'captureOutboxHealthMigration', 'formalConsumerBuildInput', 'implementationTree', 'migration',
  'proxyBuildInput', 'rankLedgerRecoveryMigration', 'rankSyncHydrationMigration', 'sameSessionOutboxBatchMigration',
  'shadowHydrationMigration', 'shadowV10DbValidationMigration', 'shadowV10Migration',
  'shadowV6V8RetirementMigration', 'transportRebindMigration', 'workerBuildInput', 'zeroFinalHeartbeatMigration',
])
const ATTESTATION_KEYS = Object.freeze([
  'abortOnMismatch', 'arbitraryReadbackJsonRejected', 'cryptographicProvenanceRequired', 'denySelfHostedRunners',
  'externalFileRequired', 'fixedRegistryAdapter', 'fixedRegistryAdapterRequired', 'imageDigestReadbackRequired',
  'immutableCommitAndAnnotatedTagRequired', 'independentBuildReceiptsRequired', 'phase', 'provenanceProvider',
  'requiredImageRoles', 'signerWorkflow', 'sourceRef', 'trustedRepository',
])
const PROXY_BUILD_PATHS = Object.freeze([
  'proxy/Dockerfile.evidence', 'proxy/Dockerfile.evidence.dockerignore',
  'proxy/package.json', 'proxy/package-lock.json',
  'proxy/deploy/render.yaml', 'proxy/src', 'shared',
])
const FORMAL_CONSUMER_BUILD_PATHS = Object.freeze([
  'proxy/Dockerfile.formal-consumer', 'proxy/Dockerfile.formal-consumer.dockerignore',
  'proxy/package.json', 'proxy/package-lock.json', 'proxy/src', 'shared',
])
const WORKER_BUILD_PATHS = Object.freeze([
  'cloud-browser-worker/Dockerfile', 'cloud-browser-worker/Dockerfile.dockerignore',
  'cloud-browser-worker/package.json', 'cloud-browser-worker/package-lock.json',
  'cloud-browser-worker/src', 'shared',
])

function exactJson(value, expected) {
  if (Array.isArray(expected)) return Array.isArray(value)
    && value.length === expected.length
    && expected.every((item, index) => exactJson(value[index], item))
  if (expected && typeof expected === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const actualKeys = Object.keys(value).sort()
    const expectedKeys = Object.keys(expected).sort()
    return exactJson(actualKeys, expectedKeys)
      && expectedKeys.every((key) => exactJson(value[key], expected[key]))
  }
  return value === expected
}

function hasExactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && exactJson(Object.keys(value).sort(), [...keys].sort())
}

function hasExactBuildScope(spec, paths) {
  return hasExactKeys(spec, ['algorithm', 'paths', 'excludedPaths', 'sha256'])
    && spec.algorithm === 'sha256'
    && exactJson(spec.paths, paths)
    && exactJson(spec.excludedPaths, [])
}

export async function computePathSetDigest(repoRoot, { paths = [], excludedPaths = [] } = {}) {
  const root = normalizeRoot(repoRoot)
  const excluded = excludedPaths.map(normalizeRelative)
  const files = new Set()
  for (const requested of paths.map(normalizeRelative)) await collectFiles(root, requested, excluded, files)
  const ordered = [...files].sort()
  const hash = crypto.createHash('sha256')
  for (const relative of ordered) {
    const bytes = await readFile(path.join(root, ...relative.split('/')))
    hash.update(relative).update('\0').update(String(bytes.length)).update('\0').update(bytes).update('\0')
  }
  return { algorithm: 'sha256', sha256: hash.digest('hex'), files: ordered }
}

export async function computeGitTreePathSetDigest(repoRoot, tree, { paths = [], excludedPaths = [] } = {}) {
  const root = normalizeRoot(repoRoot)
  if (!/^[a-f0-9]{40}$/.test(String(tree ?? ''))) throw new Error('candidate_index_tree_invalid')
  const requested = paths.map(normalizeRelative)
  const excluded = excludedPaths.map(normalizeRelative)
  const output = execFileSync('git', ['ls-tree', '-r', '-z', tree, '--', ...requested], { cwd: root })
  const files = []
  for (const entry of output.toString('utf8').split('\0').filter(Boolean)) {
    const separator = entry.indexOf('\t')
    if (separator < 0) throw new Error('git_tree_entry_invalid')
    const [mode, type, objectId] = entry.slice(0, separator).split(' ')
    const relative = normalizeRelative(entry.slice(separator + 1))
    if (isExcluded(relative, excluded)) continue
    if (mode === '120000') throw new Error(`release_input_symlink_rejected:${relative}`)
    if (type !== 'blob' || !/^[a-f0-9]{40}$/.test(objectId)) throw new Error(`release_input_type_invalid:${relative}`)
    files.push({ relative, objectId })
  }
  for (const item of requested.filter((relative) => !isExcluded(relative, excluded))) {
    if (!files.some(({ relative }) => relative === item || relative.startsWith(`${item}/`))) throw new Error(`release_input_missing:${item}`)
  }
  files.sort((left, right) => left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0)
  const hash = crypto.createHash('sha256')
  for (const { relative, objectId } of files) {
    const bytes = execFileSync('git', ['cat-file', 'blob', objectId], { cwd: root })
    hash.update(relative).update('\0').update(String(bytes.length)).update('\0').update(bytes).update('\0')
  }
  return { algorithm: 'sha256', sha256: hash.digest('hex'), files: files.map(({ relative }) => relative) }
}

export function assertCandidateIndexClean(repoRoot, candidateIndexTree) {
  const root = normalizeRoot(repoRoot)
  if (!/^[a-f0-9]{40}$/.test(String(candidateIndexTree ?? ''))) throw new Error('candidate_index_tree_invalid')
  assertGitQuiet(root, ['diff', '--quiet', '--'], 'working_tree_differs_from_index')
  assertGitQuiet(root, ['diff', '--cached', '--quiet', candidateIndexTree, '--'], 'index_differs_from_candidate_tree')
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root })
  if (untracked.length > 0) throw new Error('untracked_files_outside_candidate_index')
  return { ok: true, candidateIndexTree }
}

export async function assertExternalAttestationPath({ repoRoot, attestationPath, realpathImpl = realpath, pathApi = path } = {}) {
  if (!String(rootValue(repoRoot)).trim() || !String(attestationPath ?? '').trim()) throw new Error('attestation_realpath_unavailable')
  let canonicalRoot
  let canonicalAttestation
  try {
    canonicalRoot = await realpathImpl(pathApi.resolve(rootValue(repoRoot)))
    canonicalAttestation = await realpathImpl(pathApi.resolve(String(attestationPath ?? '')))
  } catch (error) {
    throw new Error('attestation_realpath_unavailable', { cause: error })
  }
  const relative = pathApi.relative(canonicalRoot, canonicalAttestation)
  const isInside = relative === '' || (!relative.startsWith(`..${pathApi.sep}`) && relative !== '..' && !pathApi.isAbsolute(relative))
  if (isInside) throw new Error('attestation_must_be_external')
  return canonicalAttestation
}

export async function verifyManifestDigests({ manifest, repoRoot, candidateIndexTree } = {}) {
  const binding = manifest?.releaseBinding
  if (!binding) throw new Error('release_binding_missing')
  if (!hasExactKeys(manifest, DEPENDENCY_MANIFEST_KEYS)) throw new Error('release_manifest_keys_invalid')
  if (!hasExactKeys(binding, DEPENDENCY_BINDING_KEYS)) throw new Error('release_binding_keys_invalid')
  if (!hasExactKeys(binding.implementationTree, ['algorithm', 'paths', 'excludedPaths', 'sha256'])) throw new Error('release_implementation_shape_invalid')
  if (!hasExactKeys(binding.attestation, ATTESTATION_KEYS)) throw new Error('release_attestation_shape_invalid')
  for (const key of [
    'migration', 'captureOutboxHealthMigration', 'zeroFinalHeartbeatMigration', 'sameSessionOutboxBatchMigration',
    'shadowHydrationMigration', 'shadowV10Migration', 'shadowV10DbValidationMigration',
    'shadowV6V8RetirementMigration', 'rankLedgerRecoveryMigration', 'rankSyncHydrationMigration',
    'transportRebindMigration',
  ]) {
    if (!hasExactKeys(binding[key], ['algorithm', 'path', 'sha256'])) throw new Error(`release_migration_shape_invalid:${key}`)
  }
  if (!hasExactBuildScope(binding.proxyBuildInput, PROXY_BUILD_PATHS)
    || !hasExactBuildScope(binding.formalConsumerBuildInput, FORMAL_CONSUMER_BUILD_PATHS)
    || !hasExactBuildScope(binding.workerBuildInput, WORKER_BUILD_PATHS)) throw new Error('release_build_input_scope_invalid')
  const implementation = await verifyGitTreeDigest(rootValue(repoRoot), candidateIndexTree, binding.implementationTree, 'implementation_tree')
  const migration = await verifyGitTreeDigest(rootValue(repoRoot), candidateIndexTree, { algorithm: binding.migration.algorithm, paths: [binding.migration.path], excludedPaths: [], sha256: binding.migration.sha256 }, 'migration')
  const captureOutboxHealthMigration = await verifyGitTreeDigest(rootValue(repoRoot), candidateIndexTree, {
    algorithm: binding.captureOutboxHealthMigration?.algorithm,
    paths: [binding.captureOutboxHealthMigration?.path],
    excludedPaths: [],
    sha256: binding.captureOutboxHealthMigration?.sha256,
  }, 'capture_outbox_health_migration')
  const zeroFinalHeartbeatMigration = await verifyGitTreeDigest(rootValue(repoRoot), candidateIndexTree, {
    algorithm: binding.zeroFinalHeartbeatMigration?.algorithm,
    paths: [binding.zeroFinalHeartbeatMigration?.path],
    excludedPaths: [],
    sha256: binding.zeroFinalHeartbeatMigration?.sha256,
  }, 'zero_final_heartbeat_migration')
  const sameSessionOutboxBatchMigration = await verifyGitTreeDigest(rootValue(repoRoot), candidateIndexTree, {
    algorithm: binding.sameSessionOutboxBatchMigration?.algorithm,
    paths: [binding.sameSessionOutboxBatchMigration?.path],
    excludedPaths: [],
    sha256: binding.sameSessionOutboxBatchMigration?.sha256,
  }, 'same_session_outbox_batch_migration')
  const transportRebindMigration = await verifyGitTreeDigest(rootValue(repoRoot), candidateIndexTree, {
    algorithm: binding.transportRebindMigration?.algorithm,
    paths: [binding.transportRebindMigration?.path],
    excludedPaths: [],
    sha256: binding.transportRebindMigration?.sha256,
  }, 'transport_rebind_migration')
  const shadowHydrationMigration = await verifyGitTreeDigest(rootValue(repoRoot), candidateIndexTree, {
    algorithm: binding.shadowHydrationMigration?.algorithm,
    paths: [binding.shadowHydrationMigration?.path],
    excludedPaths: [],
    sha256: binding.shadowHydrationMigration?.sha256,
  }, 'shadow_hydration_migration')
  const shadowV10Migration = await verifyGitTreeDigest(rootValue(repoRoot), candidateIndexTree, {
    algorithm: binding.shadowV10Migration?.algorithm,
    paths: [binding.shadowV10Migration?.path],
    excludedPaths: [],
    sha256: binding.shadowV10Migration?.sha256,
  }, 'shadow_v10_migration')
  const shadowV10DbValidationMigration = await verifyGitTreeDigest(rootValue(repoRoot), candidateIndexTree, {
    algorithm: binding.shadowV10DbValidationMigration?.algorithm,
    paths: [binding.shadowV10DbValidationMigration?.path],
    excludedPaths: [],
    sha256: binding.shadowV10DbValidationMigration?.sha256,
  }, 'shadow_v10_db_validation_migration')
  const rankLedgerRecoveryMigration = await verifyGitTreeDigest(rootValue(repoRoot), candidateIndexTree, {
    algorithm: binding.rankLedgerRecoveryMigration?.algorithm,
    paths: [binding.rankLedgerRecoveryMigration?.path],
    excludedPaths: [],
    sha256: binding.rankLedgerRecoveryMigration?.sha256,
  }, 'rank_ledger_recovery_migration')
  const rankSyncHydrationMigration = await verifyGitTreeDigest(rootValue(repoRoot), candidateIndexTree, {
    algorithm: binding.rankSyncHydrationMigration?.algorithm,
    paths: [binding.rankSyncHydrationMigration?.path],
    excludedPaths: [],
    sha256: binding.rankSyncHydrationMigration?.sha256,
  }, 'rank_sync_hydration_migration')
  const shadowV6V8RetirementMigration = await verifyGitTreeDigest(rootValue(repoRoot), candidateIndexTree, {
    algorithm: binding.shadowV6V8RetirementMigration?.algorithm,
    paths: [binding.shadowV6V8RetirementMigration?.path],
    excludedPaths: [],
    sha256: binding.shadowV6V8RetirementMigration?.sha256,
  }, 'shadow_v6_v8_retirement_migration')
  const proxy = await verifyGitTreeDigest(rootValue(repoRoot), candidateIndexTree, binding.proxyBuildInput, 'proxy_build_input')
  const formalConsumer = await verifyGitTreeDigest(rootValue(repoRoot), candidateIndexTree, binding.formalConsumerBuildInput, 'formal_consumer_build_input')
  const worker = await verifyGitTreeDigest(rootValue(repoRoot), candidateIndexTree, binding.workerBuildInput, 'worker_build_input')
  const exclusions = binding.implementationTree.excludedPaths?.map(normalizeRelative) ?? []
  if (!exclusions.includes('release/attestations')) throw new Error('implementation_tree_self_reference_not_excluded:release/attestations')
  const manifestExclusions = exclusions.filter((entry) => /source-fence-release-manifest\.json$/.test(entry))
  if (manifestExclusions.length !== 1) throw new Error('implementation_tree_source_manifest_exclusion_invalid')
  const captureOutboxHealth = manifest?.database?.captureOutboxHealthMigration
  const deployment = Array.isArray(manifest?.deploymentOrder) ? manifest.deploymentOrder : []
  const batchStep = 'same-session-outbox-batch-migration'
  const batchReadbackStep = 'same-session-outbox-batch-catalog-acl-readback'
  if (deployment.filter((step) => step === batchStep).length !== 1
    || deployment.filter((step) => step === batchReadbackStep).length !== 1
    || deployment.filter((step) => step === 'proxy-compatible').length !== 1) {
    throw new Error('same_session_outbox_batch_deployment_order_duplicate')
  }
  const captureOutboxHealthIndex = deployment.indexOf('capture-outbox-health-active-only-migration')
  const proxyIndex = deployment.indexOf('proxy-compatible')
  if (captureOutboxHealth?.path !== binding.captureOutboxHealthMigration?.path
    || captureOutboxHealth?.rpc !== 'public.get_v105_capture_outbox_health()'
    || captureOutboxHealth?.completedHistoryExcluded !== true
    || captureOutboxHealth?.serviceRoleOnly !== true
    || captureOutboxHealthIndex < 0 || proxyIndex <= captureOutboxHealthIndex
    || !binding.implementationTree.paths?.includes(captureOutboxHealth.path)) {
    throw new Error('capture_outbox_health_migration_contract_invalid')
  }
  const batchMigration = manifest?.database?.sameSessionOutboxBatchMigration
  const batchIndex = deployment.indexOf(batchStep)
  const batchReadbackIndex = deployment.indexOf(batchReadbackStep)
  if (batchMigration?.path !== binding.sameSessionOutboxBatchMigration?.path
    || batchMigration?.claimRpc !== 'public.claim_v105_capture_settlement_outbox_batch(integer)'
    || batchMigration?.completeRpc !== 'public.complete_v105_capture_settlement_outbox_batch(jsonb)'
    || batchMigration?.failRpc !== 'public.fail_v105_capture_settlement_outbox_batch(jsonb,text)'
    || batchMigration?.batchLimit !== 10
    || batchMigration?.sameSessionOrderedPrefix !== true
    || batchMigration?.atomicLeaseMutation !== true
    || batchMigration?.serviceRoleOnly !== true
    || batchMigration?.catalogAclReadbackRequired !== true
    || batchIndex < 0 || batchReadbackIndex <= batchIndex || proxyIndex <= batchReadbackIndex
    || !binding.implementationTree.paths?.includes(batchMigration.path)) {
    throw new Error('same_session_outbox_batch_migration_contract_invalid')
  }
  const transportMigration = manifest?.database?.transportRebindMigration
  const transportIndex = deployment.indexOf('transport-rebind-idempotency-migration')
  const transportReadbackIndex = deployment.indexOf('transport-rebind-idempotency-catalog-acl-readback')
  if (transportMigration?.path !== binding.transportRebindMigration?.path
    || transportMigration?.serviceRoleOnly !== true
    || transportMigration?.catalogAclReadbackRequired !== true
    || transportMigration?.transportMetadataConflictIgnoredOnlyForApprovedRebind !== true
    || transportIndex < 0 || transportReadbackIndex <= transportIndex || proxyIndex <= transportReadbackIndex
    || !binding.implementationTree.paths?.includes(transportMigration.path)) {
    throw new Error('transport_rebind_migration_contract_invalid')
  }
  verifyTrustedEvidenceContract(binding)
  verifyV9ShadowRollbackContract(manifest, binding)
  verifyV10ShadowRollbackContract(manifest, binding)
  verifyRankLedgerRecoveryContract(manifest, binding)
  verifyRankSyncHydrationContract(manifest, binding)
  verifyV6V8RetirementContract(manifest, binding)
  return {
    ok: true,
    implementationTreeSha256: implementation.sha256,
    migrationSha256: migration.sha256,
    captureOutboxHealthMigrationSha256: captureOutboxHealthMigration.sha256,
    zeroFinalHeartbeatMigrationSha256: zeroFinalHeartbeatMigration.sha256,
    sameSessionOutboxBatchMigrationSha256: sameSessionOutboxBatchMigration.sha256,
    transportRebindMigrationSha256: transportRebindMigration.sha256,
    shadowHydrationMigrationSha256: shadowHydrationMigration.sha256,
    shadowV10MigrationSha256: shadowV10Migration.sha256,
    shadowV10DbValidationMigrationSha256: shadowV10DbValidationMigration.sha256,
    rankLedgerRecoveryMigrationSha256: rankLedgerRecoveryMigration.sha256,
    rankSyncHydrationMigrationSha256: rankSyncHydrationMigration.sha256,
    shadowV6V8RetirementMigrationSha256: shadowV6V8RetirementMigration.sha256,
    proxyBuildInputSha256: proxy.sha256,
    formalConsumerBuildInputSha256: formalConsumer.sha256,
    workerBuildInputSha256: worker.sha256,
  }
}

export function verifyMain21ReleaseReportContract(releaseReport, releaseVersion = 'v105-v10-main.21') {
  if (!exactJson(releaseReport, {
    title: MAIN21_REPORT_TITLE,
    releaseVersion,
    formalStrategyVersion: 'v105',
    applicationVersion: MAIN21_APPLICATION_VERSION,
    baseCommit: MAIN21_BASE_COMMIT,
    status: 'candidate-full-tests-pass-exact-review-pending',
    scope: MAIN21_REPORT_SCOPE,
    tests: {
      parentExternalConsumerIsolation: '4/4 PASS', dependencyBinding: '8/8 PASS', mainBinding: '5/5 PASS',
      proxyFullSerial: '1006/1006 PASS', frontendFull: '159/159 PASS', frontendBuild: 'PASS',
    },
    review: {
      predictionRulesChanged: false, predictionWeightsChanged: false, predictionThresholdsChanged: false,
      receiverOwnershipChanged: true, externalConsumerOwnsFormalLifecycle: true, httpParentStartsPredictionRuntimes: false,
    },
    productionGates: {
      exactCommitReview: false, soleActiveV105: false, tenTables: false, newFinal: false,
      ackAdvanced: false, v10MainIssuance: false, frontendAuthenticatedE2E: false,
    },
  })) throw new Error('v105_v10_main_release_report_invalid')
  return { ok: true }
}

export async function verifyV105V10MainManifestDigests({ manifest, dependencyManifest, repoRoot, candidateIndexTree } = {}) {
  if (!hasExactKeys(manifest, MAIN21_MANIFEST_KEYS)) throw new Error('v105_v10_main_manifest_keys_invalid')
  const binding = manifest?.releaseBinding
  if (!binding) throw new Error('v105_v10_main_release_binding_missing')
  if (!hasExactKeys(binding, MAIN21_BINDING_KEYS)) throw new Error('v105_v10_main_binding_keys_invalid')
  if (!hasExactBuildScope(binding.formalConsumerBuildInput, FORMAL_CONSUMER_BUILD_PATHS)
    || !hasExactBuildScope(binding.workerBuildInput, WORKER_BUILD_PATHS)
    || !exactJson(binding.implementationTree?.excludedPaths, [])) throw new Error('v105_v10_main_build_input_scope_invalid')
  for (const spec of [binding.implementationTree, binding.formalConsumerBuildInput, binding.workerBuildInput]) {
    if (!hasExactKeys(spec, ['algorithm', 'paths', 'excludedPaths', 'sha256'])) throw new Error('v105_v10_main_binding_shape_invalid')
  }
  for (const spec of [binding.zeroFinalHeartbeatMigration, binding.sameSessionOutboxBatchMigration, binding.transportRebindMigration]) {
    if (!hasExactKeys(spec, ['algorithm', 'path', 'sha256'])) throw new Error('v105_v10_main_binding_shape_invalid')
  }
  if (manifest?.releaseVersion !== manifest?.gitTag
    || manifest?.formalStrategyVersion !== 'v105'
    || manifest?.releaseName !== MAIN21_RELEASE_NAME
    || manifest?.applicationVersion !== MAIN21_APPLICATION_VERSION
    || manifest?.baseCommit !== MAIN21_BASE_COMMIT) throw new Error('v105_v10_main_release_identity_invalid')
  if (!exactJson(manifest?.releaseScope, MAIN21_SCOPE)) throw new Error('v105_v10_main_release_scope_invalid')
  if (dependencyManifest?.releaseVersion !== manifest.releaseVersion
    || dependencyManifest?.baseCommit !== manifest.baseCommit
    || dependencyManifest?.gitTag !== manifest.gitTag
    || dependencyManifest?.formalStrategyVersion !== 'v105'
    || dependencyManifest?.releaseName !== MAIN21_RELEASE_NAME
    || dependencyManifest?.applicationVersion !== MAIN21_APPLICATION_VERSION
    || dependencyManifest?.applicationVersionChanged !== true) throw new Error('v105_v10_main_dependency_identity_invalid')
  if (!exactJson(dependencyManifest?.releaseScope, MAIN21_DEPENDENCY_SCOPE)) throw new Error('v105_v10_main_dependency_scope_invalid')
  if (!exactJson(dependencyManifest?.behavior, MAIN21_BEHAVIOR)) throw new Error('v105_v10_main_dependency_behavior_invalid')
  let releaseReport
  try {
    releaseReport = JSON.parse(execFileSync('git', ['show', `${candidateIndexTree}:release/v105-v10-main-release-report.json`], { cwd: rootValue(repoRoot), encoding: 'utf8' }))
  } catch (error) {
    throw new Error('v105_v10_main_release_report_invalid', { cause: error })
  }
  verifyMain21ReleaseReportContract(releaseReport, manifest.releaseVersion)
  let renderConfig
  let formalConsumerDockerfile
  let trustedWorkflow
  try {
    renderConfig = execFileSync('git', ['show', `${candidateIndexTree}:proxy/deploy/render.yaml`], { cwd: rootValue(repoRoot), encoding: 'utf8' })
    formalConsumerDockerfile = execFileSync('git', ['show', `${candidateIndexTree}:proxy/Dockerfile.formal-consumer`], { cwd: rootValue(repoRoot), encoding: 'utf8' })
    trustedWorkflow = execFileSync('git', ['show', `${candidateIndexTree}:.github/workflows/trusted-release-images.yml`], { cwd: rootValue(repoRoot) })
  } catch (error) {
    throw new Error('v105_v10_main_deployment_role_invalid', { cause: error })
  }
  if (!/CAPTURE_OUTBOX_CONSUMER_ENABLED[\s\S]*?value:\s*["']false["']/.test(renderConfig)
    || !/ENV CAPTURE_OUTBOX_CONSUMER_ENABLED=true/.test(formalConsumerDockerfile)
    || !/ENV CAPTURE_OUTBOX_POLL_MS=3000/.test(formalConsumerDockerfile)) throw new Error('v105_v10_main_deployment_role_invalid')
  if (crypto.createHash('sha256').update(trustedWorkflow).digest('hex') !== TRUSTED_WORKFLOW_SHA256) {
    throw new Error('v105_v10_main_trusted_workflow_invalid')
  }
  const implementation = await verifyGitTreeDigest(rootValue(repoRoot), candidateIndexTree, binding.implementationTree, 'v105_v10_main_implementation_tree')
  const zeroFinalHeartbeatMigration = await verifyGitTreeDigest(rootValue(repoRoot), candidateIndexTree, { algorithm: binding.zeroFinalHeartbeatMigration?.algorithm, paths: [binding.zeroFinalHeartbeatMigration?.path], excludedPaths: [], sha256: binding.zeroFinalHeartbeatMigration?.sha256 }, 'v105_v10_main_zero_final_heartbeat_migration')
  const sameSessionOutboxBatchMigration = await verifyGitTreeDigest(rootValue(repoRoot), candidateIndexTree, { algorithm: binding.sameSessionOutboxBatchMigration?.algorithm, paths: [binding.sameSessionOutboxBatchMigration?.path], excludedPaths: [], sha256: binding.sameSessionOutboxBatchMigration?.sha256 }, 'v105_v10_main_same_session_outbox_batch_migration')
  const transportRebindMigration = await verifyGitTreeDigest(rootValue(repoRoot), candidateIndexTree, { algorithm: binding.transportRebindMigration?.algorithm, paths: [binding.transportRebindMigration?.path], excludedPaths: [], sha256: binding.transportRebindMigration?.sha256 }, 'v105_v10_main_transport_rebind_migration')
  const formalConsumer = await verifyGitTreeDigest(rootValue(repoRoot), candidateIndexTree, binding.formalConsumerBuildInput, 'v105_v10_main_formal_consumer_build_input')
  const worker = await verifyGitTreeDigest(rootValue(repoRoot), candidateIndexTree, binding.workerBuildInput, 'v105_v10_main_worker_build_input')
  const deployment = Array.isArray(manifest?.deploymentOrder) ? manifest.deploymentOrder : []
  const requiredUnique = ['verify-producer-stopped', 'verify-active-outbox-zero', 'transport-rebind-idempotency-migration', 'transport-rebind-idempotency-catalog-acl-readback', 'deploy-exact-v105-v10-main21-proxy', 'public-readiness-v105-main21', 'build-exact-v105-formal-consumer-image', 'verify-exact-formal-consumer-image-commit-digest', 'deploy-exact-v105-formal-consumer', 'verify-external-consumer-ready-self-drain', 'start-existing-v105-api-worker']
  if (requiredUnique.some((step) => deployment.filter((entry) => entry === step).length !== 1)) throw new Error('v105_v10_main_deployment_order_duplicate')
  const ordered = requiredUnique.map((step) => deployment.indexOf(step))
  if (!ordered.every((value, index) => index === 0 || value > ordered[index - 1])) throw new Error('v105_v10_main_deployment_order_invalid')
  const requiredImplementationPaths = [binding.sameSessionOutboxBatchMigration?.path, binding.transportRebindMigration?.path, '.github/workflows/trusted-release-images.yml', 'proxy/Dockerfile.evidence', 'proxy/Dockerfile.evidence.dockerignore', 'cloud-browser-worker/Dockerfile.dockerignore', 'proxy/Dockerfile.formal-consumer', 'proxy/Dockerfile.formal-consumer.dockerignore', 'proxy/deploy/render.yaml', 'proxy/src/server.js', 'proxy/src/supabase-writer.js', 'proxy/test/capture-outbox-ack.test.js', 'proxy/test/capture-outbox-writer.test.js', 'proxy/test/deploy-config.test.js', 'scripts/verify-v105-mt-api-release.mjs', 'release/v105-v10-main21-source-fence-release-manifest.json', 'release/v105-v10-main-release-report.json']
  if (requiredImplementationPaths.some((required) => !binding.implementationTree.paths?.includes(required))) throw new Error('v105_v10_main_implementation_contract_invalid')
  const dependencyBinding = dependencyManifest?.releaseBinding?.sameSessionOutboxBatchMigration
  const dependencyDatabase = dependencyManifest?.database?.sameSessionOutboxBatchMigration
  const dependencyTransportBinding = dependencyManifest?.releaseBinding?.transportRebindMigration
  const dependencyTransportDatabase = dependencyManifest?.database?.transportRebindMigration
  const dependencyFormalConsumer = dependencyManifest?.releaseBinding?.formalConsumerBuildInput
  const dependencyWorker = dependencyManifest?.releaseBinding?.workerBuildInput
  const dependencyZeroFinal = dependencyManifest?.releaseBinding?.zeroFinalHeartbeatMigration
  if (!exactJson(dependencyBinding, binding.sameSessionOutboxBatchMigration)
    || dependencyDatabase?.path !== binding.sameSessionOutboxBatchMigration?.path
    || dependencyManifest?.deploymentOrder?.filter((step) => step === 'same-session-outbox-batch-migration').length !== 1
    || dependencyManifest?.deploymentOrder?.filter((step) => step === 'same-session-outbox-batch-catalog-acl-readback').length !== 1
    || dependencyManifest?.deploymentOrder?.filter((step) => step === 'proxy-compatible').length !== 1
    || !exactJson(dependencyTransportBinding, binding.transportRebindMigration)
    || dependencyTransportDatabase?.path !== binding.transportRebindMigration?.path
    || !exactJson(dependencyFormalConsumer, binding.formalConsumerBuildInput)
    || !exactJson(dependencyWorker, binding.workerBuildInput)
    || !exactJson(dependencyZeroFinal, binding.zeroFinalHeartbeatMigration)
    || dependencyManifest?.deploymentOrder?.filter((step) => step === 'transport-rebind-idempotency-migration').length !== 1
    || dependencyManifest?.deploymentOrder?.filter((step) => step === 'transport-rebind-idempotency-catalog-acl-readback').length !== 1) throw new Error('v105_v10_main_dependency_contract_invalid')
  return { ok: true, mainImplementationTreeSha256: implementation.sha256, mainZeroFinalHeartbeatMigrationSha256: zeroFinalHeartbeatMigration.sha256, mainSameSessionOutboxBatchMigrationSha256: sameSessionOutboxBatchMigration.sha256, mainTransportRebindMigrationSha256: transportRebindMigration.sha256, mainFormalConsumerBuildInputSha256: formalConsumer.sha256, mainWorkerBuildInputSha256: worker.sha256 }
}

export function verifyV9ShadowRollbackContract(manifest = {}, binding = manifest?.releaseBinding ?? {}) {
  const shadowMigration = manifest?.database?.shadowHydrationMigration
  const deployment = manifest?.deploymentOrder
  const rollback = manifest?.rollback
  const order = Array.isArray(rollback?.order) ? rollback.order : []
  const disableIndex = order.findIndex((step) => step?.id === 'disable-v9-shadow-before-proxy-rollback')
  const proxyIndex = order.findIndex((step) => step?.id === 'rollback-proxy-compatible')
  const disable = order[disableIndex]
  if (!Array.isArray(deployment)
    || deployment[0] !== 'v9-shadow-hydration-migration'
    || deployment[1] !== 'v9-shadow-hydration-catalog-acl-readback'
    || shadowMigration?.path !== binding?.shadowHydrationMigration?.path
    || shadowMigration?.rpc !== 'public.get_v105_shadow_v9_compact_history(integer)'
    || shadowMigration?.serviceRoleOnly !== true
    || shadowMigration?.catalogAclReadbackRequired !== true
    || disableIndex < 0 || proxyIndex < 0 || disableIndex >= proxyIndex
    || disable?.setEnvironment !== 'V105_SHADOW_V9_ENABLED=false'
    || disable?.requireEnvironmentReadback !== 'false'
    || disable?.preserveShadowEvidence !== true
    || disable?.abortBeforeProxyRollbackOnFailure !== true
    || rollback?.preserveShadowEvidence !== true
    || rollback?.requireV9ShadowDisabledBeforeProxyRollback !== true
    || !Array.isArray(rollback?.abortGates)
    || !rollback.abortGates.includes('v9-shadow-disable-readback-failed')) {
    throw new Error('v9_shadow_rollback_contract_invalid')
  }
  return { ok: true }
}

export function verifyV10ShadowRollbackContract(manifest = {}, binding = manifest?.releaseBinding ?? {}) {
  const migration = manifest?.database?.shadowV10Migration
  const dbValidationMigration = manifest?.database?.shadowV10DbValidationMigration
  const deployment = Array.isArray(manifest?.deploymentOrder) ? manifest.deploymentOrder : []
  const order = Array.isArray(manifest?.rollback?.order) ? manifest.rollback.order : []
  const migrationIndex = deployment.indexOf('v10-shadow-migration')
  const readbackIndex = deployment.indexOf('v10-shadow-catalog-acl-readback')
  const validationIndex = deployment.indexOf('v10-shadow-db-validation-migration')
  const validationReadbackIndex = deployment.indexOf('v10-shadow-db-validation-catalog-acl-readback')
  const proxyIndex = deployment.indexOf('proxy-compatible')
  const disableIndex = order.findIndex((step) => step?.id === 'disable-v10-shadow-before-proxy-rollback')
  const rollbackProxyIndex = order.findIndex((step) => step?.id === 'rollback-proxy-compatible')
  const disable = order[disableIndex]
  if (migration?.path !== binding?.shadowV10Migration?.path
    || dbValidationMigration?.path !== binding?.shadowV10DbValidationMigration?.path
    || migration?.serviceRoleOnly !== true || migration?.catalogAclReadbackRequired !== true
    || dbValidationMigration?.serviceRoleOnly !== true || dbValidationMigration?.catalogAclReadbackRequired !== true
    || migrationIndex < 0 || readbackIndex !== migrationIndex + 1
    || validationIndex !== readbackIndex + 1 || validationReadbackIndex !== validationIndex + 1
    || proxyIndex <= validationReadbackIndex
    || disableIndex < 0 || rollbackProxyIndex <= disableIndex
    || disable?.setEnvironment !== 'V105_SHADOW_V10_ENABLED=false'
    || disable?.requireEnvironmentReadback !== 'false'
    || disable?.preserveShadowEvidence !== true
    || disable?.abortBeforeProxyRollbackOnFailure !== true
    || manifest?.rollback?.preserveShadowEvidence !== true
    || manifest?.rollback?.requireV10ShadowDisabledBeforeProxyRollback !== true
    || !manifest?.rollback?.abortGates?.includes('v10-shadow-disable-readback-failed')) {
    throw new Error('v10_shadow_rollback_contract_invalid')
  }
  return { ok: true }
}

export function verifyRankLedgerRecoveryContract(manifest = {}, binding = manifest?.releaseBinding ?? {}) {
  const migration = manifest?.database?.rankLedgerRecoveryMigration
  const deployment = Array.isArray(manifest?.deploymentOrder) ? manifest.deploymentOrder : []
  const migrationIndex = deployment.indexOf('v100-rank-ledger-recovery-migration')
  const readbackIndex = deployment.indexOf('v100-rank-ledger-recovery-catalog-acl-readback')
  const validationReadbackIndex = deployment.indexOf('v10-shadow-db-validation-catalog-acl-readback')
  const proxyIndex = deployment.indexOf('proxy-compatible')
  if (migration?.path !== binding?.rankLedgerRecoveryMigration?.path
    || migration?.rpc !== 'public.rebuild_v100_rank_ledger_from_cloud_rounds(text,text,text)'
    || migration?.serviceRoleOnly !== true || migration?.catalogAclReadbackRequired !== true
    || migrationIndex !== validationReadbackIndex + 1 || readbackIndex !== migrationIndex + 1
    || proxyIndex <= readbackIndex
    || !binding.implementationTree.paths?.includes(migration.path)) {
    throw new Error('rank_ledger_recovery_contract_invalid')
  }
  return { ok: true }
}

export function verifyRankSyncHydrationContract(manifest = {}, binding = manifest?.releaseBinding ?? {}) {
  const migration = manifest?.database?.rankSyncHydrationMigration
  const deployment = Array.isArray(manifest?.deploymentOrder) ? manifest.deploymentOrder : []
  const migrationIndex = deployment.indexOf('v10-rank-sync-hydration-migration')
  const readbackIndex = deployment.indexOf('v10-rank-sync-hydration-catalog-acl-readback')
  const proxyIndex = deployment.indexOf('proxy-compatible')
  if (migration?.path !== binding?.rankSyncHydrationMigration?.path
    || migration?.rpc !== 'public.get_v105_shadow_v10_rank_sync_compact_history(integer)'
    || migration?.serviceRoleOnly !== true || migration?.catalogAclReadbackRequired !== true
    || migration?.nodeDateMillisecondOrdering !== true
    || migrationIndex < 0 || readbackIndex !== migrationIndex + 1 || proxyIndex <= readbackIndex
    || !binding.implementationTree.paths?.includes(migration.path)) {
    throw new Error('rank_sync_hydration_contract_invalid')
  }
  return { ok: true }
}

export function verifyV6V8RetirementContract(manifest = {}, binding = manifest?.releaseBinding ?? {}) {
  const migration = manifest?.database?.shadowV6V8RetirementMigration
  const deployment = Array.isArray(manifest?.deploymentOrder) ? manifest.deploymentOrder : []
  const migrationIndex = deployment.indexOf('v6-v8-retirement-migration')
  const readbackIndex = deployment.indexOf('v6-v8-retirement-catalog-acl-readback')
  const v10ReadbackIndex = deployment.indexOf('v10-shadow-catalog-acl-readback')
  const proxyIndex = deployment.indexOf('proxy-compatible')
  if (migration?.path !== binding?.shadowV6V8RetirementMigration?.path
    || migration?.dropsOnlyRetiredV6V8Objects !== true
    || migration?.preservesV9V10AndFormalV105 !== true
    || migration?.catalogAclReadbackRequired !== true
    || migrationIndex <= v10ReadbackIndex
    || readbackIndex !== migrationIndex + 1
    || proxyIndex <= readbackIndex) {
    throw new Error('shadow_v6_v8_retirement_contract_invalid')
  }
  return { ok: true }
}

export function verifyTrustedEvidenceContract(binding = {}) {
  const attestation = binding.attestation
  const adapter = 'scripts/trusted-registry-readback-adapter.mjs'
  const requiredImageRoles = ['proxy', 'formal-consumer', 'worker']
  if (attestation?.externalFileRequired !== true
    || attestation?.immutableCommitAndAnnotatedTagRequired !== true
    || attestation?.imageDigestReadbackRequired !== true
    || attestation?.phase !== 'post-build-pre-cutover'
    || attestation?.independentBuildReceiptsRequired !== true
    || attestation?.fixedRegistryAdapterRequired !== true
    || attestation?.fixedRegistryAdapter !== adapter
    || !exactJson(attestation?.requiredImageRoles, requiredImageRoles)
    || attestation?.arbitraryReadbackJsonRejected !== true
    || attestation?.cryptographicProvenanceRequired !== true
    || attestation?.provenanceProvider !== 'github-sigstore-attestation'
    || attestation?.trustedRepository !== 'x0989285458-lgtm/darven-ai-baccarat-proxy'
    || attestation?.signerWorkflow !== TRUSTED_SIGNER_WORKFLOW
    || attestation?.sourceRef !== TRUSTED_SOURCE_REF
    || attestation?.denySelfHostedRunners !== true
    || attestation?.abortOnMismatch !== true
    || !Array.isArray(binding.implementationTree?.paths)
    || !binding.implementationTree.paths.includes(adapter)
    || !binding.implementationTree.paths.includes('.github/workflows/trusted-release-images.yml')) throw new Error('trusted_image_evidence_contract_incomplete')
  return { ok: true, phase: attestation.phase, adapter }
}

export function verifyExternalReleaseAttestation(attestation = {}, expected = {}) {
  for (const [field, value] of [['commit', attestation.commit], ['tree', attestation.tree], ['tagObject', attestation.tagObject]]) {
    if (!/^[a-f0-9]{40}$/.test(String(value ?? ''))) throw new Error(`attestation_${field}_invalid`)
  }
  if (!String(attestation.tag ?? '').trim()) throw new Error('attestation_tag_invalid')
  if (!/^[a-f0-9]{40}$/.test(String(expected.commit ?? '')) || attestation.commit !== expected.commit) throw new Error('attestation_commit_mismatch')
  if (!String(expected.gitTag ?? '').trim() || attestation.tag !== expected.gitTag) throw new Error('attestation_tag_mismatch')
  if (!/^[a-f0-9]{40}$/.test(String(expected.candidateIndexTree ?? ''))
    || attestation.tree !== expected.candidateIndexTree) throw new Error('attestation_tree_mismatch')
  const digestFields = ['implementationTreeSha256', 'migrationSha256', 'captureOutboxHealthMigrationSha256', 'zeroFinalHeartbeatMigrationSha256', 'sameSessionOutboxBatchMigrationSha256', 'transportRebindMigrationSha256', 'shadowHydrationMigrationSha256', 'shadowV10MigrationSha256', 'shadowV10DbValidationMigrationSha256', 'rankLedgerRecoveryMigrationSha256', 'rankSyncHydrationMigrationSha256', 'shadowV6V8RetirementMigrationSha256', 'proxyBuildInputSha256', 'formalConsumerBuildInputSha256', 'workerBuildInputSha256']
  for (const field of digestFields) {
    if (!/^[a-f0-9]{64}$/.test(String(attestation[field] ?? '')) || attestation[field] !== expected[field]) {
      throw new Error(`attestation_${field}_mismatch`)
    }
  }
  if (expected.commitTree != null || expected.resolvedTagObject != null || expected.tagObjectType != null || expected.tagCommit != null) {
    if (expected.commitTree !== expected.candidateIndexTree || attestation.tree !== expected.commitTree
      || expected.tagObjectType !== 'tag' || expected.tagCommit !== attestation.commit
      || expected.resolvedTagObject !== attestation.tagObject) throw new Error('immutable_git_attestation_readback_mismatch')
  }
  return { ok: true }
}

function trustedImageRepository(role) {
  const repositories = {
    proxy: 'ghcr.io/x0989285458-lgtm/darven-ai-baccarat-proxy',
    'formal-consumer': 'ghcr.io/x0989285458-lgtm/darven-ai-baccarat-formal-consumer',
    worker: 'ghcr.io/x0989285458-lgtm/darven-ai-baccarat-worker',
  }
  return repositories[role] ?? ''
}

export async function verifyTrustedImageEvidence({ buildReceipts, expected = {}, trustedReadback } = {}) {
  if (!buildReceipts || !Array.isArray(buildReceipts.receipts)) throw new Error('trusted_build_receipts_required')
  if (typeof trustedReadback !== 'function') throw new Error('trusted_registry_readback_required')
  assertNoSecretMaterial(buildReceipts, 'trusted_build_receipt_secret_rejected')
  const roles = ['proxy', 'formal-consumer', 'worker']
  const receipts = new Map()
  for (const role of roles) {
    const matches = buildReceipts.receipts.filter((receipt) => receipt?.role === role)
    if (matches.length !== 1) throw new Error(`trusted_build_receipt_role_invalid:${role}`)
    const receipt = matches[0]
    if (!isEvidenceId(receipt.receiptId) || !isEvidenceId(receipt.provenance)) throw new Error(`trusted_build_receipt_identity_invalid:${role}`)
    if (receipt.commit !== expected.commit) throw new Error(`trusted_build_receipt_commit_mismatch:${role}`)
    if (receipt.tree !== expected.tree) throw new Error(`trusted_build_receipt_tree_mismatch:${role}`)
    const expectedInput = {
      proxy: expected.proxyBuildInputSha256,
      'formal-consumer': expected.formalConsumerBuildInputSha256,
      worker: expected.workerBuildInputSha256,
    }[role]
    if (!/^[a-f0-9]{64}$/.test(String(receipt.buildInputSha256 ?? '')) || receipt.buildInputSha256 !== expectedInput) {
      throw new Error(`trusted_build_receipt_input_mismatch:${role}`)
    }
    const expectedImageRef = `${trustedImageRepository(role)}:${expected.commit}`
    if (!isRegistryImageRef(receipt.imageRef) || receipt.imageRef !== expectedImageRef) throw new Error(`trusted_build_receipt_image_ref_invalid:${role}`)
    if (!isImageDigest(receipt.imageDigest)) throw new Error(`trusted_build_receipt_image_digest_invalid:${role}`)
    receipts.set(role, receipt)
  }
  if (new Set([...receipts.values()].map((receipt) => receipt.receiptId)).size !== roles.length) {
    throw new Error('trusted_build_receipt_id_not_unique')
  }

  const images = {}
  const registryReceiptIds = new Set()
  for (const role of roles) {
    const build = receipts.get(role)
    const readback = await trustedReadback({ role, imageRef: build.imageRef })
    assertNoSecretMaterial(readback, 'trusted_registry_readback_secret_rejected')
    if (!readback || readback[TRUSTED_READBACK_CAPABILITY] !== true
      || readback.role !== role || !isEvidenceId(readback.receiptId)
      || readback.provenance !== 'github-sigstore-attestation'
      || readback.sourceDigest !== expected.commit
      || readback.sourceRef !== expected.sourceRef
      || readback.signerWorkflow !== TRUSTED_SIGNER_WORKFLOW
      || readback.subjectName !== trustedImageRepository(role)
      || readback.subjectDigest !== build.imageDigest
      || readback.immutableImageRef !== `${build.imageRef}@${build.imageDigest}`) {
      throw new Error(`trusted_registry_readback_invalid:${role}`)
    }
    if (readback.receiptId === build.receiptId) throw new Error(`trusted_image_receipt_id_not_independent:${role}`)
    if (readback.provenance === build.provenance) throw new Error(`trusted_image_provenance_not_independent:${role}`)
    if (registryReceiptIds.has(readback.receiptId)) throw new Error('trusted_registry_receipt_id_not_unique')
    registryReceiptIds.add(readback.receiptId)
    if (readback.imageRef !== build.imageRef) throw new Error(`trusted_image_ref_mismatch:${role}`)
    if (!isImageDigest(readback.imageDigest) || readback.imageDigest !== build.imageDigest) {
      throw new Error(`trusted_image_digest_mismatch:${role}`)
    }
    images[role] = { imageRef: build.imageRef, imageDigest: build.imageDigest }
  }
  return { ok: true, images }
}

export function parseReleaseEvidenceArgs(argv = []) {
  const allowed = new Set(['--attestation', '--build-receipts'])
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!allowed.has(flag) || !value || String(value).startsWith('--') || values.has(flag)) {
      throw new Error('unsupported_release_evidence_argument')
    }
    values.set(flag, value)
  }
  if (!values.has('--attestation')) throw new Error('external_attestation_file_required')
  if (!values.has('--build-receipts')) throw new Error('build_receipts_file_required')
  return { attestationPath: values.get('--attestation'), buildReceiptsPath: values.get('--build-receipts') }
}

export function verifyRollbackReadiness(rollback = {}, counts = {}, producer = {}) {
  const required = ['pending', 'processing', 'error', 'dead-letter']
  if (rollback.requireAllUnfinishedCountsZero !== true
    || JSON.stringify(rollback.unfinishedCounts) !== JSON.stringify(required)) {
    throw new Error('rollback_unfinished_counts_contract_invalid')
  }
  const firstSteps = rollback.order?.slice(0, 5).map((step) => step?.id)
  if (JSON.stringify(firstSteps) !== JSON.stringify([
    'stop-api-intake-sockets-renewal', 'drain-pusher-queue', 'stop-pusher-and-wait',
    'checkpoint-queue-cursor-journal', 'readback-zero-and-preserved',
  ])) throw new Error('rollback_producer_drain_checkpoint_readback_order_invalid')
  if (rollback.requireProducerQuiesce !== true
    || producer.intakeStopped !== true
    || producer.renewalTimerStopped !== true
    || Number(producer.apiSocketCount) !== 0
    || producer.leaseStopped !== true
    || producer.pusherDrained !== true
    || producer.pusherStopped !== true
    || Number(producer.inFlight) !== 0
    || producer.checkpointReadback !== true) throw new Error('rollback_producer_not_quiesced')
  for (const field of required) {
    const value = Number(counts?.[field])
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`rollback_unfinished_count_invalid:${field}`)
    if (value !== 0) throw new Error(`rollback_unfinished_counts_nonzero:${field}`)
  }
  return { ok: true, counts: Object.fromEntries(required.map((field) => [field, 0])), producer: { ...producer } }
}

async function verifyGitTreeDigest(root, tree, spec, label) {
  if (spec?.algorithm !== 'sha256' || !/^[a-f0-9]{64}$/.test(String(spec?.sha256 ?? ''))) throw new Error(`${label}_manifest_invalid`)
  const actual = await computeGitTreePathSetDigest(root, tree, spec)
  if (actual.sha256 !== spec.sha256) throw new Error(`${label}_digest_mismatch:${actual.sha256}`)
  return actual
}

function assertGitQuiet(root, args, errorMessage) {
  try {
    execFileSync('git', args, { cwd: root, stdio: 'ignore' })
  } catch (error) {
    if (error?.status === 1) throw new Error(errorMessage)
    throw error
  }
}

async function collectFiles(root, relative, excluded, files) {
  if (isExcluded(relative, excluded)) return
  const absolute = path.join(root, ...relative.split('/'))
  const stat = await lstat(absolute)
  if (stat.isSymbolicLink()) throw new Error(`release_input_symlink_rejected:${relative}`)
  if (stat.isFile()) { files.add(relative); return }
  if (!stat.isDirectory()) throw new Error(`release_input_type_invalid:${relative}`)
  for (const entry of await readdir(absolute, { withFileTypes: true })) {
    await collectFiles(root, normalizeRelative(`${relative}/${entry.name}`), excluded, files)
  }
}

function isExcluded(relative, excluded) {
  return excluded.some((item) => relative === item || relative.startsWith(`${item}/`))
}

function normalizeRelative(value) {
  const normalized = String(value ?? '').replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '')
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) throw new Error('release_path_invalid')
  return normalized
}

function normalizeRoot(value) {
  return path.resolve(rootValue(value))
}

function rootValue(value) {
  return value instanceof URL ? fileURLToPath(value) : String(value ?? '')
}

function isEvidenceId(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(String(value ?? ''))
}

function isImageDigest(value) {
  return /^sha256:[a-f0-9]{64}$/.test(String(value ?? ''))
}

function isRegistryImageRef(value) {
  return /^(?=.{1,255}$)[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+(?::[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?$/.test(String(value ?? ''))
}

function assertNoSecretMaterial(value, errorMessage) {
  const visit = (item) => {
    if (item == null) return
    if (typeof item === 'string') {
      if (/\bbearer\s+\S+/i.test(item) || /[?&](?:token|key|secret|password|authorization)=/i.test(item)) throw new Error(errorMessage)
      return
    }
    if (Array.isArray(item)) { for (const entry of item) visit(entry); return }
    if (typeof item !== 'object') return
    for (const [key, entry] of Object.entries(item)) {
      if (/^(?:token|key|secret|password|authorization|api[_-]?key)$/i.test(key)) throw new Error(errorMessage)
      visit(entry)
    }
  }
  visit(value)
}

async function readBoundedJson(filePath, label, maxBytes = 64 * 1024) {
  const bytes = await readFile(filePath)
  if (bytes.length === 0 || bytes.length > maxBytes) throw new Error(`${label}_size_invalid`)
  try { return JSON.parse(bytes.toString('utf8')) } catch (error) {
    throw new Error(`${label}_json_invalid`, { cause: error })
  }
}

function createFixedRegistryReadback(adapterPath, { sourceDigest, sourceRef } = {}) {
  return async ({ role, imageRef }) => {
    const output = execFileSync(process.execPath, [
      adapterPath, '--role', role, '--image-ref', imageRef,
      '--source-digest', sourceDigest, '--source-ref', sourceRef,
    ], {
      encoding: 'utf8', shell: false, windowsHide: true, timeout: 90_000, maxBuffer: 64 * 1024,
    })
    if (Buffer.byteLength(output, 'utf8') > 64 * 1024) throw new Error('trusted_registry_readback_size_invalid')
    let value
    try { value = JSON.parse(output) } catch (error) {
      throw new Error('trusted_registry_readback_json_invalid', { cause: error })
    }
    assertNoSecretMaterial(value, 'trusted_registry_readback_secret_rejected')
    Object.defineProperty(value, TRUSTED_READBACK_CAPABILITY, { value: true })
    return value
  }
}

async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const candidateIndexTree = execFileSync('git', ['write-tree'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  assertCandidateIndexClean(repoRoot, candidateIndexTree)
  const manifestBytes = execFileSync('git', ['cat-file', 'blob', `${candidateIndexTree}:release/v105-v10-main21-source-fence-release-manifest.json`], { cwd: repoRoot })
  const manifest = JSON.parse(manifestBytes.toString('utf8'))
  const mainManifestBytes = execFileSync('git', ['cat-file', 'blob', `${candidateIndexTree}:release/v105-v10-main-release-manifest.json`], { cwd: repoRoot })
  const mainManifest = JSON.parse(mainManifestBytes.toString('utf8'))
  const digests = await verifyManifestDigests({ manifest, repoRoot, candidateIndexTree })
  await verifyV105V10MainManifestDigests({ manifest: mainManifest, dependencyManifest: manifest, repoRoot, candidateIndexTree })
  const candidateCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  const candidateCommitTree = execFileSync('git', ['rev-parse', `${candidateCommit}^{tree}`], { cwd: repoRoot, encoding: 'utf8' }).trim()
  if (!/^[a-f0-9]{40}$/.test(candidateCommit) || candidateCommitTree !== candidateIndexTree) throw new Error('candidate_commit_tree_mismatch')
  const expected = { ...digests, commit: candidateCommit, gitTag: manifest.gitTag, candidateIndexTree }
  const evidenceArgs = parseReleaseEvidenceArgs(process.argv.slice(2))
  const attestationPath = await assertExternalAttestationPath({ repoRoot, attestationPath: evidenceArgs.attestationPath })
  const buildReceiptsPath = await assertExternalAttestationPath({ repoRoot, attestationPath: evidenceArgs.buildReceiptsPath })
  if (attestationPath === buildReceiptsPath) throw new Error('build_receipts_must_be_independent_file')
  const attestation = await readBoundedJson(attestationPath, 'external_attestation')
  const buildReceipts = await readBoundedJson(buildReceiptsPath, 'build_receipts')
  verifyExternalReleaseAttestation(attestation, expected)
  const commitTree = execFileSync('git', ['rev-parse', `${attestation.commit}^{tree}`], { cwd: repoRoot, encoding: 'utf8' }).trim()
  const exactTagRef = `refs/tags/${manifest.gitTag}`
  const resolvedTagObject = execFileSync('git', ['rev-parse', exactTagRef], { cwd: repoRoot, encoding: 'utf8' }).trim()
  const tagObjectType = execFileSync('git', ['cat-file', '-t', resolvedTagObject], { cwd: repoRoot, encoding: 'utf8' }).trim()
  const tagCommit = execFileSync('git', ['rev-list', '-n', '1', exactTagRef], { cwd: repoRoot, encoding: 'utf8' }).trim()
  verifyExternalReleaseAttestation(attestation, {
    ...expected, commitTree, resolvedTagObject, tagObjectType, tagCommit,
  })
  const adapterPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'trusted-registry-readback-adapter.mjs')
  const trustedImages = await verifyTrustedImageEvidence({
    buildReceipts,
    expected: {
      commit: candidateCommit,
      tree: candidateIndexTree,
      proxyBuildInputSha256: digests.proxyBuildInputSha256,
      formalConsumerBuildInputSha256: digests.formalConsumerBuildInputSha256,
      workerBuildInputSha256: digests.workerBuildInputSha256,
      sourceRef: TRUSTED_SOURCE_REF,
    },
    trustedReadback: createFixedRegistryReadback(adapterPath, {
      sourceDigest: candidateCommit,
      sourceRef: TRUSTED_SOURCE_REF,
    }),
  })
  process.stdout.write(`${JSON.stringify({
    ok: true, commit: attestation.commit, tree: attestation.tree, tag: attestation.tag, images: trustedImages.images,
  })}\n`)
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${String(error?.message ?? error)}\n`)
    process.exitCode = 1
  })
}
