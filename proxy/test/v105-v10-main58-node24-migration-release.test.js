import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const parentCommit = 'b163dc339c42310de0b7c3a88732cc70eb0fe34c'
const workflowPath = '.github/workflows/trusted-migration-main58.yml'
const releaseTestPath = 'proxy/test/v105-v10-main58-node24-migration-release.test.js'
const expectedDelta = [workflowPath, releaseTestPath]
const migrationPath = 'supabase/migrations/20260828090000_v105_capture_outbox_adaptive_batch.sql'
const expectedMigrationSha256 = '5026e4e8d504dff8a2f194f9a714e82a5f0dd6b1179cfd9ad08866e909adced7'
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
const stagedMode = head === parentCommit
const candidateRef = stagedMode ? '' : 'HEAD'
const gitBlob = (relativePath) => execFileSync('git', ['show', `${candidateRef}:${relativePath}`], { cwd: root, encoding: null, windowsHide: true })
const sha256 = (value) => createHash('sha256').update(value).digest('hex')

test('Main58 is an exact two-file Node24 CI correction over immutable Main57', () => {
  const delta = execFileSync('git', stagedMode
    ? ['diff', '--cached', '--name-only']
    : ['diff', '--name-only', parentCommit, 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true })
    .split('\n').map((value) => value.trim()).filter(Boolean).sort()
  assert.deepEqual(delta, [...expectedDelta].sort())
  if (!stagedMode) assert.equal(execFileSync('git', ['rev-parse', 'HEAD^'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(), parentCommit)
})

test('Main58 preserves the exact reviewed Main56 adaptive migration', () => {
  assert.equal(sha256(gitBlob(migrationPath)), expectedMigrationSha256)
  assert.equal(sha256(execFileSync('git', ['show', `${parentCommit}:${migrationPath}`], { cwd: root, encoding: null, windowsHide: true })), expectedMigrationSha256)
})

test('Main58 pins Node24 before dependency install and ACK tests', () => {
  const workflow = gitBlob(workflowPath).toString('utf8')
  assert.match(workflow, /v105-v10-main\.58/g)
  assert.match(workflow, /actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020/)
  assert.match(workflow, /node-version: '24'/)
  assert.match(workflow, /cache-dependency-path: proxy\/package-lock\.json/)
  assert.match(workflow, /npm ci --prefix proxy/)
  assert.match(workflow, /node --test proxy\/test\/capture-outbox-ack\.test\.js/)
  assert.ok(workflow.indexOf('actions/setup-node@') < workflow.indexOf('npm ci --prefix proxy'))
  assert.ok(workflow.indexOf('npm ci --prefix proxy') < workflow.indexOf('node --test proxy/test/capture-outbox-ack.test.js'))
  assert.doesNotMatch(workflow, /docker|buildx|ghcr|attest|packages:\s*write/i)
})
