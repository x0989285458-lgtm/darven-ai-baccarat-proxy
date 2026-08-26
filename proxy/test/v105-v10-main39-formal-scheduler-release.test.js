import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const workflowPath = '.github/workflows/trusted-release-images-main39.yml'
const manifestPath = 'release/v105-v10-main39-formal-scheduler-release-manifest.json'
const reportPath = 'release/v105-v10-main39-formal-scheduler-release-report.json'
const releaseTestPath = 'proxy/test/v105-v10-main39-formal-scheduler-release.test.js'
const main38HistoricalTestPath = 'proxy/test/v105-v10-main38-formal-scheduler-release.test.js'
const expectedDelta = [workflowPath, main38HistoricalTestPath, releaseTestPath, manifestPath, reportPath]
const expectedBindings = [
  workflowPath,
  'proxy/src/server.js',
  'proxy/test/capture-outbox-ack.test.js',
  main38HistoricalTestPath,
  releaseTestPath,
  reportPath,
]
const main39Commit = '30aa84d4224e65557806a9b3865426802767674d'
const gitBlob = (relativePath) => execFileSync('git', ['show', `${main39Commit}:${relativePath}`], {
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

test('Main39 workflow builds only Formal Consumer from exact tag and Main38 parent', async () => {
  const workflow = await readText(workflowPath)
  assert.match(workflow, /tags:\n\s+- v105-v10-main\.39/)
  assert.match(workflow, /if: github\.ref == 'refs\/tags\/v105-v10-main\.39'/)
  assert.match(workflow, /ref: refs\/tags\/v105-v10-main\.39/)
  assert.match(workflow, /IMAGE: darven-ai-baccarat-formal-consumer/)
  assert.match(workflow, /file: proxy\/Dockerfile\.formal-consumer/)
  assert.doesNotMatch(workflow, /IMAGE: darven-ai-baccarat-(?:proxy|worker)/)
  assert.match(workflow, /gh attestation verify/)
  assert.match(workflow, /--source-digest "\$\{GITHUB_SHA\}"/)
  assert.match(workflow, /--source-ref "\$\{GITHUB_REF\}"/)
  assert.match(workflow, /--deny-self-hosted-runners/)
  assert.deepEqual(verifierArgs(workflow), [
    '"${GITHUB_SHA}"',
    '5f25bee269db9f55aedd5d6f1ff4345d16077a88',
    ...expectedDelta,
  ])
})

test('Main39 manifest binds inherited Main38 runtime and every normalized Git blob', async () => {
  const manifest = JSON.parse(await readText(manifestPath))
  assert.equal(manifest.releaseVersion, 'v105-v10-main.39')
  assert.equal(manifest.gitTag, 'v105-v10-main.39')
  assert.equal(manifest.liveBaseCommit, '7c81b01bbc605d1aff7a1ca0ed2bf8a918e9af0f')
  assert.equal(manifest.inheritedRuntimeCommit, '5f25bee269db9f55aedd5d6f1ff4345d16077a88')
  assert.equal(manifest.releaseScope.runtimeChangedFromLiveBase, true)
  assert.equal(manifest.releaseScope.overlayRuntimeChanged, false)
  assert.equal(manifest.releaseScope.formalConsumerChangedFromLiveBase, true)
  assert.deepEqual(manifest.workflowContract.allowedChangedPaths, expectedDelta)
  assert.deepEqual(Object.keys(manifest.releaseBinding.changedFileSha256), expectedBindings)
  for (const relativePath of expectedBindings) {
    assert.equal(manifest.releaseBinding.changedFileSha256[relativePath], sha256(gitBlob(relativePath)), relativePath)
  }
})

test('Main39 report preserves Main38 release-test BLOCK and closes no production gate', async () => {
  const report = JSON.parse(await readText(reportPath))
  assert.equal(report.releaseVersion, 'v105-v10-main.39')
  assert.equal(report.predecessor.releaseVersion, 'v105-v10-main.38')
  assert.equal(report.predecessor.status, 'BLOCK')
  assert.match(report.predecessor.reason, /CRLF|checkout|worktree/i)
  assert.equal(report.runtimeEvidence.targetRegression, '3/3 PASS')
  assert.equal(report.runtimeEvidence.proxySuite, '1042/1042 PASS')
  for (const value of Object.values(report.productionGates)) assert.match(value, /^(?:PENDING|BLOCK)$/)
  assert.ok(!JSON.stringify(report.productionGates).includes('PASS'))
})
