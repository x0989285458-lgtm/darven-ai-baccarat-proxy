import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const parentCommit = '2065cc1f4fe773cd0ca7b20e8dadc5a0478707fd'
const workflowPath = '.github/workflows/trusted-release-images-main43.yml'
const manifestPath = 'release/v105-v10-main43-settlement-receipt-release-manifest.json'
const reportPath = 'release/v105-v10-main43-settlement-receipt-release-report.json'
const releaseTestPath = 'proxy/test/v105-v10-main43-settlement-receipt-release.test.js'
const expectedDelta = [
  workflowPath,
  'proxy/src/supabase-writer.js',
  'proxy/test/supabase-writer.test.js',
  'proxy/test/v105-v10-main42-formal-keyed-lanes-release.test.js',
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

test('Main43 workflow builds only Formal Consumer from exact tag and Main42 parent', async () => {
  const workflow = await readText(workflowPath)
  assert.match(workflow, /tags:\n\s+- v105-v10-main\.43/)
  assert.match(workflow, /if: github\.ref == 'refs\/tags\/v105-v10-main\.43'/)
  assert.match(workflow, /ref: refs\/tags\/v105-v10-main\.43/)
  assert.match(workflow, /IMAGE: darven-ai-baccarat-formal-consumer/)
  assert.match(workflow, /file: proxy\/Dockerfile\.formal-consumer/)
  assert.doesNotMatch(workflow, /IMAGE: darven-ai-baccarat-(?:proxy|worker)/)
  assert.match(workflow, /gh attestation verify/)
  assert.match(workflow, /--deny-self-hosted-runners/)
  assert.deepEqual(verifierArgs(workflow), ['"${GITHUB_SHA}"', parentCommit, ...expectedDelta])
})

test('Main43 manifest binds every changed normalized Git blob except itself', async () => {
  const manifest = JSON.parse(await readText(manifestPath))
  assert.equal(manifest.releaseVersion, 'v105-v10-main.43')
  assert.equal(manifest.gitTag, 'v105-v10-main.43')
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

test('Main43 report records Main42 live failure and closes no production gate', async () => {
  const report = JSON.parse(await readText(reportPath))
  assert.equal(report.releaseVersion, 'v105-v10-main.43')
  assert.equal(report.predecessor.releaseVersion, 'v105-v10-main.42')
  assert.equal(report.predecessor.status, 'LIVE_GATE_FAIL')
  assert.equal(report.productionIncidentEvidence.deadLetterRowsAtStop, 60)
  assert.equal(report.runtimeEvidence.writerSuite, '7/7 PASS')
  assert.equal(report.runtimeEvidence.proxySuite, '1066/1066 PASS')
  for (const value of Object.values(report.productionGates)) assert.match(value, /^(?:PENDING|BLOCK)$/)
  assert.ok(!JSON.stringify(report.productionGates).includes('PASS'))
})
