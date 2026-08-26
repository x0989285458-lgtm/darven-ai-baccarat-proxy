import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const parentCommit = '30aa84d4224e65557806a9b3865426802767674d'
const workflowPath = '.github/workflows/trusted-release-images-main41.yml'
const manifestPath = 'release/v105-v10-main41-old-shoe-ack-release-manifest.json'
const reportPath = 'release/v105-v10-main41-old-shoe-ack-release-report.json'
const releaseTestPath = 'proxy/test/v105-v10-main41-old-shoe-ack-release.test.js'
const expectedDelta = [
  workflowPath,
  'frontend/src/lib/liveClient.test.ts',
  'frontend/src/lib/liveClient.ts',
  'proxy/src/cloud-capture.js',
  'proxy/src/server.js',
  'proxy/src/state-store.js',
  'proxy/test/capture-outbox-ack.test.js',
  'proxy/test/cloud-ingest-snapshot.test.js',
  'proxy/test/ingest-ack.test.js',
  'proxy/test/ingest-source-fence.test.js',
  'proxy/test/security-contract.test.js',
  'proxy/test/v104-formal-server.test.js',
  'proxy/test/v105-formal-memory-runtime-contract.test.js',
  'proxy/test/v105-v10-main39-formal-scheduler-release.test.js',
  releaseTestPath,
  manifestPath,
  reportPath,
]
const expectedBindings = expectedDelta.filter((relativePath) => relativePath !== manifestPath)
const gitBlob = (relativePath) => execFileSync('git', ['show', `:${relativePath}`], {
  cwd: root,
  encoding: null,
  windowsHide: true,
})
const readText = async (relativePath) => gitBlob(relativePath).toString('utf8')
const sha256 = (value) => createHash('sha256').update(value).digest('hex')

function verifierArgs(workflow) {
  const lines = workflow.split(/\r?\n/)
  const start = lines.findIndex((line) => line.includes('bash scripts/verify-trusted-release-delta.sh'))
  assert.notEqual(start, -1)
  const args = []
  for (let index = start; index < lines.length; index += 1) {
    const trimmed = lines[index].trim()
    if (index > start && trimmed === '') break
    if (index === start) continue
    args.push(trimmed.replace(/ \\$/, ''))
  }
  return args
}

test('Main41 workflow builds only Formal Consumer from exact tag and Main39 parent', async () => {
  const workflow = await readText(workflowPath)
  assert.match(workflow, /tags:\n\s+- v105-v10-main\.41/)
  assert.match(workflow, /if: github\.ref == 'refs\/tags\/v105-v10-main\.41'/)
  assert.match(workflow, /ref: refs\/tags\/v105-v10-main\.41/)
  assert.match(workflow, /IMAGE: darven-ai-baccarat-formal-consumer/)
  assert.match(workflow, /file: proxy\/Dockerfile\.formal-consumer/)
  assert.doesNotMatch(workflow, /IMAGE: darven-ai-baccarat-(?:proxy|worker)/)
  assert.match(workflow, /gh attestation verify/)
  assert.match(workflow, /--source-digest "\$\{GITHUB_SHA\}"/)
  assert.match(workflow, /--source-ref "\$\{GITHUB_REF\}"/)
  assert.match(workflow, /--deny-self-hosted-runners/)
  assert.deepEqual(verifierArgs(workflow), ['"${GITHUB_SHA}"', parentCommit, ...expectedDelta])
})

test('Main41 manifest binds every changed normalized Git blob except itself', async () => {
  const manifest = JSON.parse(await readText(manifestPath))
  assert.equal(manifest.releaseVersion, 'v105-v10-main.41')
  assert.equal(manifest.gitTag, 'v105-v10-main.41')
  assert.equal(manifest.parentCommit, parentCommit)
  assert.equal(manifest.releaseScope.formalConsumerChanged, true)
  assert.equal(manifest.releaseScope.frontendChanged, true)
  assert.equal(manifest.releaseScope.proxyDeploymentChanged, false)
  assert.equal(manifest.releaseScope.databaseChanged, false)
  assert.equal(manifest.releaseScope.workerChanged, false)
  assert.deepEqual(manifest.workflowContract.allowedChangedPaths, expectedDelta)
  assert.deepEqual(Object.keys(manifest.releaseBinding.changedFileSha256), expectedBindings)
  for (const relativePath of expectedBindings) {
    assert.equal(manifest.releaseBinding.changedFileSha256[relativePath], sha256(gitBlob(relativePath)), relativePath)
  }
})

test('Main41 report preserves the Main39 production block and closes no production gate', async () => {
  const report = JSON.parse(await readText(reportPath))
  assert.equal(report.releaseVersion, 'v105-v10-main.41')
  assert.equal(report.predecessor.releaseVersion, 'v105-v10-main.39')
  assert.equal(report.predecessor.status, 'BLOCK')
  assert.equal(report.productionIncidentEvidence.deadLetterRows, 2)
  assert.equal(report.productionIncidentEvidence.roundKeys, 10)
  assert.equal(report.productionIncidentEvidence.allRawRoadmapSettlementPresent, true)
  assert.equal(report.runtimeEvidence.oldShoeAndMissingTableBranches, '8/8 PASS')
  assert.equal(report.runtimeEvidence.captureOutboxSuite, '53/53 PASS')
  assert.equal(report.runtimeEvidence.exactReaderHttpContracts, '31/31 PASS')
  assert.equal(report.runtimeEvidence.proxySuite, '1055/1055 PASS')
  assert.equal(report.runtimeEvidence.frontendSuite, '164/164 PASS')
  for (const value of Object.values(report.productionGates)) assert.match(value, /^(?:PENDING|BLOCK)$/)
  assert.ok(!JSON.stringify(report.productionGates).includes('PASS'))
})
