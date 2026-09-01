import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const baseCommit = 'a88bcf9d371841d9b9f16f57495cff7218ebcb86'
const releaseTag = 'v105-v10-main.92'
const manifestPath = 'release/v105-v10-main92-current-runtime-isolation-release-manifest.json'
const migrationPath = 'supabase/migrations/20260901010000_v105_lost_ack_fence_reconciliation.sql'
const obsoleteHistoricalRunnerPath = 'proxy/scripts/run-historical-release-tests.mjs'
const manifest = JSON.parse(readFileSync(path.join(root, manifestPath), 'utf8'))
const deletedPaths = Object.keys(manifest.releaseBinding.deletedFileBaseGitBlobOids).sort()

const git = (args, encoding = 'utf8') => execFileSync('git', args, { cwd: root, encoding, windowsHide: true })
let releaseCommit = null
try {
  releaseCommit = execFileSync('git', ['rev-parse', `${releaseTag}^{commit}`], {
    cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
} catch {}
if (!releaseCommit && git(['status', '--porcelain']).trim() === '') {
  const head = git(['rev-parse', 'HEAD']).trim()
  if (git(['rev-list', '--parents', '-n', '1', head]).trim() === `${head} ${baseCommit}`) releaseCommit = head
}
const immutableMode = Boolean(releaseCommit)
const candidateBlobOid = (relativePath) => immutableMode
  ? git(['rev-parse', `${releaseCommit}:${relativePath}`]).trim()
  : git(['hash-object', `--path=${relativePath}`, relativePath]).trim()
const implementationDigest = (paths) => createHash('sha256')
  .update(paths.map((relativePath) => `${relativePath}\0${candidateBlobOid(relativePath)}\n`).join(''))
  .digest('hex')

test('Main92 is the exact bounded candidate over immutable Main91', () => {
  const actual = immutableMode
    ? git(['diff', '--no-renames', '--name-only', baseCommit, releaseCommit]).split(/\r?\n/)
    : [
        ...git(['diff', '--no-renames', '--name-only', baseCommit]).split(/\r?\n/),
        ...git(['ls-files', '--others', '--exclude-standard']).split(/\r?\n/),
      ]
  const actualPaths = [...new Set(actual.map((value) => value.trim()).filter(Boolean))].sort()
  assert.deepEqual(actualPaths, [...manifest.changedPaths].sort())
  if (immutableMode) {
    assert.equal(git(['rev-list', '--parents', '-n', '1', releaseCommit]).trim(), `${releaseCommit} ${baseCommit}`)
  } else {
    const head = git(['rev-parse', 'HEAD']).trim()
    if (head !== baseCommit) {
      assert.equal(git(['rev-list', '--parents', '-n', '1', head]).trim(), `${head} ${baseCommit}`)
    }
  }
})

test('Main92 binds every present candidate path to immutable Git blob identity', () => {
  const bindablePaths = manifest.changedPaths
    .filter((relativePath) => relativePath !== manifestPath && !deletedPaths.includes(relativePath))
    .sort()
  assert.deepEqual(Object.keys(manifest.releaseBinding.changedFileGitBlobOids).sort(), bindablePaths)
  for (const relativePath of bindablePaths) {
    assert.equal(manifest.releaseBinding.changedFileGitBlobOids[relativePath], candidateBlobOid(relativePath), relativePath)
  }
  for (const relativePath of deletedPaths) {
    assert.equal(manifest.releaseBinding.deletedFileBaseGitBlobOids[relativePath], git(['rev-parse', `${baseCommit}:${relativePath}`]).trim())
  }
  const implementationPaths = [...manifest.implementationTree.paths].sort()
  assert.deepEqual(implementationPaths, [...new Set(implementationPaths)].sort())
  for (const relativePath of bindablePaths) assert.ok(implementationPaths.includes(relativePath), relativePath)
  for (const relativePath of [
    'proxy/Dockerfile.evidence', 'proxy/Dockerfile.formal-consumer',
    'cloud-browser-worker/Dockerfile', migrationPath,
  ]) assert.ok(implementationPaths.includes(relativePath), relativePath)
  assert.equal(manifest.implementationTree.sha256, implementationDigest(implementationPaths))
})

test('Main92 preserves inherited DB provenance and approves only the changed Worker for deployment', () => {
  assert.deepEqual(manifest.deploymentTargets, ['worker'])
  assert.deepEqual(manifest.unchangedRuntimeRoles, ['proxy', 'formal-consumer'])
  assert.deepEqual(manifest.deploymentOrder.slice(0, 3), [
    'database-existing-lost-ack-reconciliation-readback',
    'producer-and-consumer-quiesce',
    'proxy-formal-main91-live-digest-readback',
  ])
  const workerIndex = manifest.deploymentOrder.indexOf('worker-v1.0.67-cutover')
  assert.ok(workerIndex > 2)
  assert.equal(manifest.releaseBinding.database.path, migrationPath)
  assert.equal(manifest.releaseBinding.database.gitBlobOid, candidateBlobOid(migrationPath))
  assert.deepEqual(manifest.rollback.worker, {
    releaseVersion: 'v105-v10-main.91',
    commit: baseCommit,
    image: 'ghcr.io/x0989285458-lgtm/darven-ai-baccarat-worker@sha256:a190ed62514ebb3892f7f5e9424918d06841f9c87d9aade422e137e6b027fd50',
    digest: 'sha256:a190ed62514ebb3892f7f5e9424918d06841f9c87d9aade422e137e6b027fd50',
    receiptSha256: 'a7d13968f496483ab3e91411fdf3831051f72339067b191fc5a2eeb585057036',
  })
  const sql = readFileSync(path.join(root, migrationPath), 'utf8')
  assert.match(sql, /create or replace function public\.reconcile_v105_capture_envelope\(p_capture jsonb\)/i)
  assert.match(sql, /capture_reconciliation_not_found/)
  assert.match(sql, /capture identity conflict/)
  assert.match(sql, /grant execute on function public\.reconcile_v105_capture_envelope\(jsonb\) to service_role/i)
  assert.doesNotMatch(sql, /\b(?:drop|truncate|delete)\b/i)
})

test('Main92 current identities and canonical test gates replace obsolete release truth', () => {
  assert.equal(manifest.releaseVersion, releaseTag)
  assert.deepEqual(manifest.componentVersions, { proxy: '1.0.72', worker: '1.0.67' })
  const proxyPackage = JSON.parse(readFileSync(path.join(root, 'proxy/package.json'), 'utf8'))
  assert.equal(proxyPackage.version, '1.0.72')
  assert.equal(proxyPackage.scripts['test:historical-releases'], undefined)
  assert.equal(manifest.testDiscovery.historicalCommand, undefined)
  assert.equal(JSON.parse(readFileSync(path.join(root, 'cloud-browser-worker/package.json'), 'utf8')).version, '1.0.67')
  for (const relativePath of [
    'cloud-browser-worker/src/final-journal.js',
    'cloud-browser-worker/src/mt-api-client.js',
    'cloud-browser-worker/src/snapshot-pusher.js',
    'cloud-browser-worker/src/worker-source-runtime.js',
    'cloud-browser-worker/test/final-journal.test.js',
    'cloud-browser-worker/test/mt-api-client.test.js',
    'cloud-browser-worker/test/snapshot-pusher.test.js',
    'cloud-browser-worker/test/worker-source-runtime.test.js',
  ]) assert.ok(manifest.changedPaths.includes(relativePath), relativePath)
  assert.ok(manifest.changedPaths.includes('cloud-browser-worker/package.json'))
  assert.ok(!manifest.changedPaths.includes(obsoleteHistoricalRunnerPath))
  assert.equal(manifest.testDiscovery.historicalExactReleaseIdentityCount, 0)
  assert.ok(deletedPaths.length >= 2)
  assert.ok(deletedPaths.every((relativePath) => (
    /^proxy\/test\/v105-v10-main/.test(relativePath)
    || /^\.github\/workflows\/trusted-release-images-main\d+\.yml$/.test(relativePath)
    || /^release\/v105-v10-main\d+-current-runtime-isolation-release-manifest\.json$/.test(relativePath)
  )))

  const workflow = readFileSync(path.join(root, '.github/workflows/trusted-release-images-main92.yml'), 'utf8')
  assert.match(workflow, /refs\/tags\/v105-v10-main\.92/)
  assert.match(workflow, /npm test --prefix cloud-browser-worker/)
  assert.match(workflow, /npm test --prefix proxy/)
  assert.match(workflow, /proxy\/Dockerfile\.evidence/)
  assert.match(workflow, /proxy\/Dockerfile\.formal-consumer/)
  assert.match(workflow, /cloud-browser-worker\/Dockerfile/)
  assert.match(workflow, /darven-ai-baccarat-proxy/)
  assert.match(workflow, /darven-ai-baccarat-formal-consumer/)
  assert.match(workflow, /darven-ai-baccarat-worker/)
  assert.match(workflow, /main92-coherent-release-receipt/)
  assert.doesNotMatch(workflow, /test:historical-releases/)
})
