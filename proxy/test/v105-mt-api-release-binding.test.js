import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import predecessorManifest from '../../release/v105-v10-main22-source-fence-release-manifest.json' with { type: 'json' }
import successorManifest from '../../release/v105-v10-main26-formal-prediction-release-manifest.json' with { type: 'json' }
import {
  computePathSetDigest,
  materializeCurrentV105V10MainSuccessorManifest,
  verifyManifestDigests,
  verifyExternalReleaseAttestation,
} from '../../scripts/verify-v105-mt-api-release.mjs'
import * as releaseVerifier from '../../scripts/verify-v105-mt-api-release.mjs'

const manifest = materializeCurrentV105V10MainSuccessorManifest(successorManifest, predecessorManifest)

test('release scope freezes one existing session as API-only canonical capture', () => {
  assert.equal(manifest.releaseVersion, 'v105-v10-main.26')
  assert.equal(manifest.gitTag, 'v105-v10-main.26')
  assert.equal(manifest.applicationVersion, '1.0.65')
  assert.deepEqual(manifest.releaseScope, {
    mode: 'single-session-api-primary',
    canonicalSource: 'api',
    workerEnvironment: { MT_SOURCE_MODE: 'api', MT_CAPTURE_ROLE: 'canonical' },
    browserEnabled: false,
    backupReplayEnabled: false,
    recordContract: 'unverified',
    gapPolicy: 'fail-closed-stop-ack-and-alert',
    deferred: ['second-independent-session-backup', 'record-replay'],
    httpParentExternalConsumerIsolation: true,
    proxyChanged: true,
    workerChanged: false,
    captureWorkerChanged: false,
    formalConsumerChanged: true,
    frontendChanged: false,
  })
  assert.deepEqual(manifest.behavior, {
    predictionRulesChanged: false,
    predictionWeightsChanged: false,
    predictionThresholdsChanged: false,
    receiverOwnershipChanged: false,
    uiChanged: false,
    v6ToV9Changed: false,
    versionChanged: true,
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
  assert.deepEqual(manifest.shadowV9Isolation, {
    strategyVersion: 'v105-shadow-v9-weighted-v7-v8',
    runtimeFlag: 'V105_SHADOW_V9_ENABLED=true',
    childScope: 'v105-v9',
    separateFromRequired: true,
    separateFromV10: true,
    childDatabaseCredentials: false,
    writerTransport: 'parent-ipc',
    writerRequestValidation: 'method-schema-identity-size',
    writerMaxConcurrency: 4,
    writerPayloadMaxBytes: 262144,
    writerResultMaxBytes: 2097152,
    writerRequestIdValidation: 'strict-monotonic-high-water-per-generation',
    writerRequestIdStorage: 'constant-space-high-water',
    writerRequestIdsReusableWithinGeneration: false,
    ipcErrorRedaction: 'both-boundaries-uri-jwt-key',
    writerResponseDropObservable: true,
    shutdownWaitsForParentWrites: true,
    captureLane: 'bounded-best-effort',
    deliveryGuarantee: 'live-best-effort-no-retroactive-replay',
    failureAndDropCountsObservable: true,
    retroactiveReplayAllowed: false,
    maxQueuedCaptures: 2,
    maxQueuedIdentities: 2000,
    blocksFormalOutboxAck: false,
    counterMode: 'resume-existing',
    memberVisible: false,
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
  assert.equal(manifest.releaseBinding.sameSessionOutboxBatchMigration.path, 'supabase/migrations/20260824010000_v105_capture_outbox_same_session_batch.sql')
  assert.equal(manifest.releaseBinding.sameSessionOutboxBatchMigration.sha256, '76deb1c5113032afeab578dd2106abb55b07583690e4cb8e0e7de8ea0f5e1cfa')
  assert.equal(manifest.releaseBinding.shadowV6V8RetirementMigration.path, 'supabase/migrations/20260802020000_retire_v105_shadow_v6_v8.sql')
})

test('release manifest freezes current implementation, migration, proxy, and worker build inputs', async () => {
  const repoRoot = new URL('../../', import.meta.url)
  const candidateIndexTree = execFileSync('git', ['write-tree'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  const result = await verifyManifestDigests({ manifest, repoRoot, candidateIndexTree })
  assert.equal(result.ok, true)
  for (const [mutate, error] of [
    [(value) => { value.unexpected = true }, /release_manifest_keys_invalid/],
    [(value) => { value.releaseBinding.unexpected = true }, /release_binding_keys_invalid/],
    [(value) => { value.releaseBinding.implementationTree.unexpected = true }, /release_implementation_shape_invalid/],
    [(value) => { value.releaseBinding.migration.unexpected = true }, /release_migration_shape_invalid:migration/],
    [(value) => { value.releaseBinding.attestation.unexpected = true }, /release_attestation_shape_invalid/],
    [(value) => { value.adminSession.unexpected = true }, /release_nested_shape_invalid:adminSession/],
    [(value) => { value.database.sameSessionOutboxBatchMigration.unexpected = true }, /release_nested_shape_invalid:database\.sameSessionOutboxBatchMigration/],
    [(value) => { value.rollback.order[0].unexpected = true }, /release_rollback_order_shape_invalid/],
  ]) {
    const drifted = structuredClone(manifest)
    mutate(drifted)
    await assert.rejects(verifyManifestDigests({ manifest: drifted, repoRoot, candidateIndexTree }), error)
  }
  assert.match(manifest.releaseBinding.implementationTree.sha256, /^[a-f0-9]{64}$/)
  assert.match(manifest.releaseBinding.migration.sha256, /^[a-f0-9]{64}$/)
  assert.match(manifest.releaseBinding.proxyBuildInput.sha256, /^[a-f0-9]{64}$/)
  assert.match(manifest.releaseBinding.workerBuildInput.sha256, /^[a-f0-9]{64}$/)
  assert.equal(result.shadowHydrationMigrationSha256, manifest.releaseBinding.shadowHydrationMigration.sha256)
  assert.equal(result.captureOutboxHealthMigrationSha256, manifest.releaseBinding.captureOutboxHealthMigration.sha256)
  assert.equal(result.zeroFinalHeartbeatMigrationSha256, manifest.releaseBinding.zeroFinalHeartbeatMigration.sha256)
  assert.equal(result.sameSessionOutboxBatchMigrationSha256, manifest.releaseBinding.sameSessionOutboxBatchMigration.sha256)
  assert.equal(result.transportRebindMigrationSha256, manifest.releaseBinding.transportRebindMigration.sha256)
  assert.equal(result.formalConsumerBuildInputSha256, manifest.releaseBinding.formalConsumerBuildInput.sha256)
  const batchTampered = structuredClone(manifest)
  batchTampered.releaseBinding.sameSessionOutboxBatchMigration.sha256 = '0'.repeat(64)
  await assert.rejects(
    verifyManifestDigests({ manifest: batchTampered, repoRoot, candidateIndexTree }),
    /same_session_outbox_batch_migration_digest_mismatch/,
  )
  const duplicateOrder = structuredClone(manifest)
  duplicateOrder.deploymentOrder.unshift('proxy-compatible')
  await assert.rejects(
    verifyManifestDigests({ manifest: duplicateOrder, repoRoot, candidateIndexTree }),
    /same_session_outbox_batch_deployment_order_duplicate/,
  )
  const zeroFinalTampered = structuredClone(manifest)
  zeroFinalTampered.releaseBinding.zeroFinalHeartbeatMigration.sha256 = '0'.repeat(64)
  await assert.rejects(
    verifyManifestDigests({ manifest: zeroFinalTampered, repoRoot, candidateIndexTree }),
    /zero_final_heartbeat_migration_digest_mismatch/,
  )
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
    /release_rollback_order_shape_invalid/,
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
    captureOutboxHealthMigrationSha256: '9'.repeat(64),
    zeroFinalHeartbeatMigrationSha256: '8'.repeat(64),
    sameSessionOutboxBatchMigrationSha256: '7'.repeat(64),
    transportRebindMigrationSha256: '2'.repeat(64),
    shadowHydrationMigrationSha256: 'd'.repeat(64),
    shadowV10MigrationSha256: 'e'.repeat(64), shadowV10DbValidationMigrationSha256: 'c'.repeat(64),
    rankLedgerRecoveryMigrationSha256: 'b'.repeat(64),
    rankSyncHydrationMigrationSha256: 'a'.repeat(64),
    shadowV6V8RetirementMigrationSha256: 'f'.repeat(64),
    proxyBuildInputSha256: '5'.repeat(64), formalConsumerBuildInputSha256: '0'.repeat(64), workerBuildInputSha256: '6'.repeat(64),
    images: {
      proxy: { expectedDigest: `sha256:${'7'.repeat(64)}`, readbackDigest: `sha256:${'7'.repeat(64)}` },
      worker: { expectedDigest: `sha256:${'8'.repeat(64)}`, readbackDigest: `sha256:${'8'.repeat(64)}` },
    },
  }
  const expected = {
    implementationTreeSha256: '3'.repeat(64), migrationSha256: '4'.repeat(64),
    captureOutboxHealthMigrationSha256: '9'.repeat(64),
    zeroFinalHeartbeatMigrationSha256: '8'.repeat(64),
    sameSessionOutboxBatchMigrationSha256: '7'.repeat(64),
    transportRebindMigrationSha256: '2'.repeat(64),
    shadowHydrationMigrationSha256: 'd'.repeat(64),
    shadowV10MigrationSha256: 'e'.repeat(64), shadowV10DbValidationMigrationSha256: 'c'.repeat(64),
    rankLedgerRecoveryMigrationSha256: 'b'.repeat(64),
    rankSyncHydrationMigrationSha256: 'a'.repeat(64),
    shadowV6V8RetirementMigrationSha256: 'f'.repeat(64),
    proxyBuildInputSha256: '5'.repeat(64), formalConsumerBuildInputSha256: '0'.repeat(64), workerBuildInputSha256: '6'.repeat(64),
    commit: attestation.commit,
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
  assert.throws(() => verifyExternalReleaseAttestation({ ...attestation, commit: 'a'.repeat(40) }, expected), /attestation_commit_mismatch/)
  assert.throws(() => verifyExternalReleaseAttestation({ ...attestation, tag: 'v105-mt-api-primary.0' }, expected), /attestation_tag_mismatch/)
  assert.throws(() => verifyExternalReleaseAttestation({ ...attestation, tree: '2'.repeat(40) }, expected), /attestation_tree_mismatch/)
  assert.throws(() => verifyExternalReleaseAttestation({ ...attestation, sameSessionOutboxBatchMigrationSha256: '0'.repeat(64) }, expected), /attestation_sameSessionOutboxBatchMigrationSha256_mismatch/)
  const missingBatchDigest = { ...attestation }
  delete missingBatchDigest.sameSessionOutboxBatchMigrationSha256
  assert.throws(() => verifyExternalReleaseAttestation(missingBatchDigest, expected), /attestation_sameSessionOutboxBatchMigrationSha256_mismatch/)
  const missingTransportDigest = { ...attestation }
  delete missingTransportDigest.transportRebindMigrationSha256
  assert.throws(() => verifyExternalReleaseAttestation(missingTransportDigest, expected), /attestation_transportRebindMigrationSha256_mismatch/)
  const missingFormalConsumerDigest = { ...attestation }
  delete missingFormalConsumerDigest.formalConsumerBuildInputSha256
  assert.throws(() => verifyExternalReleaseAttestation(missingFormalConsumerDigest, expected), /attestation_formalConsumerBuildInputSha256_mismatch/)
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
  const formalConsumerInput = '0'.repeat(64)
  const workerInput = '4'.repeat(64)
  const proxyDigest = `sha256:${'5'.repeat(64)}`
  const formalConsumerDigest = `sha256:${'9'.repeat(64)}`
  const workerDigest = `sha256:${'6'.repeat(64)}`
  const sourceRef = 'refs/tags/v105-v10-main.26'
  const signerWorkflow = 'x0989285458-lgtm/darven-ai-baccarat-proxy/.github/workflows/trusted-release-images.yml'
  const expected = { commit, tree, proxyBuildInputSha256: proxyInput, formalConsumerBuildInputSha256: formalConsumerInput, workerBuildInputSha256: workerInput, sourceRef }
  const buildReceipts = {
    receipts: [
      {
        role: 'proxy', provenance: 'trusted-builder', receiptId: 'build-proxy-001', commit, tree,
        buildInputSha256: proxyInput, imageRef: `ghcr.io/x0989285458-lgtm/darven-ai-baccarat-proxy:${commit}`, imageDigest: proxyDigest,
      },
      {
        role: 'formal-consumer', provenance: 'trusted-builder', receiptId: 'build-formal-consumer-001', commit, tree,
        buildInputSha256: formalConsumerInput, imageRef: `ghcr.io/x0989285458-lgtm/darven-ai-baccarat-formal-consumer:${commit}`, imageDigest: formalConsumerDigest,
      },
      {
        role: 'worker', provenance: 'trusted-builder', receiptId: 'build-worker-001', commit, tree,
        buildInputSha256: workerInput, imageRef: `ghcr.io/x0989285458-lgtm/darven-ai-baccarat-worker:${commit}`, imageDigest: workerDigest,
      },
    ],
  }
  const registry = {
    proxy: {
      role: 'proxy', provenance: 'github-sigstore-attestation', receiptId: 'registry-proxy-001',
      imageRef: `ghcr.io/x0989285458-lgtm/darven-ai-baccarat-proxy:${commit}`, imageDigest: proxyDigest,
      immutableImageRef: `ghcr.io/x0989285458-lgtm/darven-ai-baccarat-proxy:${commit}@${proxyDigest}`,
      subjectName: 'ghcr.io/x0989285458-lgtm/darven-ai-baccarat-proxy', subjectDigest: proxyDigest,
      sourceDigest: commit, sourceRef, signerWorkflow,
    },
    'formal-consumer': {
      role: 'formal-consumer', provenance: 'github-sigstore-attestation', receiptId: 'registry-formal-consumer-001',
      imageRef: `ghcr.io/x0989285458-lgtm/darven-ai-baccarat-formal-consumer:${commit}`, imageDigest: formalConsumerDigest,
      immutableImageRef: `ghcr.io/x0989285458-lgtm/darven-ai-baccarat-formal-consumer:${commit}@${formalConsumerDigest}`,
      subjectName: 'ghcr.io/x0989285458-lgtm/darven-ai-baccarat-formal-consumer', subjectDigest: formalConsumerDigest,
      sourceDigest: commit, sourceRef, signerWorkflow,
    },
    worker: {
      role: 'worker', provenance: 'github-sigstore-attestation', receiptId: 'registry-worker-001',
      imageRef: `ghcr.io/x0989285458-lgtm/darven-ai-baccarat-worker:${commit}`, imageDigest: workerDigest,
      immutableImageRef: `ghcr.io/x0989285458-lgtm/darven-ai-baccarat-worker:${commit}@${workerDigest}`,
      subjectName: 'ghcr.io/x0989285458-lgtm/darven-ai-baccarat-worker', subjectDigest: workerDigest,
      sourceDigest: commit, sourceRef, signerWorkflow,
    },
  }
  const trustedReadback = async ({ role }) => structuredClone(registry[role])

  await assert.rejects(
    releaseVerifier.verifyTrustedImageEvidence({ buildReceipts, expected, trustedReadback }),
    /trusted_registry_readback_invalid/,
    'caller-controlled readback cannot acquire the module-private fixed-adapter capability',
  )
  const proxyForgedReadback = async ({ role }) => new Proxy(structuredClone(registry[role]), {
    get(target, key, receiver) {
      return typeof key === 'symbol' ? true : Reflect.get(target, key, receiver)
    },
  })
  await assert.rejects(
    releaseVerifier.verifyTrustedImageEvidence({ buildReceipts, expected, trustedReadback: proxyForgedReadback }),
    /trusted_registry_readback_invalid/,
    'a Proxy get trap cannot forge WeakSet object identity',
  )
  const originalWeakSetHas = WeakSet.prototype.has
  try {
    WeakSet.prototype.has = () => true
    await assert.rejects(
      releaseVerifier.verifyTrustedImageEvidence({ buildReceipts, expected, trustedReadback: proxyForgedReadback }),
      /trusted_registry_readback_invalid/,
      'prototype poisoning cannot replace the module-bound WeakSet identity check',
    )
  } finally {
    WeakSet.prototype.has = originalWeakSetHas
  }
  await assert.rejects(releaseVerifier.verifyTrustedImageEvidence({
    buildReceipts: { receipts: buildReceipts.receipts.filter((receipt) => receipt.role !== 'formal-consumer') }, expected, trustedReadback,
  }), /trusted_build_receipt_role_invalid:formal-consumer/)
  const planImages = ['proxy', 'formal-consumer', 'worker'].map((role) => ({
    role,
    imageDigest: `sha256:${role === 'proxy' ? 'a' : role === 'formal-consumer' ? 'b' : 'c'}`.padEnd(71, role === 'proxy' ? 'a' : role === 'formal-consumer' ? 'b' : 'c'),
  })).map((image) => ({
    ...image,
    immutableImageRef: `ghcr.io/x0989285458-lgtm/darven-ai-baccarat-${image.role === 'proxy' ? 'proxy' : image.role}@${image.imageDigest}`,
  }))
  const deploymentPlan = releaseVerifier.buildDeploymentPlan(planImages)
  assert.deepEqual(deploymentPlan, [{
    role: 'proxy',
    target: 'render:darven-ai-baccarat-api',
    immutableImageRef: planImages[0].immutableImageRef,
    imageDigest: planImages[0].imageDigest,
    requiredProviderReadback: true,
  }])
  assert.throws(() => releaseVerifier.buildDeploymentPlan({ ...planImages }), /deployment_plan_images_invalid/)
  assert.throws(() => releaseVerifier.buildDeploymentPlan([planImages[1], planImages[0], planImages[2]]), /deployment_plan_images_invalid/)
  const external = {
    commit, tree, tagObject: '7'.repeat(40), tag: manifest.gitTag,
    implementationTreeSha256: '8'.repeat(64), migrationSha256: '9'.repeat(64),
    captureOutboxHealthMigrationSha256: '1'.repeat(64),
    zeroFinalHeartbeatMigrationSha256: '2'.repeat(64),
    sameSessionOutboxBatchMigrationSha256: '3'.repeat(64),
    transportRebindMigrationSha256: '7'.repeat(64),
    shadowHydrationMigrationSha256: 'd'.repeat(64),
    shadowV10MigrationSha256: 'e'.repeat(64), shadowV10DbValidationMigrationSha256: 'c'.repeat(64),
    rankLedgerRecoveryMigrationSha256: 'b'.repeat(64),
    rankSyncHydrationMigrationSha256: 'a'.repeat(64),
    shadowV6V8RetirementMigrationSha256: 'f'.repeat(64),
    proxyBuildInputSha256: proxyInput, formalConsumerBuildInputSha256: '0'.repeat(64), workerBuildInputSha256: workerInput,
    images: {
      proxy: { expectedDigest: proxyDigest, readbackDigest: proxyDigest },
      worker: { expectedDigest: workerDigest, readbackDigest: workerDigest },
    },
  }
  assert.equal(verifyExternalReleaseAttestation(external, {
    commit, gitTag: manifest.gitTag, candidateIndexTree: tree,
    implementationTreeSha256: external.implementationTreeSha256, migrationSha256: external.migrationSha256,
    captureOutboxHealthMigrationSha256: external.captureOutboxHealthMigrationSha256,
    zeroFinalHeartbeatMigrationSha256: external.zeroFinalHeartbeatMigrationSha256,
    sameSessionOutboxBatchMigrationSha256: external.sameSessionOutboxBatchMigrationSha256,
    transportRebindMigrationSha256: external.transportRebindMigrationSha256,
    shadowHydrationMigrationSha256: external.shadowHydrationMigrationSha256,
    shadowV10MigrationSha256: external.shadowV10MigrationSha256,
    shadowV10DbValidationMigrationSha256: external.shadowV10DbValidationMigrationSha256,
    rankLedgerRecoveryMigrationSha256: external.rankLedgerRecoveryMigrationSha256,
    rankSyncHydrationMigrationSha256: external.rankSyncHydrationMigrationSha256,
    shadowV6V8RetirementMigrationSha256: external.shadowV6V8RetirementMigrationSha256,
    proxyBuildInputSha256: proxyInput, formalConsumerBuildInputSha256: external.formalConsumerBuildInputSha256, workerBuildInputSha256: workerInput,
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
  }), /trusted_registry_readback_invalid/)
  await assert.rejects(releaseVerifier.verifyTrustedImageEvidence({
    buildReceipts, expected,
    trustedReadback: async ({ role }) => ({ ...registry[role], provenance: 'trusted-builder' }),
  }), /trusted_registry_readback_invalid/)
  await assert.rejects(releaseVerifier.verifyTrustedImageEvidence({
    buildReceipts, expected,
    trustedReadback: async ({ role }) => ({ ...registry[role], sourceDigest: 'f'.repeat(40) }),
  }), /trusted_registry_readback_invalid/)
  await assert.rejects(releaseVerifier.verifyTrustedImageEvidence({
    buildReceipts, expected,
    trustedReadback: async ({ role }) => ({ ...registry[role], signerWorkflow: 'attacker/repo/.github/workflows/forge.yml' }),
  }), /trusted_registry_readback_invalid/)
  await assert.rejects(releaseVerifier.verifyTrustedImageEvidence({
    buildReceipts, expected,
    trustedReadback: async ({ role }) => ({ ...registry[role], imageRef: `${registry[role].imageRef}-wrong` }),
  }), /trusted_registry_readback_invalid/)
  await assert.rejects(releaseVerifier.verifyTrustedImageEvidence({
    buildReceipts, expected,
    trustedReadback: async ({ role }) => ({ ...registry[role], imageDigest: `sha256:${'d'.repeat(64)}` }),
  }), /trusted_registry_readback_invalid/)

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
  assert.equal(manifest.releaseBinding.attestation.cryptographicProvenanceRequired, true)
  assert.equal(manifest.releaseBinding.attestation.provenanceProvider, 'github-sigstore-attestation')
  assert.equal(manifest.releaseBinding.attestation.signerWorkflow, signerWorkflow)
  assert.equal(manifest.releaseBinding.attestation.sourceRef, sourceRef)
  assert.equal(manifest.releaseBinding.attestation.denySelfHostedRunners, true)
  assert.equal(manifest.releaseBinding.implementationTree.paths.includes('.github/workflows/trusted-release-images.yml'), true)
  assert.deepEqual(manifest.releaseBinding.attestation.requiredImageRoles, ['proxy', 'formal-consumer', 'worker'])
})

test('Reviewer P1 fixed trusted registry adapter binds role, immutable digest, and Sigstore subject with bounded shell-free argv', async () => {
  const adapter = await import('../../scripts/trusted-registry-readback-adapter.mjs')
  assert.equal(typeof adapter.readTrustedRegistryEvidence, 'function')
  const calls = []
  const sourceDigest = '1'.repeat(40)
  const sourceRef = 'refs/tags/v105-v10-main.26'
  const signerWorkflow = 'x0989285458-lgtm/darven-ai-baccarat-proxy/.github/workflows/trusted-release-images.yml'
  const digestHex = '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a'
  const imageDigest = `sha256:${digestHex}`
  const proxyRepository = 'ghcr.io/x0989285458-lgtm/darven-ai-baccarat-proxy'
  const proxyImageRef = `${proxyRepository}:${sourceDigest}`
  const attestationFor = (repository, digest = digestHex) => JSON.stringify([{
    verificationResult: { statement: { subject: [{ name: repository, digest: { sha256: digest } }] } },
  }])
  const execFile = (file, args, options) => {
    calls.push({ file, args, options })
    return Buffer.from(file === 'docker' ? '{}' : attestationFor(proxyRepository))
  }
  const result = adapter.readTrustedRegistryEvidence({ role: 'proxy', imageRef: proxyImageRef, sourceDigest, sourceRef, execFile })
  assert.deepEqual(calls.map(({ file, args }) => ({ file, args })), [
    { file: 'docker', args: ['buildx', 'imagetools', 'inspect', '--raw', proxyImageRef] },
    { file: 'gh', args: [
      'attestation', 'verify', `oci://${proxyRepository}@${imageDigest}`,
      '--repo', 'x0989285458-lgtm/darven-ai-baccarat-proxy',
      '--signer-workflow', signerWorkflow,
      '--source-digest', sourceDigest,
      '--source-ref', sourceRef,
      '--deny-self-hosted-runners', '--format', 'json',
    ] },
  ])
  assert.equal(calls.every((call) => call.options.shell === false), true)
  assert.deepEqual(result, {
    role: 'proxy', provenance: 'github-sigstore-attestation',
    receiptId: `github-attestation-${digestHex}`,
    imageRef: proxyImageRef, imageDigest,
    immutableImageRef: `${proxyRepository}@${imageDigest}`,
    subjectName: proxyRepository, subjectDigest: imageDigest,
    sourceDigest, sourceRef, signerWorkflow,
  })

  const formalRepository = 'ghcr.io/x0989285458-lgtm/darven-ai-baccarat-formal-consumer'
  const formalImageRef = `${formalRepository}:${sourceDigest}`
  const formalResult = adapter.readTrustedRegistryEvidence({
    role: 'formal-consumer', imageRef: formalImageRef, sourceDigest, sourceRef,
    execFile: (file) => Buffer.from(file === 'docker' ? '{}' : attestationFor(formalRepository)),
  })
  assert.equal(formalResult.subjectName, formalRepository)
  assert.throws(() => adapter.readTrustedRegistryEvidence({
    role: 'proxy', imageRef: formalImageRef, sourceDigest, sourceRef, execFile,
  }), /registry_image_ref_invalid/)
  assert.throws(() => adapter.readTrustedRegistryEvidence({
    role: 'proxy', imageRef: proxyImageRef, sourceDigest, sourceRef,
    execFile: (file) => Buffer.from(file === 'docker' ? '{}' : attestationFor(formalRepository)),
  }), /github_attestation_subject_mismatch/)
  assert.throws(() => adapter.readTrustedRegistryEvidence({
    role: 'proxy', imageRef: proxyImageRef, sourceDigest, sourceRef,
    execFile: (file) => Buffer.from(file === 'docker' ? '{}' : attestationFor(proxyRepository, 'f'.repeat(64))),
  }), /github_attestation_subject_mismatch/)
  assert.throws(() => adapter.readTrustedRegistryEvidence({
    role: 'worker', imageRef: `ghcr.io/x0989285458-lgtm/darven-ai-baccarat-worker:${sourceDigest}`, sourceDigest, sourceRef,
    execFile: () => Buffer.from('{"token":"must-not-pass"}'),
  }), /registry_readback_secret_rejected/)
  assert.throws(() => adapter.readTrustedRegistryEvidence({
    role: 'worker', imageRef: `ghcr.io/x0989285458-lgtm/darven-ai-baccarat-worker:${sourceDigest}`, sourceDigest, sourceRef: 'refs/heads/main', execFile,
  }), /registry_source_ref_invalid/)
  assert.throws(() => adapter.readTrustedRegistryEvidence({
    role: 'proxy', imageRef: proxyImageRef, sourceDigest, sourceRef,
    execFile: (file) => Buffer.from(file === 'docker' ? '{}' : '[]'),
  }), /github_attestation_missing/)

  const tempRepo = await mkdtemp(path.join(tmpdir(), 'adapter-materialization-'))
  try {
    execFileSync('git', ['init'], { cwd: tempRepo })
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: tempRepo })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: tempRepo })
    await mkdir(path.join(tempRepo, 'scripts'), { recursive: true })
    const candidateSource = 'export const source = "candidate"\n'
    const mutableSource = 'export const source = "tampered-working-tree"\n'
    const candidatePath = path.join(tempRepo, 'scripts', 'trusted-registry-readback-adapter.mjs')
    await writeFile(candidatePath, candidateSource)
    execFileSync('git', ['add', 'scripts/trusted-registry-readback-adapter.mjs'], { cwd: tempRepo })
    const candidateTree = execFileSync('git', ['write-tree'], { cwd: tempRepo, encoding: 'utf8' }).trim()
    await writeFile(candidatePath, mutableSource)
    const loaded = releaseVerifier.loadCandidateAdapterSource(tempRepo, candidateTree)
    assert.equal(Buffer.from(loaded.sourceBase64, 'base64').toString('utf8'), candidateSource)
    assert.match(loaded.sha256, /^[a-f0-9]{64}$/)
    assert.equal(Object.isFrozen(loaded), true)
  } finally {
    await rm(tempRepo, { recursive: true, force: true })
  }
})
