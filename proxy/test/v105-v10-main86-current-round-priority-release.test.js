import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const baseCommit = '479417542cb23d17224e400b169843a0e6a9ec62'
const releaseTag = 'v105-v10-main.86'
const manifestPath = 'release/v105-v10-main86-current-round-priority-release-manifest.json'
const migrationPath = 'supabase/migrations/20260901010000_v105_lost_ack_fence_reconciliation.sql'
const obsoleteTestPath = 'proxy/test/v102-release-integrity.test.js'
const obsoleteHistoricalRunnerPath = 'proxy/scripts/run-historical-release-tests.mjs'
const deletedPaths = [obsoleteTestPath]
const manifest = JSON.parse(readFileSync(path.join(root, manifestPath), 'utf8'))

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

test('Main86 is the exact bounded candidate over immutable Main85', () => {
  const actual = immutableMode
    ? git(['diff', '--name-only', baseCommit, releaseCommit]).split(/\r?\n/)
    : [
        ...git(['diff', '--name-only', baseCommit]).split(/\r?\n/),
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

test('Main86 binds every present candidate path to immutable Git blob identity', () => {
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
  assert.deepEqual(manifest.implementationTree.paths, bindablePaths)
  assert.equal(manifest.implementationTree.sha256, implementationDigest(bindablePaths))
})

test('Main86 deployment contract is DB-first and keeps the reconciliation additive and fail-closed', () => {
  assert.deepEqual(manifest.deploymentOrder.slice(0, 3), [
    'database-additive-lost-ack-reconciliation',
    'database-catalog-acl-and-function-readback',
    'database-reconciliation-negative-and-duplicate-probes',
  ])
  const proxyIndex = manifest.deploymentOrder.indexOf('proxy-v1.0.67-cutover')
  const workerIndex = manifest.deploymentOrder.indexOf('worker-v1.0.66-cutover')
  assert.ok(proxyIndex > 2)
  assert.ok(workerIndex > 2)
  assert.equal(manifest.releaseBinding.database.path, migrationPath)
  assert.equal(manifest.releaseBinding.database.gitBlobOid, candidateBlobOid(migrationPath))
  const sql = readFileSync(path.join(root, migrationPath), 'utf8')
  assert.match(sql, /create or replace function public\.reconcile_v105_capture_envelope\(p_capture jsonb\)/i)
  assert.match(sql, /capture_reconciliation_not_found/)
  assert.match(sql, /capture identity conflict/)
  assert.match(sql, /grant execute on function public\.reconcile_v105_capture_envelope\(jsonb\) to service_role/i)
  assert.doesNotMatch(sql, /\b(?:drop|truncate|delete)\b/i)
})

test('Main86 current identities and canonical test gates replace obsolete release truth', () => {
  assert.equal(manifest.releaseVersion, releaseTag)
  assert.deepEqual(manifest.componentVersions, { proxy: '1.0.67', worker: '1.0.66' })
  const proxyPackage = JSON.parse(readFileSync(path.join(root, 'proxy/package.json'), 'utf8'))
  assert.equal(proxyPackage.version, '1.0.67')
  assert.equal(proxyPackage.scripts['test:historical-releases'], undefined)
  assert.equal(manifest.testDiscovery.historicalCommand, undefined)
  assert.equal(JSON.parse(readFileSync(path.join(root, 'cloud-browser-worker/package.json'), 'utf8')).version, '1.0.66')
  assert.ok(manifest.changedPaths.includes('proxy/scripts/test-classifier.mjs'))
  assert.ok(manifest.changedPaths.includes('proxy/scripts/run-tests.mjs'))
  assert.ok(!manifest.changedPaths.includes(obsoleteHistoricalRunnerPath))
  assert.ok(manifest.changedPaths.includes(obsoleteTestPath))

  const workflow = readFileSync(path.join(root, '.github/workflows/trusted-release-images-main86.yml'), 'utf8')
  assert.match(workflow, /refs\/tags\/v105-v10-main\.86/)
  assert.match(workflow, /npm test --prefix cloud-browser-worker/)
  assert.match(workflow, /npm test --prefix proxy/)
  assert.match(workflow, /proxy\/Dockerfile\.evidence/)
  assert.match(workflow, /proxy\/Dockerfile\.formal-consumer/)
  assert.match(workflow, /cloud-browser-worker\/Dockerfile/)
  assert.match(workflow, /darven-ai-baccarat-proxy/)
  assert.match(workflow, /darven-ai-baccarat-formal-consumer/)
  assert.match(workflow, /darven-ai-baccarat-worker/)
  assert.match(workflow, /main86-coherent-release-receipt/)
  assert.doesNotMatch(workflow, /test:historical-releases/)
})
