import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import manifest from '../../release/v105-mt-api-source-fence-release-manifest.json' with { type: 'json' }
import {
  computePathSetDigest,
  verifyManifestDigests,
  verifyExternalReleaseAttestation,
} from '../../scripts/verify-v105-mt-api-release.mjs'
import * as releaseVerifier from '../../scripts/verify-v105-mt-api-release.mjs'

test('release scope freezes one existing session as API-only canonical capture', () => {
  assert.equal(manifest.releaseVersion, 'v105-shadow-v10.21')
    assert.equal(manifest.gitTag, 'v105-shadow-v10.21')
    assert.equal(manifest.applicationVersion, '1.0.58')
  assert.deepEqual(manifest.releaseScope, {
    mode: 'single-session-api-primary',
    canonicalSource: 'api',
    workerEnvironment: { MT_SOURCE_MODE: 'api', MT_CAPTURE_ROLE: 'canonical' },
    browserEnabled: false,
    backupReplayEnabled: false,
    recordContract: 'unverified',
    gapPolicy: 'fail-closed-stop-ack-and-alert',
    deferred: ['second-independent-session-backup', 'record-replay'],
  })
  assert.deepEqual(manifest.adminSession, {
    mode: 'aes-256-gcm-stateless-with-live-db-revalidation',
    secretEnvironmentPriority: ['ADMIN_SESSION_SECRET', 'MEMBER_SESSION_SECRET'],
    minimumSecretBytes: 32,
    productionFailClosed: true,
    ttlMinMs: 60000,
    ttlMaxMs: 1800000,
    revalidateAccountAndRoleOnEveryProtectedRequest: true,
    transientValidationStatus: 503,
    invalidAuthorizationStatus: 401,
  })
  assert.deepEqual(manifest.newRoundDelivery, {
    trigger: 'durable-next-prediction-ready',
    payload: 'existing-tables-sse-with-road-and-exact-v105-prediction',
    immediateBroadcast: true,
    singleFlightCoalescing: true,
    heartbeatFallbackMs: 3000,
    blocksCaptureOutboxAck: false,
    frontendChanged: false,
    historyQueryChanged: true,
  })
  assert.deepEqual(manifest.shadowHydrationHotfix, {
    strategyVersion: 'v105-shadow-v9-weighted-v7-v8',
    runtimeFlag: 'V105_SHADOW_V9_ENABLED=true',
    preservesFormalV105: true,
    preservesShadowHistory: true,
    changesWeightsOrThresholds: false,
    nodeDateMillisecondOrdering: true,
  })
  assert.equal(manifest.releaseBinding.shadowHydrationMigration.path, 'supabase/migrations/20260801162200_v105_shadow_v9_hydration_millisecond_order.sql')
  assert.equal(manifest.releaseBinding.shadowHydrationMigration.sha256, '1532547446c46a94373f1b4758f1b464798b3d5583f4a73492c83000a662a974')
  assert.deepEqual(manifest.shadowV10, {
    strategyVersion: 'v105-shadow-v10-big-road-uncommon-structure-rank-synchronized',
    runtimeFlag: 'V105_SHADOW_V10_ENABLED=true',
    v9WeightShare: 0.9,
    structureWeightShare: 0.1,
    preservesFormalV105: true,
    preservesV9: true,
    preservesSidePredictions: true,
    memberVisible: false,
    independentCounterStartsAt: 0,
    fixedFormalTableAllowlist: true,
    inputSource: 'authoritative-big-road-only',
    beadPlateUsed: false,
    oldV10EvidencePreserved: true,
  })
  assert.equal(manifest.releaseBinding.shadowV10Migration.path, 'supabase/migrations/20260804013000_v105_shadow_v10_rank_sync.sql')
  assert.equal(manifest.releaseBinding.shadowV10DbValidationMigration.path, 'supabase/migrations/20260804090000_v105_shadow_v10_rank_sync_db_validation.sql')
  assert.equal(manifest.releaseBinding.rankLedgerRecoveryMigration.path, 'supabase/migrations/20260804100000_v100_rank_ledger_cloud_round_recovery.sql')
  assert.equal(manifest.releaseBinding.rankSyncHydrationMigration.path, 'supabase/migrations/20260804110000_v105_shadow_v10_rank_sync_hydration_millisecond_order.sql')
  assert.equal(manifest.releaseBinding.captureOutboxHealthMigration.path, 'supabase/migrations/20260803124500_v105_capture_outbox_health_active_only.sql')
  assert.equal(manifest.releaseBinding.captureOutboxHealthMigration.sha256, 'c539a3539768999373662680960814dc1d10918d1e096d9e8192c51363fd6c15')
  assert.equal(manifest.releaseBinding.shadowV6V8RetirementMigration.path, 'supabase/migrations/20260802020000_retire_v105_shadow_v6_v8.sql')
})

