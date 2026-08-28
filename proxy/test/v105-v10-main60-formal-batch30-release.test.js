import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const parentCommit = 'e75aa7186a46de32e9bd66fcfd9df7ee8e283dcf'
const workflowPath = '.github/workflows/trusted-release-images-main60.yml'
const sourcePath = 'proxy/src/server.js'
const regressionPath = 'proxy/test/capture-outbox-ack.test.js'
const releaseTestPath = 'proxy/test/v105-v10-main60-formal-batch30-release.test.js'
const migrationPath = 'supabase/migrations/20260828090000_v105_capture_outbox_adaptive_batch.sql'
const migrationSha256 = '5026e4e8d504dff8a2f194f9a714e82a5f0dd6b1179cfd9ad08866e909adced7'
const expectedDelta = [workflowPath, sourcePath, regressionPath, releaseTestPath]
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
const stagedMode = head === parentCommit
const candidateRef = stagedMode ? '' : 'HEAD'
const gitBlob = (relativePath) => execFileSync('git', ['show', `${candidateRef}:${relativePath}`], { cwd: root, encoding: null, windowsHide: true })
const gitText = (relativePath) => gitBlob(relativePath).toString('utf8')

test('Main60 is an exact four-file release over immutable Main59', () => {
  const delta = execFileSync('git', stagedMode ? ['diff', '--cached', '--name-only'] : ['diff', '--name-only', parentCommit, 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).split('\n').map(v => v.trim()).filter(Boolean).sort()
  assert.deepEqual(delta, [...expectedDelta].sort())
  if (!stagedMode) assert.equal(execFileSync('git', ['rev-parse', 'HEAD^'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(), parentCommit)
})

test('Main60 defaults Formal Outbox to adaptive Batch30 and preserves its scaled deadline', () => {
  assert.match(gitText(sourcePath), /captureOutboxBatchLimit = process\.env\.CAPTURE_OUTBOX_BATCH_LIMIT \?\? 30/)
  const regression = gitText(regressionPath)
  assert.match(regression, /defaultLimits\[0\], 30/)
  assert.match(regression, /resolveCaptureOutboxLeaseDeadlineMs\(45_000, 30\), 180_000/)
  assert.match(regression, /thirty-row formal batch scales the bounded lease deadline/)
})

test('Main60 preserves the exact reviewed adaptive Claim migration', () => {
  assert.equal(createHash('sha256').update(gitBlob(migrationPath)).digest('hex'), migrationSha256)
})

test('Main60 workflow binds Node24, exact tests, image and provenance', () => {
  const workflow = gitText(workflowPath)
  assert.match(workflow, /v105-v10-main\.60/g)
  assert.match(workflow, /node-version: '24'/)
  assert.match(workflow, /capture-outbox-ack\.test\.js proxy\/test\/supabase-writer\.test\.js/)
  assert.match(workflow, /proxy\/Dockerfile\.formal-consumer/)
  assert.match(workflow, /actions\/attest-build-provenance@977bb373ede98d70efdf65b84cb5f73e068dcc2a/)
  assert.match(workflow, /--deny-self-hosted-runners/)
})
