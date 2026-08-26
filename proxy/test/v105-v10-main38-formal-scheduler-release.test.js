import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const workflowPath = '.github/workflows/trusted-release-images-main38.yml'
const manifestPath = 'release/v105-v10-main38-formal-scheduler-release-manifest.json'
const reportPath = 'release/v105-v10-main38-formal-scheduler-release-report.json'
const releaseTestPath = 'proxy/test/v105-v10-main38-formal-scheduler-release.test.js'
const expectedDelta = [
  workflowPath,
  'proxy/src/server.js',
  'proxy/test/capture-outbox-ack.test.js',
  'proxy/test/v105-v10-main33-decommission-release.test.js',
  'proxy/test/v105-v10-main36-formal-scheduler-release.test.js',
  'proxy/test/v105-v10-main37-formal-scheduler-release.test.js',
  releaseTestPath,
  manifestPath,
  reportPath,
]
const expectedBindings = expectedDelta.filter((relativePath) => relativePath !== manifestPath)
const readText = (relativePath) => readFile(path.join(root, relativePath), 'utf8')
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const gitBlob = (relativePath) => execFileSync('git', ['show', `:${relativePath}`], {
  cwd: root,
  encoding: null,
  windowsHide: true,
})

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

test('Main38 workflow builds only Formal Consumer from exact tag, parent, and nine-file delta', async () => {
  const workflow = await readText(workflowPath)
  assert.match(workflow, /tags:\n\s+- v105-v10-main\.38/)
  assert.match(workflow, /if: github\.ref == 'refs\/tags\/v105-v10-main\.38'/)
  assert.match(workflow, /ref: refs\/tags\/v105-v10-main\.38/)
  assert.match(workflow, /IMAGE: darven-ai-baccarat-formal-consumer/)
  assert.match(workflow, /file: proxy\/Dockerfile\.formal-consumer/)
  assert.doesNotMatch(workflow, /IMAGE: darven-ai-baccarat-(?:proxy|worker)/)
  assert.match(workflow, /gh attestation verify/)
  assert.match(workflow, /--source-digest "\$\{GITHUB_SHA\}"/)
  assert.match(workflow, /--source-ref "\$\{GITHUB_REF\}"/)
  assert.match(workflow, /--deny-self-hosted-runners/)
  assert.deepEqual(verifierArgs(workflow), [
    '"${GITHUB_SHA}"',
    'ec316d8ce647216dd2ab2c540fb1eb4a2133b468',
    ...expectedDelta,
  ])
})

test('Main38 manifest binds every non-self delta path from normalized Git blobs', async () => {
  const manifest = JSON.parse(await readText(manifestPath))
  assert.equal(manifest.releaseVersion, 'v105-v10-main.38')
  assert.equal(manifest.gitTag, 'v105-v10-main.38')
  assert.equal(manifest.liveBaseCommit, '7c81b01bbc605d1aff7a1ca0ed2bf8a918e9af0f')
  assert.equal(manifest.predecessorCommit, 'ec316d8ce647216dd2ab2c540fb1eb4a2133b468')
  assert.equal(manifest.releaseScope.runtimeChangedFromLiveBase, true)
  assert.equal(manifest.releaseScope.formalConsumerChanged, true)
  assert.equal(manifest.releaseScope.databaseChanged, false)
  assert.equal(manifest.releaseScope.frontendChanged, false)
  assert.deepEqual(manifest.workflowContract.allowedChangedPaths, expectedDelta)
  assert.deepEqual(Object.keys(manifest.releaseBinding.changedFileSha256), expectedBindings)
  for (const relativePath of expectedBindings) {
    assert.equal(manifest.releaseBinding.changedFileSha256[relativePath], sha256(gitBlob(relativePath)), relativePath)
  }
})

test('Main38 report records Main37 P1 BLOCK and leaves production gates closed', async () => {
  const report = JSON.parse(await readText(reportPath))
  assert.equal(report.releaseVersion, 'v105-v10-main.38')
  assert.equal(report.predecessor.releaseVersion, 'v105-v10-main.37')
  assert.equal(report.predecessor.status, 'BLOCK')
  assert.match(report.predecessor.reason, /BAG02|concurrent external table update/i)
  assert.equal(report.ownerEvidence.main37ConcurrencyRed, "actual ['BAG01']; expected ['BAG02','BAG01']")
  assert.equal(report.ownerEvidence.targetRegression, '3/3 PASS')
  assert.equal(report.ownerEvidence.historicalReleaseGates, '12/12 PASS')
  assert.equal(report.ownerEvidence.proxySuite, '1039/1039 PASS')
  for (const value of Object.values(report.productionGates)) assert.match(value, /^(?:PENDING|BLOCK)$/)
  assert.ok(!JSON.stringify(report.productionGates).includes('PASS'))
})
