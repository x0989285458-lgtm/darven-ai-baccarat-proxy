import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const parentCommit = '89c539ca2e32c71c13aa1a7b1f41be721f5acd29'
const migrationPath = 'supabase/migrations/20260828090000_v105_capture_outbox_adaptive_batch.sql'
const rollbackPath = 'supabase/operations/rollback_v105_main56_adaptive_batch_to_main54_batch100.sql'
const harnessPath = 'scripts/test-main56-adaptive-batch-migration.mjs'
const workflowPath = '.github/workflows/trusted-migration-main56.yml'
const releaseTestPath = 'proxy/test/v105-v10-main56-adaptive-batch-release.test.js'
const expectedDelta = [workflowPath, releaseTestPath, harnessPath, migrationPath, rollbackPath]
const expectedMigrationSha256 = '5026e4e8d504dff8a2f194f9a714e82a5f0dd6b1179cfd9ad08866e909adced7'
const headCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
const stagedMode = headCommit === parentCommit
const candidateRef = stagedMode ? '' : 'HEAD'
const gitBlob = (relativePath) => execFileSync('git', ['show', `${candidateRef}:${relativePath}`], { cwd: root, encoding: null, windowsHide: true })
const readText = (relativePath) => gitBlob(relativePath).toString('utf8')
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const normalize = (value) => value.replace(/\r/g, '').replace(/[\t\n ]+/g, '').toLowerCase()
const claimFunction = (sql) => {
  const match = sql.match(/create or replace function public\.claim_v105_capture_settlement_outbox_batch[\s\S]*?\n\$\$;/i)
  assert.ok(match, 'claim function must exist')
  return normalize(match[0])
}

test('Main56 is an exact five-file DB-only adaptive-claim delta over Main54', () => {
  const exactDelta = execFileSync('git', stagedMode
    ? ['diff', '--cached', '--name-only']
    : ['diff', '--name-only', parentCommit, 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true })
    .split('\n').map((value) => value.trim()).filter(Boolean).sort()
  assert.deepEqual(exactDelta, [...expectedDelta].sort())
  if (!stagedMode) {
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD^'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(), parentCommit)
  }
})

test('Main56 migration replaces only claim with the exact adaptive 301/100/10 contract', () => {
  const sqlBlob = gitBlob(migrationPath)
  const sql = sqlBlob.toString('utf8')
  assert.equal(sha256(sqlBlob), expectedMigrationSha256)
  assert.equal((sql.match(/create or replace function public\./gi) ?? []).length, 1)
  assert.match(sql, /p_limit is null or p_limit < 1 or p_limit > 100/i)
  assert.match(sql, /ordered as materialized/i)
  assert.match(sql, /from ordered as ready/i)
  assert.match(sql, /where ready\.blocked is false/i)
  assert.match(sql, /offset 300 limit 1/i)
  assert.match(sql, /then 100 else 10 end as effective_max/i)
  assert.match(sql, /limit least\(p_limit, \(select batch_policy\.effective_max from batch_policy\)\)/i)
  assert.match(sql, /order by ordered\.sequence/i)
  assert.match(sql, /for update skip locked/i)
  assert.match(sql, /lease_generation = outbox\.lease_generation \+ 1/i)
  assert.match(sql, /claim_token = pg_catalog\.gen_random_uuid\(\)/i)
  assert.match(sql, /security definer[\s\S]*set search_path = pg_catalog, public, extensions/i)
  assert.doesNotMatch(sql, /\b(?:grant|revoke|alter owner|owner to)\b/i)
  assert.doesNotMatch(sql, /complete_v105_capture_settlement_outbox_batch|fail_v105_capture_settlement_outbox_batch/i)
})

test('Main56 rollback restores the exact Main54 claim100 function', () => {
  const rollback = readText(rollbackPath)
  const main54 = execFileSync('git', ['show', `${parentCommit}:supabase/migrations/20260828010000_v105_capture_outbox_batch100_contract.sql`], { cwd: root, encoding: 'utf8', windowsHide: true })
  assert.equal((rollback.match(/create or replace function public\./gi) ?? []).length, 1)
  assert.equal(claimFunction(rollback), claimFunction(main54))
})

test('Main56 harness is rollback-only and proves both watermarks, rejection, and isolation', () => {
  const script = readText(harnessPath)
  assert.match(script, /MAIN56_ADAPTIVE_BATCH_TEST_MODE.*rollback-only/s)
  assert.match(script, /ROLLBACK_ONLY_NO_COMMIT/)
  assert.match(script, /lock table public\.v105_capture_settlement_outbox in share row exclusive mode/i)
  assert.match(script, /insertPending\(lowSession, 20/i)
  assert.match(script, /insertPending\(highSession, 301/i)
  assert.match(script, /insertPending\(barrierSession, 302/i)
  assert.match(script, /sequence=15/i)
  assert.match(script, /claim_v105_capture_settlement_outbox_batch\(100\)/i)
  assert.match(script, /claim_v105_capture_settlement_outbox_batch\(101\)/i)
  assert.match(script, /lowSessionClaimed: 10/)
  assert.match(script, /highSessionClaimed: 100/)
  assert.match(script, /barrierSessionClaimed: 10/)
  assert.match(script, /request101Rejected: true/)
  assert.match(script, /crossSessionIsolated: true/)
  assert.match(script, /rollback: true/)
  assert.doesNotMatch(script, /db\.query\(['"]commit['"]\)/i)
})

test('Main56 trusted tag workflow tests migration only and never builds an image', () => {
  const workflow = readText(workflowPath)
  assert.match(workflow, /v105-v10-main\.56/g)
  assert.match(workflow, /node --test proxy\/test\/v105-v10-main56-adaptive-batch-release\.test\.js/)
  assert.match(workflow, /node --test proxy\/test\/capture-outbox-ack\.test\.js/)
  assert.doesNotMatch(workflow, /v105-v10-main54-batch100-release\.test\.js/)
  assert.match(workflow, /node --check scripts\/test-main56-adaptive-batch-migration\.mjs/)
  assert.doesNotMatch(workflow, /docker|buildx|ghcr|attest|packages:\s*write/i)
})
