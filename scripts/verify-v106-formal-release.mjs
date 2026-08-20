import path from 'node:path'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  assertCandidateIndexClean,
  assertExternalAttestationPath,
  computeGitTreePathSetDigest,
} from './verify-v105-mt-api-release.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
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
  fence: { path: REQUIRED_DATABASE_ARTIFACTS[5], deploymentStep: 'fence-v105-new-issuance' },
  terminalize: { path: REQUIRED_DATABASE_ARTIFACTS[6], deploymentStep: 'terminalize-v105-cutover' },
  activate: { path: REQUIRED_DATABASE_ARTIFACTS[7], deploymentStep: 'activate-v106' },
  finalize: { path: REQUIRED_DATABASE_ARTIFACTS[8], deploymentStep: 'finalize' },
  rollbackTerminalize: { path: REQUIRED_DATABASE_ARTIFACTS[9], deploymentStep: 'rollback-terminalize' },
  rollback: { path: REQUIRED_DATABASE_ARTIFACTS[10], deploymentStep: 'rollback-only' },
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
  { pattern: /^supabase\/(?:migrations\/(?:20260818010000_v106_formal_v10_main|20260820003500_v106_formal8_final_time_fence|20260820010000_v106_formal12_bounded_raw_ack|20260820020000_v106_formal13_monotonic_projection|20260820030000_v106_formal16_rollback_receipt)\.sql|operations\/(?:fence_v105_new_issuance|terminalize_v105_cutover|activate_v106_promotion|finalize_v106_promotion|terminalize_v106_rollback|rollback_v106_to_v105)\.sql)$/, bindings: ['implementationTree', 'databaseCutoverInput'] },
  { pattern: /^scripts\/(?:verify-v106-formal-release|verify-v106-public-readiness|run-v106-production-cutover|run-worker-tests-scrubbed|test-env-scrub)\.mjs$/, bindings: ['implementationTree'] },
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

export function verifyV106PublicReadinessContract({ manifest, candidateIndexTree, root = repoRoot } = {}) {
  const gate = manifest?.publicReadinessGate
  const script = 'scripts/verify-v106-public-readiness.mjs'
  const runner = 'scripts/run-v106-production-cutover.mjs'
  const evidence = 'release/evidence/v106-formal13-production-block.json'
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
      || cutover?.requiresExternalAttestation !== true || cutover?.resolvesCommitFromAnnotatedTag !== true
      || cutover?.requiresExactCheckedOutHead !== true || cutover?.startsProducerOnlyAfterReadinessPass !== true
      || cutover?.producerStartScriptMustBeAbsolute !== true) throw new Error('production_cutover_runner_contract_missing')
  const order = manifest.deploymentOrder
  const required = ['proxy', gate.deploymentStep, 'frontend', 'live-e2e', 'finalize']
  const indexes = required.map((step) => order.indexOf(step))
  if (indexes.some((index) => index < 0) || indexes.some((index, position) => position > 0 && index <= indexes[position - 1])) {
    throw new Error('public_readiness_gate_order_mismatch')
  }
  if (manifest?.testRunners?.publicReadiness !== script || manifest?.testRunners?.productionCutover !== runner
      || !pathIsBound(manifest?.releaseBinding?.implementationTree, script)
      || !pathIsBound(manifest?.releaseBinding?.implementationTree, runner)
      || manifest?.incidentEvidence?.formal13 !== evidence
      || !pathIsBound(manifest?.releaseBinding?.implementationTree, evidence)) throw new Error('public_readiness_gate_binding_mismatch')
  for (const artifact of [script, runner, evidence]) execFileSync('git', ['cat-file', '-e', `${candidateIndexTree}:${artifact}`], { cwd: root })
  const source = execFileSync('git', ['show', `${candidateIndexTree}:${script}`], { cwd: root, encoding: 'utf8' })
  for (const requiredText of ['requiredStreak = Math.max(2', 'maxAttempts = Math.min(30', 'body?.releaseVersion === expectedRelease', 'body?.packageVersion === expectedPackage', 'body?.commit === expectedCommit', "blocked.code = 'PUBLIC_PROXY_READINESS_BLOCK'"]) {
    if (!source.includes(requiredText)) throw new Error('public_readiness_gate_executable_mismatch')
  }
  const runnerSource = execFileSync('git', ['show', `${candidateIndexTree}:${runner}`], { cwd: root, encoding: 'utf8' })
  for (const requiredText of ['verifyV106Attestation', 'resolveAnnotatedTagCommit', "if (head !== authorization.commit)", 'const readiness = await verifyReadiness', 'const producer = await startProducer']) {
    if (!runnerSource.includes(requiredText)) throw new Error('production_cutover_runner_executable_mismatch')
  }
  if (runnerSource.indexOf('const producer = await startProducer') < runnerSource.indexOf('const readiness = await verifyReadiness')) {
    throw new Error('production_cutover_runner_order_mismatch')
  }
  return { ok: true, script, runner, evidence, required }
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
  const attestation = JSON.parse(await readFile(externalPath, 'utf8'))
  if (attestation.releaseVersion !== manifest.releaseVersion) throw new Error('attestation_release_mismatch')
  if (attestation.tagName !== manifest.gitTag) throw new Error('attestation_tag_mismatch')
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
  const commit = resolveAnnotatedTagCommit({ tagName: manifest.gitTag, root })
  const tree = execFileSync('git', ['rev-parse', `${commit}^{tree}`], { cwd: root, encoding: 'utf8' }).trim()
  if (attestation.commit !== commit || tree !== candidateIndexTree) throw new Error('attestation_commit_tree_mismatch')
  return { ...digests, mode: 'external-attestation', releaseAuthorized: true, commit, tagName: manifest.gitTag }
}

async function main() {
  const args = process.argv.slice(2)
  const get = (name) => {
    const index = args.indexOf(name)
    return index >= 0 ? args[index + 1] : undefined
  }
  const candidateIndexTree = get('--candidate-index-tree')
  const attestationPath = get('--attestation')
  const digestsOnly = args.includes('--digests-only')
  if (!attestationPath && !digestsOnly) throw new Error('attestation_required')
  if (attestationPath && digestsOnly) throw new Error('attestation_and_digests_only_are_mutually_exclusive')
  const manifest = JSON.parse(await readFile(path.join(repoRoot, 'release', 'v106-formal-v10-main-release-manifest.json'), 'utf8'))
  const result = digestsOnly
    ? await verifyV106ManifestDigests({ manifest, candidateIndexTree })
    : await verifyV106Attestation({ manifest, candidateIndexTree, attestationPath })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error?.message ?? String(error)}\n`)
    process.exitCode = 1
  })
}
