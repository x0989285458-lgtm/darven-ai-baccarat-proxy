import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const parentCommit = 'c08733972a5a1efedd10ecc84bf2bc9a00745b03'
const workflowPath = '.github/workflows/trusted-release-images-main49.yml'
const manifestPath = 'release/v105-v10-main49-batch-jitter-budget-release-manifest.json'
const reportPath = 'release/v105-v10-main49-batch-jitter-budget-release-report.json'
const expectedDelta = [
  workflowPath,
  'proxy/src/server.js',
  'proxy/test/capture-outbox-ack.test.js',
  'proxy/test/v105-v10-main48-batch-deadline-release.test.js',
  'proxy/test/v105-v10-main49-batch-jitter-budget-release.test.js',
  manifestPath,
  reportPath,
]
const expectedBindings = expectedDelta.filter((relativePath) => relativePath !== manifestPath)
const gitBlob = (relativePath) => execFileSync('git', ['show', `:${relativePath}`], { cwd: root, encoding: null, windowsHide: true })
const readText = async (relativePath) => gitBlob(relativePath).toString('utf8')
const sha256 = (value) => createHash('sha256').update(value).digest('hex')

test('Main49 workflow is Formal-only and binds batch jitter artifacts to exact tag and Main48 parent', async () => {
  const workflow = await readText(workflowPath)
  assert.match(workflow, /v105-v10-main\.49/g)
  assert.match(workflow, new RegExp(parentCommit, 'g'))
  assert.match(workflow, /IMAGE: darven-ai-baccarat-formal-consumer/)
  assert.match(workflow, /file: proxy\/Dockerfile\.formal-consumer/)
  assert.match(workflow, /trusted-release-images-main49\.yml/)
  assert.doesNotMatch(workflow, /darven-ai-baccarat-proxy/)
  const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/).filter(Boolean).sort()
  assert.deepEqual(staged, [...expectedDelta].sort())
})

test('Main49 manifest binds seven changed files and all six non-self Git blobs', async () => {
  const manifest = JSON.parse(await readText(manifestPath))
  assert.equal(manifest.releaseVersion, 'v105-v10-main.49')
  assert.equal(manifest.parentCommit, parentCommit)
  assert.deepEqual(manifest.changedFiles, expectedDelta)
  assert.deepEqual(Object.keys(manifest.blobSha256).sort(), [...expectedBindings].sort())
  for (const relativePath of expectedBindings) assert.equal(manifest.blobSha256[relativePath], sha256(gitBlob(relativePath)), relativePath)
  assert.equal(manifest.releaseScope.proxyDeploymentChanged, false)
  assert.equal(manifest.releaseScope.formalConsumerDeploymentChanged, true)
  assert.equal(manifest.releaseScope.databaseMigrationChanged, false)
  assert.equal(manifest.releaseScope.cloudflareDeploymentChanged, false)
  assert.equal(manifest.releaseScope.workerProducerChanged, false)
})

test('Main49 report records the later Attempt2 evidence, bounded jitter budget, and closes no Production gate', async () => {
  const report = JSON.parse(await readText(reportPath))
  assert.equal(report.releaseVersion, 'v105-v10-main.49')
  assert.equal(report.predecessor.commit, parentCommit)
  assert.equal(report.predecessor.status, 'BLOCKED_LIVE_BATCH_JITTER_RETRY')
  assert.equal(report.productionIncident.laterProbeEvidence.batchSize, 23)
  assert.equal(report.productionIncident.laterProbeEvidence.maxAttempts, 2)
  assert.equal(report.productionIncident.laterProbeEvidence.containerRestartCount, 0)
  assert.equal(report.fix.claims1To10DeadlineMs, 45_000)
  assert.equal(report.fix.claims11To20DeadlineMs, 135_000)
  assert.equal(report.fix.claims21To30DeadlineMs, 180_000)
  assert.equal(report.fix.hardCapMs, 240_000)
  assert.equal(report.tests.captureOutbox, '57/57 PASS')
  assert.equal(report.productionStatus, 'PENDING')
  assert.equal(Object.values(report.productionGates).includes('PASS'), false)
})