test('release manifest freezes current implementation, migration, proxy, and worker build inputs', async () => {
  const repoRoot = new URL('../../', import.meta.url)
  const candidateIndexTree = execFileSync('git', ['write-tree'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  const result = await verifyManifestDigests({ manifest, repoRoot, candidateIndexTree })
  assert.equal(result.ok, true)
  assert.match(manifest.releaseBinding.implementationTree.sha256, /^[a-f0-9]{64}$/)
  assert.match(manifest.releaseBinding.migration.sha256, /^[a-f0-9]{64}$/)
  assert.match(manifest.releaseBinding.proxyBuildInput.sha256, /^[a-f0-9]{64}$/)
  assert.match(manifest.releaseBinding.workerBuildInput.sha256, /^[a-f0-9]{64}$/)
  assert.equal(result.shadowHydrationMigrationSha256, manifest.releaseBinding.shadowHydrationMigration.sha256)
  assert.equal(result.captureOutboxHealthMigrationSha256, manifest.releaseBinding.captureOutboxHealthMigration.sha256)
  assert.equal(result.shadowV10MigrationSha256, manifest.releaseBinding.shadowV10Migration.sha256)
  assert.equal(result.shadowV10DbValidationMigrationSha256, manifest.releaseBinding.shadowV10DbValidationMigration.sha256)
  assert.equal(result.rankLedgerRecoveryMigrationSha256, manifest.releaseBinding.rankLedgerRecoveryMigration.sha256)
  assert.equal(result.rankSyncHydrationMigrationSha256, manifest.releaseBinding.rankSyncHydrationMigration.sha256)
  assert.equal(result.shadowV6V8RetirementMigrationSha256, manifest.releaseBinding.shadowV6V8RetirementMigration.sha256)
  const outboxHealthTampered = structuredClone(manifest)
  outboxHealthTampered.releaseBinding.captureOutboxHealthMigration.sha256 = '0'.repeat(64)
  await assert.rejects(
    verifyManifestDigests({ manifest: outboxHealthTampered, repoRoot, candidateIndexTree }),
    /capture_outbox_health_migration_digest_mismatch/,
  )
  const v10Tampered = structuredClone(manifest)
  v10Tampered.releaseBinding.shadowV10Migration.sha256 = '0'.repeat(64)
  await assert.rejects(
    verifyManifestDigests({ manifest: v10Tampered, repoRoot, candidateIndexTree }),
    /shadow_v10_migration_digest_mismatch/,
  )
  const v10DbValidationTampered = structuredClone(manifest)
  v10DbValidationTampered.releaseBinding.shadowV10DbValidationMigration.sha256 = '0'.repeat(64)
  await assert.rejects(
    verifyManifestDigests({ manifest: v10DbValidationTampered, repoRoot, candidateIndexTree }),
    /shadow_v10_db_validation_migration_digest_mismatch/,
  )
  const rankRecoveryTampered = structuredClone(manifest)
  rankRecoveryTampered.releaseBinding.rankLedgerRecoveryMigration.sha256 = '0'.repeat(64)
  await assert.rejects(
    verifyManifestDigests({ manifest: rankRecoveryTampered, repoRoot, candidateIndexTree }),
    /rank_ledger_recovery_migration_digest_mismatch/,
  )
  const rankSyncHydrationTampered = structuredClone(manifest)
  rankSyncHydrationTampered.releaseBinding.rankSyncHydrationMigration.sha256 = '0'.repeat(64)
  await assert.rejects(
    verifyManifestDigests({ manifest: rankSyncHydrationTampered, repoRoot, candidateIndexTree }),
    /rank_sync_hydration_migration_digest_mismatch/,
  )
  const retirementTampered = structuredClone(manifest)
  retirementTampered.releaseBinding.shadowV6V8RetirementMigration.sha256 = '0'.repeat(64)
  await assert.rejects(
    verifyManifestDigests({ manifest: retirementTampered, repoRoot, candidateIndexTree }),
    /shadow_v6_v8_retirement_migration_digest_mismatch/,
  )
  const tampered = structuredClone(manifest)
  tampered.releaseBinding.shadowHydrationMigration.sha256 = '0'.repeat(64)
  await assert.rejects(
    verifyManifestDigests({ manifest: tampered, repoRoot, candidateIndexTree }),
    /shadow_hydration_migration_digest_mismatch/,
  )
  const rollbackTampered = structuredClone(manifest)
  rollbackTampered.rollback.order = rollbackTampered.rollback.order.filter((step) => step.id !== 'disable-v9-shadow-before-proxy-rollback')
  await assert.rejects(
    verifyManifestDigests({ manifest: rollbackTampered, repoRoot, candidateIndexTree }),
    /v9_shadow_rollback_contract_invalid/,
  )
})

test('implementation digest explicitly excludes self-referential manifest and attestation paths', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'darven-release-tree-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, 'src'), { recursive: true })
  await mkdir(path.join(root, 'release', 'attestations'), { recursive: true })
  await writeFile(path.join(root, 'src', 'server.js'), 'export const value = 1\n')
  await writeFile(path.join(root, 'release', 'manifest.json'), '{"tree":"old"}\n')
  await writeFile(path.join(root, 'release', 'attestations', 'external.json'), '{"digest":"old"}\n')
  const spec = {
    paths: ['src', 'release/manifest.json', 'release/attestations'],
    excludedPaths: ['release/manifest.json', 'release/attestations'],
  }
  const first = await computePathSetDigest(root, spec)
  await writeFile(path.join(root, 'release', 'manifest.json'), '{"tree":"new-self-value"}\n')
  await writeFile(path.join(root, 'release', 'attestations', 'external.json'), '{"digest":"new-self-value"}\n')
  const afterSelfChange = await computePathSetDigest(root, spec)
  assert.equal(afterSelfChange.sha256, first.sha256)
  await writeFile(path.join(root, 'src', 'server.js'), 'export const value = 2\n')
  const afterSourceChange = await computePathSetDigest(root, spec)
  assert.notEqual(afterSourceChange.sha256, first.sha256)
})

test('Reviewer P1 attestation exact binding rejects old tag and wrong tree while accepting the dynamic candidate index tree', () => {
  const repoRoot = new URL('../../', import.meta.url)
  const candidateIndexTree = execFileSync('git', ['write-tree'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  const attestation = {
    commit: '1'.repeat(40), tree: candidateIndexTree, tagObject: 'a'.repeat(40), tag: manifest.gitTag,
    implementationTreeSha256: '3'.repeat(64), migrationSha256: '4'.repeat(64),
    shadowHydrationMigrationSha256: 'd'.repeat(64),
    shadowV10MigrationSha256: 'e'.repeat(64), shadowV10DbValidationMigrationSha256: 'c'.repeat(64),
    rankLedgerRecoveryMigrationSha256: 'b'.repeat(64),
    rankSyncHydrationMigrationSha256: 'a'.repeat(64),
    shadowV6V8RetirementMigrationSha256: 'f'.repeat(64),
    proxyBuildInputSha256: '5'.repeat(64), workerBuildInputSha256: '6'.repeat(64),
    images: {
      proxy: { expectedDigest: `sha256:${'7'.repeat(64)}`, readbackDigest: `sha256:${'7'.repeat(64)}` },
      worker: { expectedDigest: `sha256:${'8'.repeat(64)}`, readbackDigest: `sha256:${'8'.repeat(64)}` },
    },
  }
  const expected = {
    implementationTreeSha256: '3'.repeat(64), migrationSha256: '4'.repeat(64),
    shadowHydrationMigrationSha256: 'd'.repeat(64),
    shadowV10MigrationSha256: 'e'.repeat(64), shadowV10DbValidationMigrationSha256: 'c'.repeat(64),
    rankLedgerRecoveryMigrationSha256: 'b'.repeat(64),
    rankSyncHydrationMigrationSha256: 'a'.repeat(64),
    shadowV6V8RetirementMigrationSha256: 'f'.repeat(64),
    proxyBuildInputSha256: '5'.repeat(64), workerBuildInputSha256: '6'.repeat(64),
    gitTag: manifest.gitTag, candidateIndexTree,
  }
  assert.equal(verifyExternalReleaseAttestation(attestation, expected).ok, true)
  assert.equal(verifyExternalReleaseAttestation(attestation, {
    ...expected,
    commitTree: candidateIndexTree,
    resolvedTagObject: attestation.tagObject,
    tagObjectType: 'tag',
    tagCommit: attestation.commit,
  }).ok, true)
  assert.throws(() => verifyExternalReleaseAttestation(attestation, {
    ...expected,
    commitTree: '2'.repeat(40),
    resolvedTagObject: attestation.tagObject,
    tagObjectType: 'tag',
    tagCommit: attestation.commit,
  }), /immutable_git_attestation_readback_mismatch/)
  assert.throws(() => verifyExternalReleaseAttestation({ ...attestation, tag: 'v105-mt-api-primary.0' }, expected), /attestation_tag_mismatch/)
  assert.throws(() => verifyExternalReleaseAttestation({ ...attestation, tree: '2'.repeat(40) }, expected), /attestation_tree_mismatch/)
  assert.equal(verifyExternalReleaseAttestation({
    ...attestation,
    images: { ...attestation.images, worker: { ...attestation.images.worker, readbackDigest: `sha256:${'9'.repeat(64)}` } },
  }, expected).ok, true, 'external attestation image fields are untrusted and outside this Git/digest verifier')
})

test('Reviewer P1 canonical external attestation path rejects drive-letter case aliases and in-repo junction targets', async () => {
  assert.equal(typeof releaseVerifier.assertExternalAttestationPath, 'function')
  const realpaths = new Map([
    ['D:\\Repo', 'D:\\Repo'],
    ['d:\\repo\\outside-looking.json', 'd:\\repo\\outside-looking.json'],
    ['D:\\outside\\junction.json', 'D:\\Repo\\release\\attestation.json'],
  ])
  const realpathImpl = async (value) => {
    const resolved = realpaths.get(String(value))
    if (!resolved) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    return resolved
  }
  await assert.rejects(releaseVerifier.assertExternalAttestationPath({
    repoRoot: 'D:\\Repo', attestationPath: 'd:\\repo\\outside-looking.json', realpathImpl, pathApi: path.win32,
  }), /attestation_must_be_external/)
  await assert.rejects(releaseVerifier.assertExternalAttestationPath({
    repoRoot: 'D:\\Repo', attestationPath: 'D:\\outside\\junction.json', realpathImpl, pathApi: path.win32,
  }), /attestation_must_be_external/)
  await assert.rejects(releaseVerifier.assertExternalAttestationPath({
    repoRoot: 'D:\\Repo', attestationPath: 'D:\\outside\\missing.json', realpathImpl, pathApi: path.win32,
  }), /attestation_realpath_unavailable/)
})

test('Reviewer P1 Git tree digest stays bound to index blobs and dirty working tree is rejected', async (t) => {
  assert.equal(typeof releaseVerifier.computeGitTreePathSetDigest, 'function')
  assert.equal(typeof releaseVerifier.assertCandidateIndexClean, 'function')
  const root = await mkdtemp(path.join(tmpdir(), 'darven-git-tree-digest-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' })
  await mkdir(path.join(root, 'src'), { recursive: true })
  await writeFile(path.join(root, 'src', 'value.js'), 'export const value = "A"\n')
  execFileSync('git', ['add', 'src/value.js'], { cwd: root })
  const treeA = execFileSync('git', ['write-tree'], { cwd: root, encoding: 'utf8' }).trim()
  const indexA = await releaseVerifier.computeGitTreePathSetDigest(root, treeA, { paths: ['src'], excludedPaths: [] })

  await writeFile(path.join(root, 'src', 'value.js'), 'export const value = "B"\n')
  const stillIndexA = await releaseVerifier.computeGitTreePathSetDigest(root, treeA, { paths: ['src'], excludedPaths: [] })
  assert.deepEqual(stillIndexA, indexA, 'digest must read tree/index blobs, never working-tree bytes')
  assert.throws(() => releaseVerifier.assertCandidateIndexClean(root, treeA), /working_tree_differs_from_index/)

  execFileSync('git', ['add', 'src/value.js'], { cwd: root })
  assert.throws(() => releaseVerifier.assertCandidateIndexClean(root, treeA), /index_differs_from_candidate_tree/)
  const treeB = execFileSync('git', ['write-tree'], { cwd: root, encoding: 'utf8' }).trim()
  assert.equal(releaseVerifier.assertCandidateIndexClean(root, treeB).ok, true)
  await writeFile(path.join(root, 'src', 'untracked.js'), 'export const untracked = true\n')
  assert.throws(() => releaseVerifier.assertCandidateIndexClean(root, treeB), /untracked_files_outside_candidate_index/)
})

test('Reviewer P1 trusted image evidence rejects self-attestation and requires independent exact builder plus registry provenance', async () => {
  assert.equal(typeof releaseVerifier.verifyTrustedImageEvidence, 'function')
  assert.equal(typeof releaseVerifier.parseReleaseEvidenceArgs, 'function')
  assert.equal(typeof releaseVerifier.verifyTrustedEvidenceContract, 'function')
  assert.deepEqual(releaseVerifier.verifyTrustedEvidenceContract(manifest.releaseBinding), {
    ok: true, phase: 'post-build-pre-cutover', adapter: 'scripts/trusted-registry-readback-adapter.mjs',
  })
  const adapterOmitted = structuredClone(manifest.releaseBinding)
  adapterOmitted.implementationTree.paths = adapterOmitted.implementationTree.paths.filter((item) => item !== adapterOmitted.attestation.fixedRegistryAdapter)
  assert.throws(() => releaseVerifier.verifyTrustedEvidenceContract(adapterOmitted), /trusted_image_evidence_contract_incomplete/)
  const arbitraryReadback = structuredClone(manifest.releaseBinding)
  arbitraryReadback.attestation.arbitraryReadbackJsonRejected = false
  assert.throws(() => releaseVerifier.verifyTrustedEvidenceContract(arbitraryReadback), /trusted_image_evidence_contract_incomplete/)
  const commit = '1'.repeat(40)
  const tree = '2'.repeat(40)
  const proxyInput = '3'.repeat(64)
  const workerInput = '4'.repeat(64)
  const proxyDigest = `sha256:${'5'.repeat(64)}`
  const workerDigest = `sha256:${'6'.repeat(64)}`
  const expected = { commit, tree, proxyBuildInputSha256: proxyInput, workerBuildInputSha256: workerInput }
  const buildReceipts = {
    receipts: [
      {
        role: 'proxy', provenance: 'trusted-builder', receiptId: 'build-proxy-001', commit, tree,
        buildInputSha256: proxyInput, imageRef: 'registry.example/darven/proxy:v105', imageDigest: proxyDigest,
      },
      {
        role: 'worker', provenance: 'trusted-builder', receiptId: 'build-worker-001', commit, tree,
        buildInputSha256: workerInput, imageRef: 'registry.example/darven/worker:v105', imageDigest: workerDigest,
      },
    ],
  }
  const registry = {
    proxy: {
      role: 'proxy', provenance: 'trusted-registry-adapter', receiptId: 'registry-proxy-001',
      imageRef: 'registry.example/darven/proxy:v105', imageDigest: proxyDigest,
    },
    worker: {
      role: 'worker', provenance: 'trusted-registry-adapter', receiptId: 'registry-worker-001',
      imageRef: 'registry.example/darven/worker:v105', imageDigest: workerDigest,
    },
  }
  const trustedReadback = async ({ role }) => structuredClone(registry[role])

  assert.deepEqual(
    await releaseVerifier.verifyTrustedImageEvidence({ buildReceipts, expected, trustedReadback }),
    { ok: true, images: { proxy: { imageRef: registry.proxy.imageRef, imageDigest: proxyDigest }, worker: { imageRef: registry.worker.imageRef, imageDigest: workerDigest } } },
  )
  const external = {
    commit, tree, tagObject: '7'.repeat(40), tag: manifest.gitTag,
    implementationTreeSha256: '8'.repeat(64), migrationSha256: '9'.repeat(64),
    shadowHydrationMigrationSha256: 'd'.repeat(64),
    shadowV10MigrationSha256: 'e'.repeat(64), shadowV10DbValidationMigrationSha256: 'c'.repeat(64),
    rankLedgerRecoveryMigrationSha256: 'b'.repeat(64),
    rankSyncHydrationMigrationSha256: 'a'.repeat(64),
    shadowV6V8RetirementMigrationSha256: 'f'.repeat(64),
    proxyBuildInputSha256: proxyInput, workerBuildInputSha256: workerInput,
    images: {
      proxy: { expectedDigest: proxyDigest, readbackDigest: proxyDigest },
      worker: { expectedDigest: workerDigest, readbackDigest: workerDigest },
    },
  }
  assert.equal(verifyExternalReleaseAttestation(external, {
    gitTag: manifest.gitTag, candidateIndexTree: tree,
    implementationTreeSha256: external.implementationTreeSha256, migrationSha256: external.migrationSha256,
    shadowHydrationMigrationSha256: external.shadowHydrationMigrationSha256,
    shadowV10MigrationSha256: external.shadowV10MigrationSha256,
    shadowV10DbValidationMigrationSha256: external.shadowV10DbValidationMigrationSha256,
    rankLedgerRecoveryMigrationSha256: external.rankLedgerRecoveryMigrationSha256,
    rankSyncHydrationMigrationSha256: external.rankSyncHydrationMigrationSha256,
    shadowV6V8RetirementMigrationSha256: external.shadowV6V8RetirementMigrationSha256,
    proxyBuildInputSha256: proxyInput, workerBuildInputSha256: workerInput,
  }).ok, true, 'external Git attestation no longer self-approves images')
  await assert.rejects(
    releaseVerifier.verifyTrustedImageEvidence({ buildReceipts: null, expected, trustedReadback }),
    /trusted_build_receipts_required/,
  )

  const mutate = (role, patch) => ({
    receipts: buildReceipts.receipts.map((receipt) => receipt.role === role ? { ...receipt, ...patch } : receipt),
  })
  for (const [label, receipts] of [
    ['wrong commit', mutate('proxy', { commit: 'a'.repeat(40) })],
    ['wrong tree', mutate('proxy', { tree: 'b'.repeat(40) })],
    ['wrong input', mutate('proxy', { buildInputSha256: 'c'.repeat(64) })],
    ['missing field', mutate('proxy', { imageRef: '' })],
  ]) {
    await assert.rejects(
      releaseVerifier.verifyTrustedImageEvidence({ buildReceipts: receipts, expected, trustedReadback }),
      /trusted_build_receipt_.*(?:mismatch|invalid)/,
      label,
    )
  }
  await assert.rejects(releaseVerifier.verifyTrustedImageEvidence({
    buildReceipts, expected,
    trustedReadback: async ({ role }) => ({ ...registry[role], receiptId: buildReceipts.receipts.find((item) => item.role === role).receiptId }),
  }), /trusted_image_receipt_id_not_independent/)
  await assert.rejects(releaseVerifier.verifyTrustedImageEvidence({
    buildReceipts, expected,
    trustedReadback: async ({ role }) => ({ ...registry[role], provenance: 'trusted-builder' }),
  }), /trusted_image_provenance_not_independent/)
  await assert.rejects(releaseVerifier.verifyTrustedImageEvidence({
    buildReceipts, expected,
    trustedReadback: async ({ role }) => ({ ...registry[role], imageRef: `${registry[role].imageRef}-wrong` }),
  }), /trusted_image_ref_mismatch/)
  await assert.rejects(releaseVerifier.verifyTrustedImageEvidence({
    buildReceipts, expected,
    trustedReadback: async ({ role }) => ({ ...registry[role], imageDigest: `sha256:${'d'.repeat(64)}` }),
  }), /trusted_image_digest_mismatch/)

  assert.throws(() => releaseVerifier.parseReleaseEvidenceArgs(['--attestation', 'a.json']), /build_receipts_file_required/)
  assert.throws(() => releaseVerifier.parseReleaseEvidenceArgs([
    '--attestation', 'a.json', '--build-receipts', 'b.json', '--registry-readback', 'self.json',
  ]), /unsupported_release_evidence_argument/)
  assert.deepEqual(
    releaseVerifier.parseReleaseEvidenceArgs(['--attestation', 'a.json', '--build-receipts', 'b.json']),
    { attestationPath: 'a.json', buildReceiptsPath: 'b.json' },
  )
  assert.equal(manifest.releaseBinding.attestation.phase, 'post-build-pre-cutover')
  assert.equal(manifest.releaseBinding.attestation.independentBuildReceiptsRequired, true)
  assert.equal(manifest.releaseBinding.attestation.fixedRegistryAdapterRequired, true)
})

test('Reviewer P1 fixed trusted registry adapter uses bounded shell-free argv and rejects secret-shaped registry data', async () => {
  let adapter = null
  try {
    adapter = await import('../../scripts/trusted-registry-readback-adapter.mjs')
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
  }
  assert.equal(typeof adapter?.readTrustedRegistryEvidence, 'function')
  const calls = []
  const result = adapter.readTrustedRegistryEvidence({
    role: 'proxy', imageRef: 'registry.example/darven/proxy:v105',
    execFile: (file, args, options) => {
      calls.push({ file, args, options })
      return Buffer.from('{}')
    },
  })
  assert.deepEqual(calls.map(({ file, args }) => ({ file, args })), [{
    file: 'docker', args: ['buildx', 'imagetools', 'inspect', '--raw', 'registry.example/darven/proxy:v105'],
  }])
  assert.equal(calls[0].options.shell, false)
  assert.equal(calls[0].options.maxBuffer, 4 * 1024 * 1024)
  assert.deepEqual(result, {
    role: 'proxy', provenance: 'trusted-registry-adapter',
    receiptId: 'registry-manifest-44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    imageRef: 'registry.example/darven/proxy:v105',
    imageDigest: 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
  })
  assert.throws(() => adapter.readTrustedRegistryEvidence({
    role: 'worker', imageRef: 'registry.example/darven/worker:v105',
    execFile: () => Buffer.from('{"token":"must-not-pass"}'),
  }), /registry_readback_secret_rejected/)
  assert.throws(() => adapter.readTrustedRegistryEvidence({
    role: 'worker', imageRef: 'registry.example/darven/worker:v105;calc.exe', execFile: () => Buffer.from('{}'),
  }), /registry_image_ref_invalid/)
})
