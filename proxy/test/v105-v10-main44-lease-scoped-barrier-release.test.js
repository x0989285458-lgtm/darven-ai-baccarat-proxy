import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const candidateCommit = '594ce187145449bd6d2afab7a12b348cf8e2e08e'
const parentCommit = '3d8be3a0059eb93528cad04c8bb3e0933f747849'
const workflowPath = '.github/workflows/trusted-release-images-main44.yml'
const manifestPath = 'release/v105-v10-main44-lease-scoped-barrier-release-manifest.json'
const reportPath = 'release/v105-v10-main44-lease-scoped-barrier-release-report.json'
const releaseTestPath = 'proxy/test/v105-v10-main44-lease-scoped-barrier-release.test.js'
const expectedDelta = [
  workflowPath,
  'proxy/src/server.js',
  'proxy/test/capture-outbox-ack.test.js',
  'proxy/test/v105-v10-main43-settlement-receipt-release.test.js',
  releaseTestPath,
  manifestPath,
  reportPath,
]
const expectedBindings = expectedDelta.filter((relativePath) => relativePath !== manifestPath)
const gitBlob = (relativePath) => execFileSync('git', ['show', `${candidateCommit}:${relativePath}`], { cwd: root, encoding: null, windowsHide: true })
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

test('Main44 workflow builds only Formal Consumer from exact tag and Main43 parent', async () => {
  const workflow = await readText(workflowPath)
  assert.match(workflow, /tags:\n\s+- v105-v10-main\.44/)
  assert.match(workflow, /if: github\.ref == 'refs\/tags\/v105-v10-main\.44'/)
  assert.match(workflow, /ref: refs\/tags\/v105-v10-main\.44/)
  assert.match(workflow, /IMAGE: darven-ai-baccarat-formal-consumer/)
  assert.match(workflow, /file: proxy\/Dockerfile\.formal-consumer/)
  assert.doesNotMatch(workflow, /IMAGE: darven-ai-baccarat-(?:proxy|worker)/)
  assert.match(workflow, /gh attestation verify/)
  assert.match(workflow, /--deny-self-hosted-runners/)
  assert.deepEqual(verifierArgs(workflow), ['"${GITHUB_SHA}"', parentCommit, ...expectedDelta])
})

test('Main44 manifest binds every changed normalized Git blob except itself', async () => {
  const manifest = JSON.parse(await readText(manifestPath))
  assert.equal(manifest.releaseVersion, 'v105-v10-main.44')
  assert.equal(manifest.gitTag, 'v105-v10-main.44')
  assert.equal(manifest.parentCommit, parentCommit)
  assert.equal(manifest.releaseScope.formalConsumerChanged, true)
  assert.equal(manifest.releaseScope.frontendChanged, false)
  assert.equal(manifest.releaseScope.databaseChanged, false)
  assert.deepEqual(manifest.workflowContract.allowedChangedPaths, expectedDelta)
  assert.deepEqual(Object.keys(manifest.releaseBinding.changedFileSha256), expectedBindings)
  for (const relativePath of expectedBindings) {
    assert.equal(manifest.releaseBinding.changedFileSha256[relativePath], sha256(gitBlob(relativePath)), relativePath)
  }
})

test('Main44 report preserves Main43 live failure and closes no production gate', async () => {
  const report = JSON.parse(await readText(reportPath))
  assert.equal(report.releaseVersion, 'v105-v10-main.44')
  assert.equal(report.predecessor.releaseVersion, 'v105-v10-main.43')
  assert.equal(report.predecessor.status, 'LIVE_GATE_FAIL')
  assert.equal(report.productionIncidentEvidence.processingBatchAgeSeconds, 88)
  assert.equal(report.productionIncidentEvidence.deadLetterDelta, 0)
  assert.equal(report.runtimeEvidence.captureOutboxSuite, '55/55 PASS')
  assert.equal(report.runtimeEvidence.proxySuite, '1070/1070 PASS')
  for (const value of Object.values(report.productionGates)) assert.match(value, /^(?:PENDING|BLOCK)$/)
  assert.ok(!JSON.stringify(report.productionGates).includes('PASS'))
})
