import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const parentCommit = '594ce187145449bd6d2afab7a12b348cf8e2e08e'
const workflowPath = '.github/workflows/trusted-release-images-main45.yml'
const manifestPath = 'release/v105-v10-main45-read-only-tables-release-manifest.json'
const reportPath = 'release/v105-v10-main45-read-only-tables-release-report.json'
const releaseTestPath = 'proxy/test/v105-v10-main45-read-only-tables-release.test.js'
const expectedDelta = [
  workflowPath,
  'proxy/src/server.js',
  'proxy/test/backend-prediction-source.test.js',
  'proxy/test/v105-v10-main44-lease-scoped-barrier-release.test.js',
  releaseTestPath,
  manifestPath,
  reportPath,
]
const expectedBindings = expectedDelta.filter((relativePath) => relativePath !== manifestPath)
const gitBlob = (relativePath) => execFileSync('git', ['show', `:${relativePath}`], { cwd: root, encoding: null, windowsHide: true })
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

test('Main45 workflow builds only Proxy from exact tag and Main44 parent', async () => {
  const workflow = await readText(workflowPath)
  assert.match(workflow, /tags:\n\s+- v105-v10-main\.45/)
  assert.match(workflow, /if: github\.ref == 'refs\/tags\/v105-v10-main\.45'/)
  assert.match(workflow, /ref: refs\/tags\/v105-v10-main\.45/)
  assert.match(workflow, /IMAGE: darven-ai-baccarat-proxy/)
  assert.match(workflow, /file: proxy\/Dockerfile\.evidence/)
  assert.doesNotMatch(workflow, /IMAGE: darven-ai-baccarat-(?:formal-consumer|worker)/)
  assert.match(workflow, /gh attestation verify/)
  assert.match(workflow, /--deny-self-hosted-runners/)
  assert.deepEqual(verifierArgs(workflow), ['"${GITHUB_SHA}"', parentCommit, ...expectedDelta])
})

test('Main45 manifest binds every changed normalized Git blob except itself', async () => {
  const manifest = JSON.parse(await readText(manifestPath))
  assert.equal(manifest.releaseVersion, 'v105-v10-main.45')
  assert.equal(manifest.gitTag, 'v105-v10-main.45')
  assert.equal(manifest.parentCommit, parentCommit)
  assert.equal(manifest.releaseScope.proxyDeploymentChanged, true)
  assert.equal(manifest.releaseScope.formalConsumerChanged, false)
  assert.equal(manifest.releaseScope.frontendChanged, false)
  assert.equal(manifest.releaseScope.databaseChanged, false)
  assert.deepEqual(manifest.workflowContract.allowedChangedPaths, expectedDelta)
  assert.deepEqual(Object.keys(manifest.releaseBinding.changedFileSha256), expectedBindings)
  for (const relativePath of expectedBindings) {
    assert.equal(manifest.releaseBinding.changedFileSha256[relativePath], sha256(gitBlob(relativePath)), relativePath)
  }
})

test('Main45 report preserves Main44 formal pass and current production latency block', async () => {
  const report = JSON.parse(await readText(reportPath))
  assert.equal(report.releaseVersion, 'v105-v10-main.45')
  assert.equal(report.predecessor.releaseVersion, 'v105-v10-main.44')
  assert.equal(report.predecessor.formalConsumerStatus, 'LIVE_PASS')
  assert.equal(report.predecessor.productionStatus, 'LIVE_GATE_FAIL')
  assert.equal(report.runtimeEvidence.readOnlyIssuanceGreen, '1/1 PASS')
  assert.equal(report.runtimeEvidence.adjacentSuite, '83/83 PASS')
  assert.equal(report.runtimeEvidence.proxySuite, '1074/1074 PASS')
  assert.equal(report.productionLatencyEvidence.trustedReviewV2.memberTablesMs, 17078)
  assert.equal(report.productionLatencyEvidence.trustedReviewV2.roundReadySseMs, 17535)
  assert.equal(report.main44FormalEvidence.finalActive, 0)
  assert.equal(report.main44FormalEvidence.tenTableSettlement, '10/10')
  for (const value of Object.values(report.productionGates)) assert.match(value, /^(?:PENDING|BLOCK)$/)
  assert.ok(!JSON.stringify(report.productionGates).includes('PASS'))
})
