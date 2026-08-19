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
    proxy: 'fad9bd839eb272d8e9ab3db00852c1261aa620dd',
    frontend: '4a6b4bc8b4ab8357dfefdf738f73d41adc520bf0',
    worker: '6bdd39e8c241c6d9341229d20bb5e281022c7d58',
  })
  assert.deepEqual(manifest.rollback.componentPackages, {
    proxy: { name: 'draven-mt-data-proxy-v105', version: '1.0.61' },
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
