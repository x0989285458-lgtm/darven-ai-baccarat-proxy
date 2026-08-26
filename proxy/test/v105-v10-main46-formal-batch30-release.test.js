import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const candidateCommit = 'ca52d05714de9a91b394159994c44710ee74e0aa'
const parentCommit = '76d064960ee21908a78f96d79d5ce476b623c627'
const workflowPath = '.github/workflows/trusted-release-images-main46.yml'
const manifestPath = 'release/v105-v10-main46-formal-batch30-release-manifest.json'
const reportPath = 'release/v105-v10-main46-formal-batch30-release-report.json'
const expectedDelta = [
  workflowPath,
  'proxy/src/server.js',
  'proxy/test/capture-outbox-ack.test.js',
  'proxy/test/v105-v10-main45-read-only-tables-release.test.js',
  'proxy/test/v105-v10-main46-formal-batch30-release.test.js',
  manifestPath,
  reportPath,
]
const expectedBindings = expectedDelta.filter((relativePath) => relativePath !== manifestPath)
const gitBlob = (relativePath) => execFileSync('git', ['show', `${candidateCommit}:${relativePath}`], { cwd: root, encoding: null, windowsHide: true })
const readText = async (relativePath) => gitBlob(relativePath).toString('utf8')
const sha256 = (value) => createHash('sha256').update(value).digest('hex')

test('Main46 workflow builds only Formal Consumer from exact tag and Main45 parent', async () => {
  const workflow = await readText(workflowPath)
  assert.match(workflow, /v105-v10-main\.46/g)
  assert.match(workflow, new RegExp(parentCommit, 'g'))
  assert.match(workflow, /IMAGE: darven-ai-baccarat-formal-consumer/)
  assert.match(workflow, /file: proxy\/Dockerfile\.formal-consumer/)
  assert.match(workflow, /Build and push exact Formal Consumer image/)
  assert.match(workflow, /attest-build-provenance@977bb373ede98d70efdf65b84cb5f73e068dcc2a/)
  assert.match(workflow, /trusted-release-images-main46\.yml/)
  assert.doesNotMatch(workflow, /darven-ai-baccarat-proxy/)
  assert.doesNotMatch(workflow, /Dockerfile\.evidence/)

  const immutableDelta = execFileSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', candidateCommit], { cwd: root, encoding: 'utf8', windowsHide: true }).trim().split('\n').map((item) => item.trim()).filter(Boolean).sort()
  assert.deepEqual(immutableDelta, [...expectedDelta].sort())
})

test('Main46 manifest binds every changed normalized Git blob except itself', async () => {
  const manifest = JSON.parse(await readText(manifestPath))
  assert.equal(manifest.releaseVersion, 'v105-v10-main.46')
  assert.equal(manifest.parentCommit, parentCommit)
  assert.deepEqual(manifest.changedFiles, expectedDelta)
  assert.deepEqual(Object.keys(manifest.blobSha256).sort(), [...expectedBindings].sort())
  for (const relativePath of expectedBindings) assert.equal(manifest.blobSha256[relativePath], sha256(gitBlob(relativePath)), relativePath)
  assert.equal(manifest.releaseScope.proxyDeploymentChanged, false)
  assert.equal(manifest.releaseScope.formalConsumerDeploymentChanged, true)
  assert.equal(manifest.releaseScope.cloudflareDeploymentChanged, false)
  assert.equal(manifest.releaseScope.databaseMigrationChanged, false)
  assert.equal(manifest.releaseScope.workerProducerChanged, false)
})

test('Main46 report records Main44 long-window capacity failure and closes no production gate', async () => {
  const report = JSON.parse(await readText(reportPath))
  assert.equal(report.releaseVersion, 'v105-v10-main.46')
  assert.equal(report.predecessor.commit, parentCommit)
  assert.equal(report.productionIncident.longWindowFailure.active, 57)
  assert.equal(report.productionIncident.longWindowFailure.pending, 47)
  assert.equal(report.productionIncident.longWindowFailure.processing, 10)
  assert.equal(report.productionIncident.postStopForensics.pending, 65)
  assert.equal(report.productionIncident.postStopForensics.processing, 10)
  assert.equal(report.productionIncident.stopEvidence.state, 'exited')
  assert.equal(report.tests.red.startsWith('2/2 FAIL'), true)
  assert.equal(report.tests.green, '2/2 PASS')
  assert.equal(report.tests.captureOutbox, '55/55 PASS')
  assert.equal(report.tests.proxySuite, '1077/1077 PASS')
  assert.equal(report.tests.releaseBinding, '6/6 PASS')
  assert.equal(report.productionStatus, 'LIVE_GATE_FAIL')
  assert.equal(Object.values(report.productionGates).includes('PASS'), false)
})
