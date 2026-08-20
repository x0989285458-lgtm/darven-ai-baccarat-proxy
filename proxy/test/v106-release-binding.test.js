import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { execFileSync, spawnSync } from 'node:child_process'
import manifest from '../../release/v106-formal-v10-main-release-manifest.json' with { type: 'json' }
import report from '../../release/v106-formal-v10-main-report.json' with { type: 'json' }
import {
  resolveAnnotatedTagCommit,
  verifyV106Attestation,
  verifyV106DatabaseArtifactContracts,
  verifyV106ManifestDigests,
  verifyV106PredecessorRegression,
  verifyV106StagedDeployableCoverage,
} from '../../scripts/verify-v106-formal-release.mjs'

const repoRoot = path.resolve(import.meta.dirname, '../..')

test('v106 verifier CLI requires external attestation unless explicit pre-commit digest-only mode is selected', () => {
  const candidateIndexTree = execFileSync('git', ['write-tree'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  const missing = spawnSync(process.execPath, ['scripts/verify-v106-formal-release.mjs', '--candidate-index-tree', candidateIndexTree], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  assert.notEqual(missing.status, 0)
  assert.match(missing.stderr, /attestation_required/)
  const output = execFileSync(process.execPath, ['scripts/verify-v106-formal-release.mjs', '--candidate-index-tree', candidateIndexTree, '--digests-only'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  const result = JSON.parse(output)
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'precommit-digests-only')
  assert.equal(result.releaseAuthorized, false)
  assert.equal(result.candidateIndexTree, candidateIndexTree)
})

test('v106 full release manifest binds the exact staged implementation, build inputs, and database cutover', async () => {
  const candidateIndexTree = execFileSync('git', ['write-tree'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  const result = await verifyV106ManifestDigests({ manifest, candidateIndexTree, root: repoRoot })
  assert.equal(result.ok, true)
  assert.equal(report.releaseVersion, manifest.releaseVersion)
  assert.match(report.status, /formal14/)
  assert.doesNotMatch(report.status, /formal5/)
  assert.deepEqual(Object.keys(result.digests).sort(), [
    'databaseCutoverInput', 'frontendBuildInput', 'implementationTree', 'proxyBuildInput', 'workerBuildInput',
  ])
  assert.equal(manifest.releaseScope.workerBehaviorChanged, true)
  assert.equal(manifest.releaseScope.workerProtocolChanged, false)
  assert.equal(manifest.inheritedProductionSafety.unchangedWorkerNotRestartedDuringStrategyCutover, false)
  assert.equal(manifest.inheritedProductionSafety.workerLeaseRenewalArmedBeforeApiStartup, true)
  const predecessor = verifyV106PredecessorRegression({ manifest, candidateIndexTree, root: repoRoot })
  assert.equal(predecessor.sourceSha256, manifest.predecessorRegression.sourceSha256)
  const tamperedPredecessor = structuredClone(manifest)
  tamperedPredecessor.predecessorRegression.sourceSha256 = '0'.repeat(64)
  assert.throws(
    () => verifyV106PredecessorRegression({ manifest: tamperedPredecessor, candidateIndexTree, root: repoRoot }),
    /predecessor_regression_source_mismatch/,
  )
  for (const required of ['implementationTree', 'proxyBuildInput', 'frontendBuildInput', 'workerBuildInput', 'databaseCutoverInput']) {
    const incomplete = structuredClone(manifest)
    delete incomplete.releaseBinding[required]
    await assert.rejects(
      verifyV106ManifestDigests({ manifest: incomplete, candidateIndexTree, root: repoRoot }),
      new RegExp(`release_binding_missing:${required}`),
    )
  }
  const uncovered = structuredClone(manifest)
  uncovered.releaseBinding.implementationTree.paths = uncovered.releaseBinding.implementationTree.paths.filter((item) => item !== 'proxy/src')
  assert.throws(
    () => verifyV106StagedDeployableCoverage({ manifest: uncovered, stagedPaths: ['proxy/src/unbound-deployable.js'] }),
    /release_deployable_out_of_binding:implementationTree:proxy\/src\/unbound-deployable\.js/,
  )
  assert.deepEqual(manifest.rollback.componentCommits, {
    proxy: '6bdd39e8c241c6d9341229d20bb5e281022c7d58',
    frontend: '4a6b4bc8b4ab8357dfefdf738f73d41adc520bf0',
    worker: '6bdd39e8c241c6d9341229d20bb5e281022c7d58',
  })
  assert.deepEqual(manifest.rollback.componentPackages, {
    proxy: { name: 'draven-mt-data-proxy-v105', version: '1.0.62' },
    frontend: { name: 'darven-ai-baccarat-frontend', version: '1.0.60' },
    worker: { name: 'darven-cloud-browser-worker', version: '1.0.62' },
  })
  assert.deepEqual(manifest.rollback.componentBuilds, {
    proxy: { buildVersion: 'v105', strategyVersion: 'v105', workerProtocol: 'v105' },
    frontend: { buildVersion: 'v105', strategyVersion: 'v105', workerProtocol: 'v105' },
    worker: { buildVersion: '105', strategyVersion: 'v105', workerProtocol: 'v105' },
  })
  assert.equal(manifest.rollback.componentVerification.allCommitsAreAncestorsOfReleaseBase, true)
  assert.equal(manifest.testRunners.worker, 'scripts/run-worker-tests-scrubbed.mjs')
  assert.deepEqual(report.releaseBindingDigests, Object.fromEntries(
    Object.entries(manifest.releaseBinding).map(([name, binding]) => [name, binding.sha256]),
  ))
  assert.equal(report.versionMatrix.proxy.packageVersion, manifest.applicationVersion)
  assert.equal(report.versionMatrix.frontend.buildVersion, manifest.frontendBuildVersion)
  assert.equal(report.versionMatrix.worker.workerProtocol, manifest.protocolVersion)
  assert.deepEqual(
    Object.fromEntries(Object.entries(report.rollbackComponents).filter(([, value]) => value?.commit).map(([name, value]) => [name, value.commit])),
    manifest.rollback.componentCommits,
  )
})

test('v106 coverage fails closed when any mandatory database cutover artifact is omitted from every binding', () => {
  const requiredArtifacts = [
    'supabase/migrations/20260818010000_v106_formal_v10_main.sql',
    'supabase/migrations/20260820003500_v106_formal8_final_time_fence.sql',
    'supabase/migrations/20260820010000_v106_formal12_bounded_raw_ack.sql',
    'supabase/migrations/20260820020000_v106_formal13_monotonic_projection.sql',
    'supabase/operations/fence_v105_new_issuance.sql',
    'supabase/operations/terminalize_v105_cutover.sql',
    'supabase/operations/activate_v106_promotion.sql',
    'supabase/operations/finalize_v106_promotion.sql',
    'supabase/operations/terminalize_v106_rollback.sql',
    'supabase/operations/rollback_v106_to_v105.sql',
  ]
  for (const artifact of requiredArtifacts) {
    const incomplete = structuredClone(manifest)
    for (const binding of Object.values(incomplete.releaseBinding)) {
      binding.paths = binding.paths.filter((candidatePath) => candidatePath !== artifact)
    }
    assert.throws(
      () => verifyV106StagedDeployableCoverage({ manifest: incomplete, stagedPaths: [] }),
      new RegExp(`release_required_artifact_unbound:${artifact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      artifact,
    )
  }
})

test('v106 database contracts bind every cutover step to one exact Git blob', () => {
  const candidateIndexTree = execFileSync('git', ['write-tree'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  assert.equal(verifyV106DatabaseArtifactContracts({ manifest, candidateIndexTree, root: repoRoot }).ok, true)

  const missing = structuredClone(manifest)
  delete missing.databaseArtifacts.rollbackTerminalize
  assert.throws(
    () => verifyV106DatabaseArtifactContracts({ manifest: missing, candidateIndexTree, root: repoRoot }),
    /database_artifact_contract_missing:rollbackTerminalize/,
  )

  const wrongStep = structuredClone(manifest)
  wrongStep.databaseArtifacts.activate.deploymentStep = 'proxy'
  assert.throws(
    () => verifyV106DatabaseArtifactContracts({ manifest: wrongStep, candidateIndexTree, root: repoRoot }),
    /database_artifact_step_mismatch:activate/,
  )

  const wrongBlob = structuredClone(manifest)
  wrongBlob.databaseArtifacts.finalize.gitBlobSha1 = '0'.repeat(40)
  assert.throws(
    () => verifyV106DatabaseArtifactContracts({ manifest: wrongBlob, candidateIndexTree, root: repoRoot }),
    /database_artifact_blob_mismatch:finalize/,
  )

  const unsafeRollbackOrder = structuredClone(manifest)
  unsafeRollbackOrder.rollback.order = [
    'run rollback SQL',
    'run bound v106 rollback terminalization and isolate active outbox evidence',
    'stop producer admission',
    ...manifest.rollback.order.slice(3),
  ]
  assert.throws(
    () => verifyV106DatabaseArtifactContracts({ manifest: unsafeRollbackOrder, candidateIndexTree, root: repoRoot }),
    /database_rollback_order_mismatch/,
  )

  const omittedRollbackTerminalizer = structuredClone(manifest)
  omittedRollbackTerminalizer.rollback.order = manifest.rollback.order.filter((step) => step !== 'run bound v106 rollback terminalization and isolate active outbox evidence')
  assert.throws(
    () => verifyV106DatabaseArtifactContracts({ manifest: omittedRollbackTerminalizer, candidateIndexTree, root: repoRoot }),
    /database_rollback_order_mismatch/,
  )
})

test('v106 release authorization rejects lightweight tags and resolves annotated tags', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'v106-annotated-tag-'))
  try {
    execFileSync('git', ['init', '-q'], { cwd: directory })
    await writeFile(path.join(directory, 'README.md'), 'release\n')
    execFileSync('git', ['add', 'README.md'], { cwd: directory })
    execFileSync('git', ['-c', 'user.name=Hermes Verify', '-c', 'user.email=verify@example.invalid', 'commit', '-qm', 'release'], { cwd: directory })
    execFileSync('git', ['tag', 'v-test'], { cwd: directory })
    assert.throws(() => resolveAnnotatedTagCommit({ tagName: 'v-test', root: directory }), /annotated_tag_required/)
    execFileSync('git', ['tag', '-d', 'v-test'], { cwd: directory, stdio: 'ignore' })
    execFileSync('git', ['-c', 'user.name=Hermes Verify', '-c', 'user.email=verify@example.invalid', 'tag', '-am', 'verified release', 'v-test'], { cwd: directory })
    assert.match(resolveAnnotatedTagCommit({ tagName: 'v-test', root: directory }), /^[a-f0-9]{40}$/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('v106 external attestation requires the exact complete release digest set before tag readback', async () => {
  const candidateIndexTree = execFileSync('git', ['write-tree'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  const verified = await verifyV106ManifestDigests({ manifest, candidateIndexTree, root: repoRoot })
  const directory = await mkdtemp(path.join(os.tmpdir(), 'v106-attestation-negative-'))
  const attestationPath = path.join(directory, 'attestation.json')
  try {
    const base = {
      releaseVersion: manifest.releaseVersion,
      tagName: manifest.gitTag,
      candidateIndexTree,
      commit: '0'.repeat(40),
    }
    await writeFile(attestationPath, JSON.stringify(base))
    await assert.rejects(
      verifyV106Attestation({ manifest, candidateIndexTree, attestationPath, root: repoRoot }),
      /attestation_digests_missing/,
    )
    const tampered = { ...base, digests: { ...verified.digests, databaseCutoverInput: '0'.repeat(64) } }
    await writeFile(attestationPath, JSON.stringify(tampered))
    await assert.rejects(
      verifyV106Attestation({ manifest, candidateIndexTree, attestationPath, root: repoRoot }),
      /attestation_digest_mismatch:databaseCutoverInput/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
