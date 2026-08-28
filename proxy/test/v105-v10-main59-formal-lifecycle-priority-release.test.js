import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const parentCommit = '99b3577b42f44958bba996fb8eab37f4c9885b1b'
const workflowPath = '.github/workflows/trusted-release-images-main59.yml'
const sourcePath = 'proxy/src/supabase-writer.js'
const regressionPath = 'proxy/test/supabase-writer.test.js'
const releaseTestPath = 'proxy/test/v105-v10-main59-formal-lifecycle-priority-release.test.js'
const expectedDelta = [workflowPath, sourcePath, regressionPath, releaseTestPath]
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
const stagedMode = head === parentCommit
const candidateRef = stagedMode ? '' : 'HEAD'
const gitText = (relativePath) => execFileSync('git', ['show', `${candidateRef}:${relativePath}`], { cwd: root, encoding: 'utf8', windowsHide: true })

test('Main59 is an exact four-file release over immutable Main58', () => {
  const delta = execFileSync('git', stagedMode
    ? ['diff', '--cached', '--name-only']
    : ['diff', '--name-only', parentCommit, 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true })
    .split('\n').map((value) => value.trim()).filter(Boolean).sort()
  assert.deepEqual(delta, [...expectedDelta].sort())
  if (!stagedMode) assert.equal(execFileSync('git', ['rev-parse', 'HEAD^'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(), parentCommit)
})

test('Main59 routes the exact Formal Lifecycle RPC through the reserved priority scheduler', () => {
  const source = gitText(sourcePath)
  assert.match(source, /postDurableRest\('rpc\/reconcile_v105_prediction_lifecycle',[\s\S]{0,500}\{ requireObject: true, priority: true \}\)\)/)
  const regression = gitText(regressionPath)
  assert.match(regression, /prediction lifecycle reconciliation uses the reserved priority slot when standard traffic is saturated/)
  assert.match(regression, /startedWhileStandardSaturated, 1/)
})

test('Main59 workflow binds Node24 tests, exact image, and provenance', () => {
  const workflow = gitText(workflowPath)
  assert.match(workflow, /v105-v10-main\.59/g)
  assert.match(workflow, /node-version: '24'/)
  assert.match(workflow, /supabase-writer\.test\.js proxy\/test\/capture-outbox-ack\.test\.js/)
  assert.match(workflow, /proxy\/Dockerfile\.formal-consumer/)
  assert.match(workflow, /actions\/attest-build-provenance@977bb373ede98d70efdf65b84cb5f73e068dcc2a/)
  assert.match(workflow, /--deny-self-hosted-runners/)
})
