import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const workflowPath = '.github/workflows/trusted-release-images-main36.yml'
const manifestPath = 'release/v105-v10-main36-formal-scheduler-release-manifest.json'
const reportPath = 'release/v105-v10-main36-formal-scheduler-release-report.json'
const expectedPaths = [
  workflowPath,
  'proxy/src/server.js',
  'proxy/test/capture-outbox-ack.test.js',
  'proxy/test/v105-v10-main36-formal-scheduler-release.test.js',
  manifestPath,
  reportPath,
]
const read = (relativePath) => readFile(path.join(root, relativePath), 'utf8')
const readJson = async (relativePath) => JSON.parse(await read(relativePath))
const sha256 = (text) => createHash('sha256').update(text).digest('hex')

function verifierArgs(workflow) {
  const invocation = workflow.match(/bash scripts\/verify-trusted-release-delta\.sh \\\n([\s\S]*?)\n\n      - name: Set up Docker Buildx/)
  assert.ok(invocation)
  return invocation[1].split('\n').map((line) => line.trim().replace(/ \\$/, '')).filter(Boolean)
}

test('Main36 trusted workflow builds only the Formal Consumer from the exact frozen tag', async () => {
  const workflow = (await read(workflowPath)).replace(/\r\n/g, '\n')
  assert.match(workflow, /tags:\n\s+- v105-v10-main\.36/)
  assert.match(workflow, /if: github\.ref == 'refs\/tags\/v105-v10-main\.36'/)
  assert.match(workflow, /ref: refs\/tags\/v105-v10-main\.36/)
  assert.match(workflow, /IMAGE: darven-ai-baccarat-formal-consumer/)
  assert.match(workflow, /file: proxy\/Dockerfile\.formal-consumer/)
  assert.doesNotMatch(workflow, /IMAGE: darven-ai-baccarat-(?:proxy|worker)/)
  assert.match(workflow, /gh attestation verify/)
  assert.match(workflow, /--source-digest "\$\{GITHUB_SHA\}"/)
  assert.match(workflow, /--source-ref "\$\{GITHUB_REF\}"/)
  assert.match(workflow, /--signer-workflow "\$\{GITHUB_REPOSITORY\}\/\.github\/workflows\/trusted-release-images-main36\.yml"/)
  assert.match(workflow, /--deny-self-hosted-runners/)
  assert.deepEqual(verifierArgs(workflow), [
    '"${GITHUB_SHA}"',
    '7c81b01bbc605d1aff7a1ca0ed2bf8a918e9af0f',
    ...expectedPaths,
  ])
})

test('Main36 manifest binds the exact minimal runtime delta and every non-self artifact', async () => {
  const manifest = await readJson(manifestPath)
  assert.equal(manifest.releaseVersion, 'v105-v10-main.36')
  assert.equal(manifest.gitTag, 'v105-v10-main.36')
  assert.equal(manifest.baseCommit, '7c81b01bbc605d1aff7a1ca0ed2bf8a918e9af0f')
  assert.deepEqual(manifest.releaseScope, {
    runtimeChanged: true,
    formalConsumerChanged: true,
    proxyDeploymentChanged: false,
    databaseChanged: false,
    frontendChanged: false,
    workerChanged: false,
  })
  assert.deepEqual(manifest.workflowContract.allowedChangedPaths, expectedPaths)
  const bindings = manifest.releaseBinding.changedFileSha256
  const boundPaths = expectedPaths.filter((value) => value !== manifestPath)
  assert.deepEqual(Object.keys(bindings).sort(), [...boundPaths].sort())
  for (const relativePath of boundPaths) assert.equal(bindings[relativePath], sha256(await read(relativePath)), relativePath)
})

test('Main36 report records evidence without self-approving production gates', async () => {
  const report = await readJson(reportPath)
  assert.equal(report.releaseVersion, 'v105-v10-main.36')
  assert.match(report.rootCause, /settlement/i)
  assert.match(report.rootCause, /background prediction/i)
  assert.equal(report.evidence.tddRed, 'Main35 reconciled the finalized identity twice (2 !== 1)')
  assert.equal(report.evidence.focusedGreen, '2/2 PASS')
  assert.equal(report.evidence.proxyFullSerial, '1032/1032 PASS')
  assert.ok(Object.values(report.productionGates).every((value) => value !== 'PASS'))
  assert.equal(report.productionGates.finalVerdict, 'BLOCK')
})
