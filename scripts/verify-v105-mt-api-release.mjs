import crypto from 'node:crypto'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { readdir, readFile, lstat, realpath } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
  const implementation = await verifyGitTreeDigest(rootValue(repoRoot), candidateIndexTree, binding.implementationTree, 'implementation_tree')
  const migration = await verifyGitTreeDigest(rootValue(repoRoot), candidateIndexTree, { algorithm: binding.migration.algorithm, paths: [binding.migration.path], excludedPaths: [], sha256: binding.migration.sha256 }, 'migration')
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
  const proxy = await verifyGitTreeDigest(rootValue(repoRoot), candidateIndexTree, binding.proxyBuildInput, 'proxy_build_input')
  const worker = await verifyGitTreeDigest(rootValue(repoRoot), candidateIndexTree, binding.workerBuildInput, 'worker_build_input')
  const exclusions = binding.implementationTree.excludedPaths?.map(normalizeRelative) ?? []
  for (const required of ['release/v105-mt-api-source-fence-release-manifest.json', 'release/attestations']) {
    if (!exclusions.includes(required)) throw new Error(`implementation_tree_self_reference_not_excluded:${required}`)
  }
  verifyTrustedEvidenceContract(binding)
  verifyV9ShadowRollbackContract(manifest, binding)
  verifyV10ShadowRollbackContract(manifest, binding)
  return {
    ok: true,
    implementationTreeSha256: implementation.sha256,
    migrationSha256: migration.sha256,
    shadowHydrationMigrationSha256: shadowHydrationMigration.sha256,
    shadowV10MigrationSha256: shadowV10Migration.sha256,
    proxyBuildInputSha256: proxy.sha256,
    workerBuildInputSha256: worker.sha256,
  }
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
  const deployment = Array.isArray(manifest?.deploymentOrder) ? manifest.deploymentOrder : []
  const order = Array.isArray(manifest?.rollback?.order) ? manifest.rollback.order : []
  const migrationIndex = deployment.indexOf('v10-shadow-migration')
  const readbackIndex = deployment.indexOf('v10-shadow-catalog-acl-readback')
  const proxyIndex = deployment.indexOf('proxy-compatible')
  const disableIndex = order.findIndex((step) => step?.id === 'disable-v10-shadow-before-proxy-rollback')
  const rollbackProxyIndex = order.findIndex((step) => step?.id === 'rollback-proxy-compatible')
  const disable = order[disableIndex]
  if (migration?.path !== binding?.shadowV10Migration?.path
    || migration?.serviceRoleOnly !== true || migration?.catalogAclReadbackRequired !== true
    || migrationIndex < 0 || readbackIndex !== migrationIndex + 1 || proxyIndex <= readbackIndex
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

export function verifyTrustedEvidenceContract(binding = {}) {
  const attestation = binding.attestation
  const adapter = 'scripts/trusted-registry-readback-adapter.mjs'
  if (attestation?.externalFileRequired !== true
    || attestation?.immutableCommitAndAnnotatedTagRequired !== true
    || attestation?.imageDigestReadbackRequired !== true
    || attestation?.phase !== 'post-build-pre-cutover'
    || attestation?.independentBuildReceiptsRequired !== true
    || attestation?.fixedRegistryAdapterRequired !== true
    || attestation?.fixedRegistryAdapter !== adapter
    || attestation?.arbitraryReadbackJsonRejected !== true
    || attestation?.abortOnMismatch !== true
    || !Array.isArray(binding.implementationTree?.paths)
    || !binding.implementationTree.paths.includes(adapter)) throw new Error('trusted_image_evidence_contract_incomplete')
  return { ok: true, phase: attestation.phase, adapter }
}

export function verifyExternalReleaseAttestation(attestation = {}, expected = {}) {
  for (const [field, value] of [['commit', attestation.commit], ['tree', attestation.tree], ['tagObject', attestation.tagObject]]) {
    if (!/^[a-f0-9]{40}$/.test(String(value ?? ''))) throw new Error(`attestation_${field}_invalid`)
  }
  if (!String(attestation.tag ?? '').trim()) throw new Error('attestation_tag_invalid')
  if (!String(expected.gitTag ?? '').trim() || attestation.tag !== expected.gitTag) throw new Error('attestation_tag_mismatch')
  if (!/^[a-f0-9]{40}$/.test(String(expected.candidateIndexTree ?? ''))
    || attestation.tree !== expected.candidateIndexTree) throw new Error('attestation_tree_mismatch')
  const digestFields = ['implementationTreeSha256', 'migrationSha256', 'shadowHydrationMigrationSha256', 'shadowV10MigrationSha256', 'proxyBuildInputSha256', 'workerBuildInputSha256']
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

export async function verifyTrustedImageEvidence({ buildReceipts, expected = {}, trustedReadback } = {}) {
  if (!buildReceipts || !Array.isArray(buildReceipts.receipts)) throw new Error('trusted_build_receipts_required')
  if (typeof trustedReadback !== 'function') throw new Error('trusted_registry_readback_required')
  assertNoSecretMaterial(buildReceipts, 'trusted_build_receipt_secret_rejected')
  const roles = ['proxy', 'worker']
  const receipts = new Map()
  for (const role of roles) {
    const matches = buildReceipts.receipts.filter((receipt) => receipt?.role === role)
    if (matches.length !== 1) throw new Error(`trusted_build_receipt_role_invalid:${role}`)
    const receipt = matches[0]
    if (!isEvidenceId(receipt.receiptId) || !isEvidenceId(receipt.provenance)) throw new Error(`trusted_build_receipt_identity_invalid:${role}`)
    if (receipt.commit !== expected.commit) throw new Error(`trusted_build_receipt_commit_mismatch:${role}`)
    if (receipt.tree !== expected.tree) throw new Error(`trusted_build_receipt_tree_mismatch:${role}`)
    const expectedInput = role === 'proxy' ? expected.proxyBuildInputSha256 : expected.workerBuildInputSha256
    if (!/^[a-f0-9]{64}$/.test(String(receipt.buildInputSha256 ?? '')) || receipt.buildInputSha256 !== expectedInput) {
      throw new Error(`trusted_build_receipt_input_mismatch:${role}`)
    }
    if (!isRegistryImageRef(receipt.imageRef)) throw new Error(`trusted_build_receipt_image_ref_invalid:${role}`)
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
    if (!readback || readback.role !== role || !isEvidenceId(readback.receiptId) || !isEvidenceId(readback.provenance)) {
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

function createFixedRegistryReadback(adapterPath) {
  return async ({ role, imageRef }) => {
    const output = execFileSync(process.execPath, [adapterPath, '--role', role, '--image-ref', imageRef], {
      encoding: 'utf8', shell: false, windowsHide: true, timeout: 90_000, maxBuffer: 64 * 1024,
    })
    if (Buffer.byteLength(output, 'utf8') > 64 * 1024) throw new Error('trusted_registry_readback_size_invalid')
    let value
    try { value = JSON.parse(output) } catch (error) {
      throw new Error('trusted_registry_readback_json_invalid', { cause: error })
    }
    assertNoSecretMaterial(value, 'trusted_registry_readback_secret_rejected')
    return value
  }
}

async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const candidateIndexTree = execFileSync('git', ['write-tree'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  assertCandidateIndexClean(repoRoot, candidateIndexTree)
  const manifestBytes = execFileSync('git', ['cat-file', 'blob', `${candidateIndexTree}:release/v105-mt-api-source-fence-release-manifest.json`], { cwd: repoRoot })
  const manifest = JSON.parse(manifestBytes.toString('utf8'))
  const digests = await verifyManifestDigests({ manifest, repoRoot, candidateIndexTree })
  const expected = { ...digests, gitTag: manifest.gitTag, candidateIndexTree }
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
      commit: attestation.commit,
      tree: candidateIndexTree,
      proxyBuildInputSha256: digests.proxyBuildInputSha256,
      workerBuildInputSha256: digests.workerBuildInputSha256,
    },
    trustedReadback: createFixedRegistryReadback(adapterPath),
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
