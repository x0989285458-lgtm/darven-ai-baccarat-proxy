import path from 'node:path'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { readFileSync, realpathSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  assertCandidateIndexClean,
  assertExternalAttestationPath,
  computeGitTreePathSetDigest,
} from './verify-v105-mt-api-release.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TRUSTED_TAG_SIGNER_FINGERPRINT = 'SHA256:y0VSR6o6x7g/c/PM2vrBeFGtDHELAVODN95N7N7eZAQ'
const TRUSTED_TAG_PRINCIPAL = 'v106-release'
const EXTERNAL_TRUST_POLICY_PATH = 'D:/AI Hermes/release-trust/v106-production-policy.json'
const EXTERNAL_TRUST_POLICY_VERSION = 'v106-release-trust-v1'
const BOUND_PRODUCER_START_SCRIPT = 'scripts/start-v106-formal-producer.py'
const BOUND_PRODUCER_STOP_SCRIPT = 'scripts/stop-v106-formal-producer.py'
const BOUND_PRODUCTION_DB_GATE_SCRIPT = 'scripts/verify-v106-production-db-gate.py'
const REQUIRED_RELEASE_BINDINGS = Object.freeze([
  'implementationTree',
  'proxyBuildInput',
  'frontendBuildInput',
  'workerBuildInput',
  'databaseCutoverInput',
])
const REQUIRED_DATABASE_ARTIFACTS = Object.freeze([
  'supabase/migrations/20260818010000_v106_formal_v10_main.sql',
  'supabase/migrations/20260820003500_v106_formal8_final_time_fence.sql',
  'supabase/migrations/20260820010000_v106_formal12_bounded_raw_ack.sql',
  'supabase/migrations/20260820020000_v106_formal13_monotonic_projection.sql',
  'supabase/migrations/20260820030000_v106_formal16_rollback_receipt.sql',
  'supabase/migrations/20260820040000_v106_formal17_single_use_rollback_receipt.sql',
  'supabase/migrations/20260820050000_v106_formal19_cutover_generation.sql',
  'supabase/migrations/20260820060000_v106_formal20_raw_ingest_barrier.sql',
  'supabase/migrations/20260821010000_v106_formal24_isolated_runtime_gate.sql',
  'supabase/migrations/20260821020000_v106_formal25_issuance_barrier.sql',
  'supabase/migrations/20260821030000_v106_formal26_successor_issuance_barrier.sql',
  'supabase/migrations/20260822010000_v106_formal53_atomic_outbox_batch.sql',
  'supabase/operations/fence_v105_new_issuance.sql',
  'supabase/operations/terminalize_v105_cutover.sql',
  'supabase/operations/activate_v106_promotion.sql',
  'supabase/operations/finalize_v106_promotion.sql',
  'supabase/operations/terminalize_v106_rollback.sql',
  'supabase/operations/rollback_v106_to_v105.sql',
])
const REQUIRED_DATABASE_CONTRACTS = Object.freeze({
  migration: { path: REQUIRED_DATABASE_ARTIFACTS[0], deploymentStep: 'database-additive' },
  finalTimeFence: { path: REQUIRED_DATABASE_ARTIFACTS[1], deploymentStep: 'database-final-time-fence' },
  boundedRawAck: { path: REQUIRED_DATABASE_ARTIFACTS[2], deploymentStep: 'database-bounded-raw-ack' },
  monotonicProjection: { path: REQUIRED_DATABASE_ARTIFACTS[3], deploymentStep: 'database-monotonic-projection' },
  rollbackReceipt: { path: REQUIRED_DATABASE_ARTIFACTS[4], deploymentStep: 'database-rollback-receipt' },
  rollbackReceiptSingleUse: { path: REQUIRED_DATABASE_ARTIFACTS[5], deploymentStep: 'database-single-use-rollback-receipt' },
  cutoverGeneration: { path: REQUIRED_DATABASE_ARTIFACTS[6], deploymentStep: 'database-cutover-generation' },
  rawIngestBarrier: { path: REQUIRED_DATABASE_ARTIFACTS[7], deploymentStep: 'database-raw-ingest-barrier' },
  isolatedRuntimeGate: { path: REQUIRED_DATABASE_ARTIFACTS[8], deploymentStep: 'database-isolated-runtime-gate' },
  issuanceBarrier: { path: REQUIRED_DATABASE_ARTIFACTS[9], deploymentStep: 'database-issuance-admission-barrier' },
  successorIssuanceBarrier: { path: REQUIRED_DATABASE_ARTIFACTS[10], deploymentStep: 'database-successor-issuance-admission-barrier' },
  atomicOutboxBatch: { path: REQUIRED_DATABASE_ARTIFACTS[11], deploymentStep: 'database-atomic-outbox-batch' },
  fence: { path: REQUIRED_DATABASE_ARTIFACTS[12], deploymentStep: 'fence-v105-new-issuance' },
  terminalize: { path: REQUIRED_DATABASE_ARTIFACTS[13], deploymentStep: 'terminalize-v105-cutover' },
  activate: { path: REQUIRED_DATABASE_ARTIFACTS[14], deploymentStep: 'activate-v106' },
  finalize: { path: REQUIRED_DATABASE_ARTIFACTS[15], deploymentStep: 'finalize' },
  rollbackTerminalize: { path: REQUIRED_DATABASE_ARTIFACTS[16], deploymentStep: 'rollback-terminalize' },
  rollback: { path: REQUIRED_DATABASE_ARTIFACTS[17], deploymentStep: 'rollback-only' },
})
const REQUIRED_ROLLBACK_ORDER = Object.freeze([
  'stop producer admission',
  'run bound v106 rollback terminalization and isolate active outbox evidence',
  'run rollback SQL',
  'deploy exact v105 proxy 6bdd39e8, current exact v105 frontend, and worker 6bdd39e8',
  'verify sole Active v105 and new v105 Final',
])
const DEPLOYABLE_BINDING_RULES = Object.freeze([
  { pattern: /^proxy\/(?:package(?:-lock)?\.json|src\/)/, bindings: ['implementationTree', 'proxyBuildInput'] },
  { pattern: /^proxy\/scripts\/run-tests\.mjs$/, bindings: ['implementationTree'] },
  { pattern: /^frontend\/(?:package(?:-lock)?\.json|src\/)/, bindings: ['implementationTree', 'frontendBuildInput'] },
  { pattern: /^cloud-browser-worker\/(?:Dockerfile|package(?:-lock)?\.json|src\/)/, bindings: ['implementationTree', 'workerBuildInput'] },
  { pattern: /^shared\//, bindings: ['implementationTree', 'proxyBuildInput', 'workerBuildInput'] },
  { pattern: /^supabase\/(?:migrations\/(?:20260818010000_v106_formal_v10_main|20260820003500_v106_formal8_final_time_fence|20260820010000_v106_formal12_bounded_raw_ack|20260820020000_v106_formal13_monotonic_projection|20260820030000_v106_formal16_rollback_receipt|20260820040000_v106_formal17_single_use_rollback_receipt|20260820050000_v106_formal19_cutover_generation|20260820060000_v106_formal20_raw_ingest_barrier|20260821010000_v106_formal24_isolated_runtime_gate|20260821020000_v106_formal25_issuance_barrier|20260821030000_v106_formal26_successor_issuance_barrier|20260822010000_v106_formal53_atomic_outbox_batch)\.sql|operations\/(?:fence_v105_new_issuance|terminalize_v105_cutover|activate_v106_promotion|finalize_v106_promotion|terminalize_v106_rollback|rollback_v106_to_v105)\.sql)$/, bindings: ['implementationTree', 'databaseCutoverInput'] },
  { pattern: /^scripts\/(?:verify-v106-formal-release|verify-v106-public-readiness|run-v106-production-cutover|run-worker-tests-scrubbed|test-env-scrub)\.mjs$/, bindings: ['implementationTree'] },
  { pattern: /^scripts\/(?:start-v106-formal-producer|verify-v106-production-db-gate)\.py$/, bindings: ['implementationTree'] },
  { pattern: /^release\/evidence\/v106-formal13-production-block\.json$/, bindings: ['implementationTree'] },
])

function pathIsBound(spec, candidatePath) {
  return spec?.paths?.some((boundPath) => candidatePath === boundPath || candidatePath.startsWith(`${boundPath}/`)) === true
}

export function verifyV106PredecessorRegression({ manifest, candidateIndexTree, root = repoRoot } = {}) {
  const spec = manifest?.predecessorRegression
  if (!spec || !/^[a-f0-9]{40}$/.test(spec.baseCommit ?? '') || !/^[a-f0-9]{64}$/.test(spec.sourceSha256 ?? '')) {
    throw new Error('predecessor_regression_binding_invalid')
  }
  for (const candidatePath of [spec.sourcePath, spec.executablePath]) {
    if (typeof candidatePath !== 'string' || !candidatePath || candidatePath.startsWith('/') || candidatePath.split('/').includes('..')) {
      throw new Error('predecessor_regression_path_invalid')
    }
  }
  const source = execFileSync('git', ['show', `${spec.baseCommit}:${spec.sourcePath}`], { cwd: root })
  const actual = createHash('sha256').update(source).digest('hex')
  if (actual !== spec.sourceSha256) throw new Error('predecessor_regression_source_mismatch')
  execFileSync('git', ['cat-file', '-e', `${candidateIndexTree}:${spec.executablePath}`], { cwd: root })
  return { ok: true, baseCommit: spec.baseCommit, sourceSha256: actual, executablePath: spec.executablePath }
}

export function resolveAnnotatedTagCommit({ tagName, root = repoRoot } = {}) {
  if (typeof tagName !== 'string' || !tagName) throw new Error('annotated_tag_name_missing')
  const tagRef = `refs/tags/${tagName}`
  const objectType = execFileSync('git', ['cat-file', '-t', tagRef], { cwd: root, encoding: 'utf8' }).trim()
  if (objectType !== 'tag') throw new Error('annotated_tag_required')
  return execFileSync('git', ['rev-parse', `${tagRef}^{commit}`], { cwd: root, encoding: 'utf8' }).trim()
}

function loadExternalReleaseTrustPolicy({ root = repoRoot } = {}) {
  const policyPath = realpathSync(EXTERNAL_TRUST_POLICY_PATH)
  const canonicalRoot = realpathSync(root)
  const relative = path.relative(canonicalRoot, policyPath)
  const policyInsideCandidate = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  if (policyInsideCandidate) throw new Error('external_release_trust_policy_required')
  const policyBytes = readFileSync(policyPath)
  const policy = JSON.parse(policyBytes.toString('utf8'))
  const allowedSigners = realpathSync(policy.allowedSignersPath)
  const allowedRelative = path.relative(canonicalRoot, allowedSigners)
  const allowedSha256 = createHash('sha256').update(readFileSync(allowedSigners)).digest('hex')
  const allowedInsideCandidate = allowedRelative === '' || (!allowedRelative.startsWith('..') && !path.isAbsolute(allowedRelative))
  if (allowedInsideCandidate
      || policy.policyVersion !== EXTERNAL_TRUST_POLICY_VERSION
      || policy.principal !== TRUSTED_TAG_PRINCIPAL
      || policy.signerFingerprint !== TRUSTED_TAG_SIGNER_FINGERPRINT
      || policy.allowedSignersSha256 !== allowedSha256
      || policy.supabaseProjectRef !== 'gscfexhsqxvtpyxudtza'
      || policy.workerImage !== 'darven-worker:v106-formal3-33f9dc6'
      || policy.workerImageId !== 'sha256:c52ed0039f1a45611f2d5dfb948450c204ee92c9226e1b7d6d6e2491bb92e7c2'
      || policy.pythonInterpreterPath !== 'D:/AI Hermes/hermes/hermes-agent/venv/Scripts/python.exe'
      || policy.pythonInterpreterSha256 !== 'c5f556ec6491af96e925f149c8e81701103862ca4d686af5788ad3e1954ca081'
      || policy.pythonIsolatedModeRequired !== true
      || policy.pythonNoSiteRequired !== true) {
    throw new Error('external_release_trust_policy_mismatch')
  }
  return { policyPath, allowedSigners, allowedSha256, policy }
}

export function verifyV106TrustedSignedTag({ tagName, attestationSha256, root = repoRoot } = {}) {
  if (!/^[a-f0-9]{64}$/.test(attestationSha256 ?? '')) throw new Error('attestation_sha256_invalid')
  const tagRef = `refs/tags/${tagName}`
  const trust = loadExternalReleaseTrustPolicy({ root })
  const allowedSigners = trust.allowedSigners
  const verification = spawnSync('git', [
    '-c', `gpg.ssh.allowedSignersFile=${allowedSigners}`,
    'verify-tag', tagRef,
  ], { cwd: root, encoding: 'utf8' })
  const evidence = `${verification.stdout ?? ''}\n${verification.stderr ?? ''}`
  if (verification.status !== 0
      || !evidence.includes(TRUSTED_TAG_SIGNER_FINGERPRINT)
      || !evidence.includes(`Good \"git\" signature for ${TRUSTED_TAG_PRINCIPAL}`)) {
    throw new Error('trusted_signed_tag_required')
  }
  const tagObject = execFileSync('git', ['cat-file', '-p', tagRef], { cwd: root, encoding: 'utf8' })
  if (!tagObject.includes(`Attestation-SHA256: ${attestationSha256}`)) {
    throw new Error('signed_tag_attestation_digest_mismatch')
  }
  return { ok: true, signerFingerprint: TRUSTED_TAG_SIGNER_FINGERPRINT, principal: TRUSTED_TAG_PRINCIPAL, attestationSha256, trustPolicyVersion: trust.policy.policyVersion, trustPolicyPath: trust.policyPath, allowedSignersSha256: trust.allowedSha256 }
}

export function verifyV106StagedDeployableCoverage({ manifest, root = repoRoot, stagedPaths } = {}) {
  for (const artifact of REQUIRED_DATABASE_ARTIFACTS) {
    if (!['implementationTree', 'databaseCutoverInput'].every((bindingName) => pathIsBound(manifest?.releaseBinding?.[bindingName], artifact))) {
      throw new Error(`release_required_artifact_unbound:${artifact}`)
    }
  }
  const paths = stagedPaths ?? execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMRD'], { cwd: root, encoding: 'utf8' })
    .split('\n').map((item) => item.trim()).filter(Boolean)
  for (const candidatePath of paths) {
    const rule = DEPLOYABLE_BINDING_RULES.find(({ pattern }) => pattern.test(candidatePath))
    if (!rule) continue
    for (const bindingName of rule.bindings) {
      if (!pathIsBound(manifest?.releaseBinding?.[bindingName], candidatePath)) {
        throw new Error(`release_deployable_out_of_binding:${bindingName}:${candidatePath}`)
      }
    }
  }
  return {
    ok: true,
    paths: paths.filter((candidatePath) => DEPLOYABLE_BINDING_RULES.some(({ pattern }) => pattern.test(candidatePath))),
  }
}

export function verifyV106DatabaseArtifactContracts({ manifest, candidateIndexTree, root = repoRoot } = {}) {
  const contracts = manifest?.databaseArtifacts
  const deploymentOrder = manifest?.deploymentOrder
  if (!contracts || typeof contracts !== 'object' || Array.isArray(contracts)) throw new Error('database_artifact_contracts_missing')
  if (!Array.isArray(deploymentOrder)) throw new Error('database_deployment_order_missing')
  let previousStepIndex = -1
  for (const [name, expected] of Object.entries(REQUIRED_DATABASE_CONTRACTS)) {
    const contract = contracts[name]
    if (!contract) throw new Error(`database_artifact_contract_missing:${name}`)
    if (contract.path !== expected.path) throw new Error(`database_artifact_path_mismatch:${name}`)
    if (contract.deploymentStep !== expected.deploymentStep) throw new Error(`database_artifact_step_mismatch:${name}`)
    if (!/^[a-f0-9]{40}$/.test(contract.gitBlobSha1 ?? '')) throw new Error(`database_artifact_blob_invalid:${name}`)
    const actualBlob = execFileSync('git', ['rev-parse', `${candidateIndexTree}:${contract.path}`], { cwd: root, encoding: 'utf8' }).trim()
    if (actualBlob !== contract.gitBlobSha1) throw new Error(`database_artifact_blob_mismatch:${name}`)
    if (!['implementationTree', 'databaseCutoverInput'].every((bindingName) => pathIsBound(manifest?.releaseBinding?.[bindingName], contract.path))) {
      throw new Error(`database_artifact_binding_mismatch:${name}`)
    }
    if (!['rollbackTerminalize', 'rollback'].includes(name)) {
      const stepIndex = deploymentOrder.indexOf(contract.deploymentStep)
      if (stepIndex < 0 || deploymentOrder.lastIndexOf(contract.deploymentStep) !== stepIndex || stepIndex <= previousStepIndex) {
        throw new Error(`database_artifact_order_mismatch:${name}`)
      }
      previousStepIndex = stepIndex
    }
  }
  if (manifest.database !== contracts.migration.path) throw new Error('database_artifact_alias_mismatch:migration')
  if (manifest.activation !== contracts.activate.path) throw new Error('database_artifact_alias_mismatch:activate')
  if (manifest.finalize !== contracts.finalize.path) throw new Error('database_artifact_alias_mismatch:finalize')
  if (manifest?.rollback?.terminalizeScript !== contracts.rollbackTerminalize.path) throw new Error('database_artifact_alias_mismatch:rollbackTerminalize')
  if (manifest?.rollback?.script !== contracts.rollback.path) throw new Error('database_artifact_alias_mismatch:rollback')
  if (!Array.isArray(manifest?.rollback?.order)
      || manifest.rollback.order.length !== REQUIRED_ROLLBACK_ORDER.length
      || manifest.rollback.order.some((step, index) => step !== REQUIRED_ROLLBACK_ORDER[index])) {
    throw new Error('database_rollback_order_mismatch')
  }
  return { ok: true, contracts: Object.keys(REQUIRED_DATABASE_CONTRACTS) }
}

export function verifyV106RollbackComponents({ manifest, root = repoRoot } = {}) {
  const rollback = manifest?.rollback
  const base = rollback?.componentVerification?.releaseBaseCommit
  if (!/^[a-f0-9]{40}$/.test(base ?? '')) throw new Error('rollback_release_base_invalid')
  const specifications = {
    proxy: {
      packagePath: 'proxy/package.json',
      identityPaths: ['proxy/src/build-version.js', 'proxy/src/server.js'],
      verify(sources, expected) {
        if (!sources[0].includes(`BUILD_VERSION = '${expected.buildVersion}'`)
            || !sources[1].includes(`WORKER_PROTOCOL_VERSION = '${expected.workerProtocol}'`)
            || expected.strategyVersion !== expected.buildVersion) throw new Error('rollback_component_identity_mismatch:proxy')
      },
    },
    frontend: {
      packagePath: 'frontend/package.json',
      identityPaths: ['frontend/src/lib/buildVersion.ts'],
      verify(sources, expected) {
        if (!sources[0].includes(`buildVersion: '${expected.buildVersion}'`)
            || !sources[0].includes(`strategyVersion: '${expected.strategyVersion}'`)
            || expected.workerProtocol !== expected.strategyVersion) throw new Error('rollback_component_identity_mismatch:frontend')
      },
    },
    worker: {
      packagePath: 'cloud-browser-worker/package.json',
      identityPaths: ['cloud-browser-worker/src/runtime-config.js', 'cloud-browser-worker/src/snapshot-pusher.js'],
      verify(sources, expected) {
        if (!sources[0].includes(`BUILD_VERSION = '${expected.buildVersion}'`)
            || !sources[1].includes(`protocolVersion: '${expected.workerProtocol}'`)
            || expected.strategyVersion !== expected.workerProtocol) throw new Error('rollback_component_identity_mismatch:worker')
      },
    },
  }
  for (const [name, specification] of Object.entries(specifications)) {
    const commit = rollback?.componentCommits?.[name]
    const expectedPackage = rollback?.componentPackages?.[name]
    const expectedBuild = rollback?.componentBuilds?.[name]
    if (!/^[a-f0-9]{40}$/.test(commit ?? '') || !expectedPackage || !expectedBuild) throw new Error(`rollback_component_contract_missing:${name}`)
    const type = execFileSync('git', ['cat-file', '-t', commit], { cwd: root, encoding: 'utf8' }).trim()
    if (type !== 'commit') throw new Error(`rollback_component_commit_invalid:${name}`)
    const ancestry = spawnSync('git', ['merge-base', '--is-ancestor', commit, base], { cwd: root })
    if (ancestry.status !== 0) throw new Error(`rollback_component_not_ancestor:${name}`)
    const packageJson = JSON.parse(execFileSync('git', ['show', `${commit}:${specification.packagePath}`], { cwd: root, encoding: 'utf8' }))
    if (packageJson.name !== expectedPackage.name || packageJson.version !== expectedPackage.version) {
      throw new Error(`rollback_component_package_mismatch:${name}`)
    }
    const sources = specification.identityPaths.map((candidatePath) => execFileSync('git', ['show', `${commit}:${candidatePath}`], { cwd: root, encoding: 'utf8' }))
    specification.verify(sources, expectedBuild)
  }
  if (rollback.componentVerification.allCommitsAreAncestorsOfReleaseBase !== true
      || rollback.componentVerification.packageAndBuildIdentityReadFromExactCommit !== true) {
    throw new Error('rollback_component_verification_claim_mismatch')
  }
  return { ok: true, releaseBaseCommit: base, components: Object.keys(specifications) }
}

export function verifyV106PublicReadinessContract({ manifest, candidateIndexTree, root = repoRoot } = {}) {
  const gate = manifest?.publicReadinessGate
  const script = 'scripts/verify-v106-public-readiness.mjs'
  const runner = 'scripts/run-v106-production-cutover.mjs'
  const evidence = 'release/evidence/v106-formal13-production-block.json'
  if (manifest?.canonicalPublicProxyUrl !== 'https://darven-ai-baccarat-proxy.onrender.com') {
    throw new Error('canonical_public_proxy_url_mismatch')
  }
  if (!gate || gate.script !== script || gate.deploymentStep !== 'run-bound-production-cutover'
      || gate.producerStartStep !== gate.deploymentStep) throw new Error('public_readiness_gate_contract_missing')
  if (gate.requiredConsecutive !== 2 || gate.boundedAttempts !== 30 || gate.requestTimeoutMs !== 20000
      || gate.intervalMs !== 15000 || gate.failClosedExitCode !== 2) throw new Error('public_readiness_gate_bounds_mismatch')
  const identity = gate.requiredIdentity
  if (identity?.version !== 'v106' || identity?.buildVersion !== 'v106'
      || identity?.releaseVersion !== manifest.releaseVersion || identity?.packageVersion !== manifest.applicationVersion
      || identity?.commit !== 'annotated-tag-attested-commit') throw new Error('public_readiness_gate_identity_mismatch')
  const cutover = manifest?.productionCutoverRunner
  if (cutover?.script !== runner || cutover?.deploymentStep !== gate.deploymentStep
      || cutover?.requiresExternalAttestation !== true || cutover?.requiresExternalTrustPolicy !== true
      || cutover?.requiresTrustedSignedTag !== true || cutover?.requiresPreAndPostDatabaseGenerationGate !== true
      || cutover?.requiresPostStartFailStopCompensation !== true
      || cutover?.executesLaunchersFromExactGitTree !== true
      || cutover?.requiresExternallyPinnedPythonInterpreter !== true
      || cutover?.requiresPythonIsolatedMode !== true
      || cutover?.requiresPythonNoSite !== true
      || cutover?.requiresDatabaseIssuanceAdmissionBarrier !== true
      || cutover?.requiresIdentityReadinessBeforeStart !== true
      || cutover?.requiresServiceReadinessAfterStart !== true
      || cutover?.predecessorLateSettlementRetained !== true
      || cutover?.productionDbGateRpc !== 'verify_v106_production_cutover_gate'
      || cutover?.trustedPythonSha256 !== 'c5f556ec6491af96e925f149c8e81701103862ca4d686af5788ad3e1954ca081'
      || cutover?.resolvesCommitFromAnnotatedTag !== true
      || cutover?.requiresExactCheckedOutHead !== true || cutover?.startsProducerOnlyAfterReadinessPass !== true
      || cutover?.producerStartScript !== BOUND_PRODUCER_START_SCRIPT
      || cutover?.producerStopScript !== BOUND_PRODUCER_STOP_SCRIPT
      || cutover?.productionDbGateScript !== BOUND_PRODUCTION_DB_GATE_SCRIPT
      || !/^[a-f0-9]{40}$/.test(cutover?.producerStartScriptGitBlobSha1 ?? '')
      || !/^[a-f0-9]{40}$/.test(cutover?.producerStopScriptGitBlobSha1 ?? '')
      || !/^[a-f0-9]{40}$/.test(cutover?.productionDbGateScriptGitBlobSha1 ?? '')
      || cutover?.producerImage !== 'darven-worker:v106-formal3-33f9dc6'
      || cutover?.producerImageId !== 'sha256:c52ed0039f1a45611f2d5dfb948450c204ee92c9226e1b7d6d6e2491bb92e7c2') {
    throw new Error('production_cutover_runner_contract_missing')
  }
  const authorization = manifest?.releaseAuthorization
  if (authorization?.trustedSignerFingerprint !== TRUSTED_TAG_SIGNER_FINGERPRINT
      || authorization?.trustedSignerPrincipal !== TRUSTED_TAG_PRINCIPAL
      || authorization?.trustPolicyVersion !== EXTERNAL_TRUST_POLICY_VERSION
      || authorization?.trustPolicyLocation !== 'external-out-of-repository'
      || authorization?.trustPolicySha256Required !== true
      || authorization?.allowedSignersLocation !== 'external-out-of-repository'
      || authorization?.allowedSignersSha256 !== 'd0c454dd0083b124894ef1ec7689094d09dc1732b03e89089e197fc6431889a0'
      || authorization?.signedTagBindsAttestationSha256 !== true) {
    throw new Error('trusted_release_authorization_contract_missing')
  }
  const order = manifest.deploymentOrder
  const required = ['proxy', gate.deploymentStep, 'frontend', 'live-e2e', 'finalize']
  const indexes = required.map((step) => order.indexOf(step))
  if (indexes.some((index) => index < 0) || indexes.some((index, position) => position > 0 && index <= indexes[position - 1])) {
    throw new Error('public_readiness_gate_order_mismatch')
  }
  if (manifest?.testRunners?.publicReadiness !== script || manifest?.testRunners?.productionCutover !== runner
      || !pathIsBound(manifest?.releaseBinding?.implementationTree, script)
      || !pathIsBound(manifest?.releaseBinding?.implementationTree, runner)
      || !pathIsBound(manifest?.releaseBinding?.implementationTree, BOUND_PRODUCER_START_SCRIPT)
      || !pathIsBound(manifest?.releaseBinding?.implementationTree, BOUND_PRODUCER_STOP_SCRIPT)
      || !pathIsBound(manifest?.releaseBinding?.implementationTree, BOUND_PRODUCTION_DB_GATE_SCRIPT)
      || manifest?.incidentEvidence?.formal13 !== evidence
      || !pathIsBound(manifest?.releaseBinding?.implementationTree, evidence)) throw new Error('public_readiness_gate_binding_mismatch')
  for (const artifact of [script, runner, BOUND_PRODUCER_START_SCRIPT, BOUND_PRODUCER_STOP_SCRIPT, BOUND_PRODUCTION_DB_GATE_SCRIPT, evidence]) {
    execFileSync('git', ['cat-file', '-e', `${candidateIndexTree}:${artifact}`], { cwd: root })
  }
  const producerBlob = execFileSync('git', ['rev-parse', `${candidateIndexTree}:${BOUND_PRODUCER_START_SCRIPT}`], { cwd: root, encoding: 'utf8' }).trim()
  const producerStopBlob = execFileSync('git', ['rev-parse', `${candidateIndexTree}:${BOUND_PRODUCER_STOP_SCRIPT}`], { cwd: root, encoding: 'utf8' }).trim()
  const dbGateBlob = execFileSync('git', ['rev-parse', `${candidateIndexTree}:${BOUND_PRODUCTION_DB_GATE_SCRIPT}`], { cwd: root, encoding: 'utf8' }).trim()
  if (producerBlob !== cutover.producerStartScriptGitBlobSha1) throw new Error('producer_start_script_blob_mismatch')
  if (producerStopBlob !== cutover.producerStopScriptGitBlobSha1) throw new Error('producer_stop_script_blob_mismatch')
  if (dbGateBlob !== cutover.productionDbGateScriptGitBlobSha1) throw new Error('production_db_gate_script_blob_mismatch')
  const source = execFileSync('git', ['show', `${candidateIndexTree}:${script}`], { cwd: root, encoding: 'utf8' })
  for (const requiredText of ['requiredStreak = Math.max(2', 'maxAttempts = Math.min(30', "redirect: 'error'", "mode === 'identity'", 'response?.status === 503 && body?.ok === false', 'body?.releaseVersion === expectedRelease', 'body?.packageVersion === expectedPackage', 'body?.commit === expectedCommit', "blocked.code = 'PUBLIC_PROXY_READINESS_BLOCK'"]) {
    if (!source.includes(requiredText)) throw new Error('public_readiness_gate_executable_mismatch')
  }
  const runnerSource = execFileSync('git', ['show', `${candidateIndexTree}:${runner}`], { cwd: root, encoding: 'utf8' })
  for (const requiredText of ['verifyV106Attestation', 'resolveAnnotatedTagCommit', "if (head !== authorization.commit)", 'url: manifest.canonicalPublicProxyUrl', 'const identityReadiness = await verifyReadiness', "mode: 'identity'", 'const postReadinessHead', 'const postReadinessTree', 'production_cutover_post_readiness_identity_drift', 'production_cutover_producer_blob_drift', "verifyProductionDb({ phase: 'pre'", 'production_cutover_db_provenance_not_proven', 'generation: preDbGate.generation', 'const serviceReadiness = await verifyReadiness', "mode: 'service'", "verifyProductionDb({ phase: 'post'", 'production_cutover_db_generation_drift', 'producer = await startProducer', 'postDbGate = await verifyProductionDb', 'boundedPostAttempts', 'postDbGateAttempts', 'postDbGateIntervalMs', 'stopped = await stopProducer', 'production_cutover_post_start_compensation_failed', 'producer_start_script_override_forbidden', 'manifest.productionCutoverRunner.producerStartScript', 'production_cutover_producer_stop_blob_drift', 'production_cutover_db_gate_blob_drift', 'loadBoundPythonSource', "spawnSync(trustedPython.path, ['-I', '-S', '-c', producerStartSource]", "spawnSync(trustedPython.path, ['-I', '-S', '-c', producerStopSource]", "spawnSync(trustedPython.path, ['-I', '-S', '-c', productionDbGateSource]", 'loadTrustedPythonInterpreter', 'buildBoundPythonEnvironment(process.env)', 'assertTrustedPythonUnchanged']) {
    if (!runnerSource.includes(requiredText)) throw new Error('production_cutover_runner_executable_mismatch')
  }
  const identityReadinessIndex = runnerSource.indexOf('const identityReadiness = await verifyReadiness')
  const producerStartIndex = runnerSource.indexOf('producer = await startProducer')
  const serviceReadinessIndex = runnerSource.indexOf('const serviceReadiness = await verifyReadiness')
  const postDbGateIndex = runnerSource.indexOf('postDbGate = await verifyProductionDb')
  if (!(identityReadinessIndex >= 0 && identityReadinessIndex < producerStartIndex
      && producerStartIndex < serviceReadinessIndex && serviceReadinessIndex < postDbGateIndex)) {
    throw new Error('production_cutover_runner_order_mismatch')
  }
  if (runnerSource.includes("get('--url')") || runnerSource.includes("get('--producer-start-script')")) {
    throw new Error('production_cutover_runner_override_forbidden')
  }
  const producerSource = execFileSync('git', ['show', `${candidateIndexTree}:${BOUND_PRODUCER_START_SCRIPT}`], { cwd: root, encoding: 'utf8' })
  for (const requiredText of ["EXPECTED_RELEASE = 'v106.0.0-formal.54'", "EXPECTED_PACKAGE = '1.0.111'", "EXPECTED_IMAGE = 'darven-worker:v106-formal3-33f9dc6'", "EXPECTED_IMAGE_ID = 'sha256:c52ed0039f1a45611f2d5dfb948450c204ee92c9226e1b7d6d6e2491bb92e7c2'", 'identity_parts != [EXPECTED_IMAGE, EXPECTED_IMAGE_ID', 'V106_CUTOVER_GENERATION', 'systemctl start darven-worker.service', 'base64.b64encode(remote_script.encode', '30-v106-formal3-image.conf', '127.0.0.1:8787/health', "'endpointReachable':", "'exactImage':"]) {
    if (!producerSource.includes(requiredText)) throw new Error('producer_start_script_executable_mismatch')
  }
  const producerStopSource = execFileSync('git', ['show', `${candidateIndexTree}:${BOUND_PRODUCER_STOP_SCRIPT}`], { cwd: root, encoding: 'utf8' })
  for (const requiredText of ["EXPECTED_RELEASE = 'v106.0.0-formal.54'", "EXPECTED_PACKAGE = '1.0.111'", 'V106_CUTOVER_GENERATION', 'systemctl stop darven-worker.service', 'systemctl is-active darven-worker.service', "'stopped': True", "parts[0] != 'inactive'", "parts[2].lower() == 'true'"]) {
    if (!producerStopSource.includes(requiredText)) throw new Error('producer_stop_script_executable_mismatch')
  }
  const dbGateSource = execFileSync('git', ['show', `${candidateIndexTree}:${BOUND_PRODUCTION_DB_GATE_SCRIPT}`], { cwd: root, encoding: 'utf8' })
  for (const requiredText of ["EXPECTED_PROJECT_REF = 'gscfexhsqxvtpyxudtza'", "EXPECTED_RELEASE = 'v106.0.0-formal.54'", "EXPECTED_PACKAGE = '1.0.111'", '20260821010000', '20260821030000', '20260822010000', 'verify_v106_production_cutover_gate', 'class NoRedirect', 'urllib.request', "'Authorization':", 'EXPECTED_WRITER_ACL', "payload.get('migrations')", "payload.get('activeOutbox')"]) {
    if (!dbGateSource.includes(requiredText)) throw new Error('production_db_gate_script_executable_mismatch')
  }
  if (dbGateSource.includes('psycopg') || dbGateSource.includes('import site')) throw new Error('production_db_gate_script_executable_mismatch')
  return { ok: true, script, runner, producerStartScript: BOUND_PRODUCER_START_SCRIPT, producerStopScript: BOUND_PRODUCER_STOP_SCRIPT, productionDbGateScript: BOUND_PRODUCTION_DB_GATE_SCRIPT, evidence, required }
}

export async function verifyV106ManifestDigests({ manifest, candidateIndexTree, root = repoRoot } = {}) {
  assertCandidateIndexClean(root, candidateIndexTree)
  verifyV106PredecessorRegression({ manifest, candidateIndexTree, root })
  const binding = manifest?.releaseBinding
  if (!binding) throw new Error('release_binding_missing')
  for (const name of REQUIRED_RELEASE_BINDINGS) {
    if (!Object.hasOwn(binding, name)) throw new Error(`release_binding_missing:${name}`)
  }
  verifyV106DatabaseArtifactContracts({ manifest, candidateIndexTree, root })
  verifyV106RollbackComponents({ manifest, root })
  verifyV106PublicReadinessContract({ manifest, candidateIndexTree, root })
  verifyV106StagedDeployableCoverage({ manifest, root })
  const result = {}
  for (const [name, spec] of Object.entries(binding)) {
    if (!spec || spec.algorithm !== 'sha256' || !Array.isArray(spec.paths) || !/^[a-f0-9]{64}$/.test(spec.sha256 ?? '')) {
      throw new Error(`release_binding_invalid:${name}`)
    }
    const actual = await computeGitTreePathSetDigest(root, candidateIndexTree, spec)
    if (actual.sha256 !== spec.sha256) throw new Error(`release_binding_mismatch:${name}`)
    result[name] = actual.sha256
  }
  return { ok: true, mode: 'precommit-digests-only', releaseAuthorized: false, candidateIndexTree, digests: result }
}

export async function verifyV106Attestation({ manifest, candidateIndexTree, attestationPath, root = repoRoot } = {}) {
  const digests = await verifyV106ManifestDigests({ manifest, candidateIndexTree, root })
  const externalPath = await assertExternalAttestationPath({ repoRoot: root, attestationPath })
  const attestationBytes = await readFile(externalPath)
  const attestationSha256 = createHash('sha256').update(attestationBytes).digest('hex')
  const attestation = JSON.parse(attestationBytes.toString('utf8'))
  if (attestation.releaseVersion !== manifest.releaseVersion) throw new Error('attestation_release_mismatch')
  if (attestation.tagName !== manifest.gitTag) throw new Error('attestation_tag_mismatch')
  if (attestation.publicProxyUrl !== manifest.canonicalPublicProxyUrl) throw new Error('attestation_public_proxy_url_mismatch')
  if (attestation.candidateIndexTree !== candidateIndexTree) throw new Error('attestation_tree_mismatch')
  const expectedDigests = digests.digests
  const attestedDigests = attestation.digests
  if (!attestedDigests || typeof attestedDigests !== 'object' || Array.isArray(attestedDigests)) throw new Error('attestation_digests_missing')
  const expectedDigestKeys = Object.keys(expectedDigests).sort()
  const attestedDigestKeys = Object.keys(attestedDigests).sort()
  if (JSON.stringify(attestedDigestKeys) !== JSON.stringify(expectedDigestKeys)) throw new Error('attestation_digests_key_mismatch')
  for (const name of expectedDigestKeys) {
    if (attestedDigests[name] !== expectedDigests[name]) throw new Error(`attestation_digest_mismatch:${name}`)
  }
  const signedAuthorization = verifyV106TrustedSignedTag({ tagName: manifest.gitTag, attestationSha256, root })
  const commit = resolveAnnotatedTagCommit({ tagName: manifest.gitTag, root })
  const tree = execFileSync('git', ['rev-parse', `${commit}^{tree}`], { cwd: root, encoding: 'utf8' }).trim()
  if (attestation.commit !== commit || tree !== candidateIndexTree) throw new Error('attestation_commit_tree_mismatch')
  return { ...digests, mode: 'external-attestation', releaseAuthorized: true, commit, tagName: manifest.gitTag, signedAuthorization }
}

async function main() {
  const args = process.argv.slice(2)
  const get = (name) => {
    const index = args.indexOf(name)
    return index >= 0 ? args[index + 1] : undefined
  }
  const candidateIndexTree = get('--candidate-index-tree')
  const attestationPath = get('--attestation')
  if (args.includes('--digests-only')) throw new Error('digest_only_release_ticket_forbidden')
  if (!attestationPath) throw new Error('attestation_required')
  const manifest = JSON.parse(await readFile(path.join(repoRoot, 'release', 'v106-formal-v10-main-release-manifest.json'), 'utf8'))
  const result = await verifyV106Attestation({ manifest, candidateIndexTree, attestationPath })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error?.message ?? String(error)}\n`)
    process.exitCode = 1
  })
}
