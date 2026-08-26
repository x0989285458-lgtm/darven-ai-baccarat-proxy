import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const parentCommit = 'ca52d05714de9a91b394159994c44710ee74e0aa'
const workflowPath = '.github/workflows/trusted-release-images-main47.yml'
const migrationPath = 'supabase/migrations/20260827010000_v105_capture_outbox_batch30_contract.sql'
const harnessPath = 'scripts/test-main47-batch30-migration.mjs'
const manifestPath = 'release/v105-v10-main47-db-batch30-release-manifest.json'
const reportPath = 'release/v105-v10-main47-db-batch30-release-report.json'
const expectedDelta = [
  workflowPath,
  'proxy/test/capture-outbox-writer.test.js',
  'proxy/test/v105-v10-main46-formal-batch30-release.test.js',
  'proxy/test/v105-v10-main47-db-batch30-release.test.js',
  harnessPath,
  migrationPath,
  manifestPath,
  reportPath,
]
const expectedBindings = expectedDelta.filter((relativePath) => relativePath !== manifestPath)
const gitBlob = (relativePath) => execFileSync('git', ['show', `:${relativePath}`], { cwd: root, encoding: null, windowsHide: true })
const readText = async (relativePath) => gitBlob(relativePath).toString('utf8')
const sha256 = (value) => createHash('sha256').update(value).digest('hex')

test('Main47 workflow is Formal-only and binds DB-first batch30 artifacts to exact tag and Main46 parent', async () => {
  const workflow = await readText(workflowPath)
  assert.match(workflow, /v105-v10-main\.47/g)
  assert.match(workflow, new RegExp(parentCommit, 'g'))
  assert.match(workflow, /IMAGE: darven-ai-baccarat-formal-consumer/)
  assert.match(workflow, /file: proxy\/Dockerfile\.formal-consumer/)
  assert.match(workflow, /trusted-release-images-main47\.yml/)
  assert.match(workflow, /20260827010000_v105_capture_outbox_batch30_contract\.sql/)
  assert.match(workflow, /test-main47-batch30-migration\.mjs/)
  assert.doesNotMatch(workflow, /darven-ai-baccarat-proxy/)
  const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/).filter(Boolean).sort()
  assert.deepEqual(staged, [...expectedDelta].sort())
})

test('Main47 manifest binds eight changed files and all seven non-self Git blobs', async () => {
  const manifest = JSON.parse(await readText(manifestPath))
  assert.equal(manifest.releaseVersion, 'v105-v10-main.47')
  assert.equal(manifest.parentCommit, parentCommit)
  assert.deepEqual(manifest.changedFiles, expectedDelta)
  assert.deepEqual(Object.keys(manifest.blobSha256).sort(), [...expectedBindings].sort())
  for (const relativePath of expectedBindings) assert.equal(manifest.blobSha256[relativePath], sha256(gitBlob(relativePath)), relativePath)
  assert.equal(manifest.releaseScope.proxyDeploymentChanged, false)
  assert.equal(manifest.releaseScope.formalConsumerDeploymentChanged, true)
  assert.equal(manifest.releaseScope.databaseMigrationChanged, true)
  assert.equal(manifest.releaseScope.cloudflareDeploymentChanged, false)
  assert.equal(manifest.releaseScope.workerProducerChanged, false)
})

test('Main47 report preserves Main46 P1 block, DB-first order, and closes no Production gate', async () => {
  const report = JSON.parse(await readText(reportPath))
  assert.equal(report.releaseVersion, 'v105-v10-main.47')
  assert.equal(report.predecessor.commit, parentCommit)
  assert.equal(report.predecessor.status, 'BLOCKED_P1_DB_BATCH_LIMIT_DRIFT')
  assert.equal(report.main46Incident.containerStopped, true)
  assert.equal(report.freshBoundaryArchive.total, 518)
  assert.match(report.tests.rollbackOnlySupabase, /exactSessionClaims=true claimed=30 completed=30 failed=30 poisonIsolated=true rejected31=true rollback=true/)
  assert.equal(report.tests.proxySuite, '1081/1081 PASS')
  assert.equal(report.tests.releaseBinding, '6/6 PASS')
  assert.equal(report.deploymentOrder[0], 'main47-corrective-database-migration')
  assert.equal(report.productionStatus, 'LIVE_GATE_FAIL')
  assert.equal(Object.values(report.productionGates).includes('PASS'), false)
})
