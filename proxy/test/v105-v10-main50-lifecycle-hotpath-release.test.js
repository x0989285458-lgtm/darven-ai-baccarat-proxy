import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const baseCommit = '45ef192378e90162df6be4f71f3c8f782ba6ab0c'
const migrationPath = 'supabase/migrations/20260827103000_v105_lifecycle_hotpath.sql'
const rollbackPath = 'supabase/operations/rollback_v105_main50_lifecycle_hotpath.sql'
const manifestPath = 'release/v105-v10-main50-lifecycle-hotpath-release-manifest.json'
const reportPath = 'release/v105-v10-main50-lifecycle-hotpath-release-report.json'
const expectedDelta = [
  migrationPath,
  rollbackPath,
  'scripts/apply-v105-main50-lifecycle-hotpath.mjs',
  'proxy/test/capture-outbox-ack.test.js',
  'proxy/test/immediate-round-ready.test.js',
  'proxy/test/v105-main50-migration-runner.test.js',
  'proxy/test/v105-v10-main49-batch-jitter-budget-release.test.js',
  'proxy/test/v105-main50-lifecycle-hotpath.test.js',
  'proxy/test/v105-v10-main50-lifecycle-hotpath-release.test.js',
  manifestPath,
  reportPath,
]
const expectedBindings = expectedDelta.filter((relativePath) => relativePath !== manifestPath)
const headCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
const immutableMode = headCommit !== baseCommit
const candidateRef = immutableMode ? headCommit : ''
const gitBlob = (relativePath) => execFileSync('git', ['show', `${candidateRef}:${relativePath}`], { cwd: root, encoding: null, windowsHide: true })
const readText = (relativePath) => gitBlob(relativePath).toString('utf8')
const sha256 = (value) => createHash('sha256').update(value).digest('hex')

test('Main50 is an exact eleven-file DB-only runtime delta over immutable Main49', () => {
  const exactDelta = execFileSync('git', immutableMode
    ? ['diff', '--name-only', baseCommit, headCommit]
    : ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8', windowsHide: true })
    .split('\n').map((value) => value.trim()).filter(Boolean).sort()
  assert.deepEqual(exactDelta, [...expectedDelta].sort())
  if (immutableMode) {
    assert.equal(execFileSync('git', ['rev-parse', `${headCommit}^`], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(), baseCommit)
  } else {
    assert.equal(headCommit, baseCommit)
  }
})

test('Main50 manifest binds every non-self Git blob and the unchanged Main49 runtime image', () => {
  const manifest = JSON.parse(readText(manifestPath))
  assert.equal(manifest.releaseVersion, 'v105-v10-main.50')
  assert.equal(manifest.baseCommit, baseCommit)
  assert.equal(manifest.runtimeReleaseVersion, 'v105-v10-main.49')
  assert.equal(manifest.runtimeEvidence.sourceCommit, baseCommit)
  assert.equal(manifest.runtimeEvidence.sourceTag, 'refs/tags/v105-v10-main.49')
  assert.equal(manifest.runtimeEvidence.workflowRunId, 33055051482)
  assert.equal(manifest.runtimeEvidence.registrySubject, 'ghcr.io/x0989285458-lgtm/darven-ai-baccarat-formal-consumer')
  assert.equal(manifest.runtimeEvidence.imageDigest, 'sha256:46a681db23a8db631f75fe590e7781bacc45bc62e11cdca11c592eb023ba193e')
  assert.equal(manifest.runtimeEvidence.attestationRepository, 'x0989285458-lgtm/darven-ai-baccarat-proxy')
  assert.equal(manifest.runtimeEvidence.attestationWorkflow, 'x0989285458-lgtm/darven-ai-baccarat-proxy/.github/workflows/trusted-release-images-main49.yml')
  assert.equal(manifest.runtimeEvidence.externalAttestationResult, 'PASS')
  assert.equal(manifest.runtimeEvidence.productionVmDigestReadback, 'PENDING')
  const runner = readText('scripts/apply-v105-main50-lifecycle-hotpath.mjs')
  assert.match(runner, /releaseRef !== 'refs\/tags\/v105-v10-main\.50'/)
  assert.match(runner, /git\(\['show', `\$\{releaseRef\}:\$\{migrationPath\}`\], null\)/)
  assert.match(runner, /actualSha256 !== expectedSha256/)
  assert.match(runner, /headCommit !== tagCommit/)
  assert.match(runner, /requires a clean tracked worktree/)
  assert.deepEqual(manifest.changedFiles, expectedDelta)
  assert.deepEqual(Object.keys(manifest.blobSha256).sort(), [...expectedBindings].sort())
  for (const relativePath of expectedBindings) assert.equal(manifest.blobSha256[relativePath], sha256(gitBlob(relativePath)), relativePath)
  assert.equal(manifest.releaseScope.databaseMigrationOnly, true)
  assert.equal(Object.values(manifest.releaseScope).filter(Boolean).length, 1)
})

test('Main50 binds hot-path migration and symmetric rollback without data rewrite', () => {
  const manifest = JSON.parse(readText(manifestPath))
  assert.equal(manifest.releaseBinding.migration.sha256, sha256(gitBlob(migrationPath)))
  assert.equal(manifest.releaseBinding.rollback.sha256, sha256(gitBlob(rollbackPath)))
  assert.equal(manifest.releaseScope.queuedWorkRewritten, false)
  assert.equal(manifest.releaseScope.historicalDataRewritten, false)
  assert.deepEqual(manifest.deploymentOrder, [
    'verify-exact-main50-tag-head-and-clean-worktree',
    'verify-formal-consumer-stopped',
    'verify-no-new-dead-letter',
    'verify-main49-external-attestation-source-commit-and-registry-subject',
    'execute-scripts-apply-v105-main50-lifecycle-hotpath-with-required-confirmations',
    'verify-runner-receipt-index-function-acl-and-migration-ledger',
    'verify-vm-image-digest-before-consumer-start',
    'start-existing-main49-immutable-consumer',
    'verify-stale-lease-recovery-without-delete',
    'verify-queue-natural-drain-without-rewrite',
    'verify-final-roadmap-prediction-ack-growth',
    'verify-round-ready-sse-and-member-ui',
    'run-main50-twenty-minute-capacity-window',
  ])
})

test('Main50 report records production evidence and cannot self-approve any production gate', () => {
  const report = JSON.parse(readText(reportPath))
  assert.equal(report.releaseVersion, 'v105-v10-main.50')
  assert.equal(report.baseCommit, baseCommit)
  assert.match(report.rootCause, /66524/)
  assert.match(report.rootCause, /117897\.260ms/)
  assert.equal(report.tests.main50Contract, '3/3 PASS')
  assert.equal(report.tests.adjacentLifecycleOutbox, '80/80 PASS')
  assert.ok(Object.values(report.productionGates).every((value) => value === false))
})
