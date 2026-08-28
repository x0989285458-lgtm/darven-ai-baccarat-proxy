import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const parentCommit = '3fc6a288929966274919d32c0aa019d3b7efde6f'
const workflowPath = '.github/workflows/trusted-migration-main57.yml'
const releaseTestPath = 'proxy/test/v105-v10-main57-migration-ci-release.test.js'
const expectedDelta = [workflowPath, releaseTestPath]
const migrationPath = 'supabase/migrations/20260828090000_v105_capture_outbox_adaptive_batch.sql'
const expectedMigrationSha256 = '5026e4e8d504dff8a2f194f9a714e82a5f0dd6b1179cfd9ad08866e909adced7'
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
const stagedMode = head === parentCommit
const candidateRef = stagedMode ? '' : 'HEAD'
const gitBlob = (relativePath) => execFileSync('git', ['show', `${candidateRef}:${relativePath}`], { cwd: root, encoding: null, windowsHide: true })
const sha256 = (value) => createHash('sha256').update(value).digest('hex')

test('Main57 is an exact two-file CI-only correction over immutable Main56', () => {
  const delta = execFileSync('git', stagedMode
    ? ['diff', '--cached', '--name-only']
    : ['diff', '--name-only', parentCommit, 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true })
    .split('\n').map((value) => value.trim()).filter(Boolean).sort()
  assert.deepEqual(delta, [...expectedDelta].sort())
  if (!stagedMode) {
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD^'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(), parentCommit)
  }
})

test('Main57 preserves the exact reviewed Main56 adaptive migration', () => {
  assert.equal(sha256(gitBlob(migrationPath)), expectedMigrationSha256)
  const parentBlob = execFileSync('git', ['show', `${parentCommit}:${migrationPath}`], { cwd: root, encoding: null, windowsHide: true })
  assert.equal(sha256(parentBlob), expectedMigrationSha256)
})

test('Main57 trusted workflow installs exact dependencies before ACK tests', () => {
  const workflow = gitBlob(workflowPath).toString('utf8')
  assert.match(workflow, /v105-v10-main\.57/g)
  assert.match(workflow, /node --test proxy\/test\/v105-v10-main57-migration-ci-release\.test\.js/)
  assert.match(workflow, /npm ci --prefix proxy/)
  assert.match(workflow, /node --test proxy\/test\/capture-outbox-ack\.test\.js/)
  assert.ok(workflow.indexOf('npm ci --prefix proxy') < workflow.indexOf('node --test proxy/test/capture-outbox-ack.test.js'))
  assert.match(workflow, /node --check scripts\/test-main56-adaptive-batch-migration\.mjs/)
  assert.doesNotMatch(workflow, /docker|buildx|ghcr|attest|packages:\s*write/i)
})
