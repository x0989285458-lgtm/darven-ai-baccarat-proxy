import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../../', import.meta.url))
const migrationPath = 'supabase/migrations/20260826020000_v105_capture_outbox_batch_limit_drift_repair.sql'
const migrationBytes = () => execFileSync('git', ['show', `v105-v10-main.28:${migrationPath}`], { cwd: root })
test('Main28 corrective migration restores ten, uses valid strpos verification, and preserves queued history', () => {
  const sql = migrationBytes().toString('utf8')
  assert.match(sql, /claim_v105_capture_settlement_outbox_batch\(p_limit integer default 10\)/i)
  assert.match(sql, /limit greatest\(1, least\(coalesce\(p_limit, 10\), 10\)\)/i)
  assert.match(sql, /pg_catalog\.strpos\([\s\S]*limitgreatest\(1,least\(coalesce\(p_limit,10\),10\)\)/i)
  assert.match(sql, /raise exception 'capture outbox batch limit contract verification failed'/i)
  assert.doesNotMatch(sql, /pg_catalog\.position|coalesce\(p_limit, 3\)|\b(drop|truncate|delete\s+from)\b/i)
})

const manifest = JSON.parse(readFileSync(new URL('../../release/v105-v10-main28-db-batch-limit-release-manifest.json', import.meta.url)))
const report = JSON.parse(readFileSync(new URL('../../release/v105-v10-main28-db-batch-limit-release-report.json', import.meta.url)))
test('Main28 is migration-only over Main26 and records both prior blocks', () => {
  assert.equal(manifest.releaseVersion, 'v105-v10-main.28')
  assert.equal(manifest.baseCommit, '4ae9d2cc62460fd8b64d8c5ad38fa336ba3e3b56')
  assert.equal(manifest.runtimeReleaseVersion, 'v105-v10-main.26')
  assert.equal(manifest.releaseScope.databaseMigrationOnly, true)
  assert.equal(Object.values(manifest.releaseScope).filter(Boolean).length, 1)
  assert.equal(manifest.incident.main26FormalGate, 'BLOCK')
  assert.equal(manifest.incident.main27Review, 'BLOCK')
})
test('Main28 binds the exact migration bytes and pre/post production contracts', () => {
  const bytes = migrationBytes()
  assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.releaseBinding.migration.sha256)
  assert.equal(manifest.releaseBinding.preconditionContract, 'limit greatest(1, least(coalesce(p_limit, 3), 3))')
  assert.equal(manifest.releaseBinding.postconditionContract, 'limit greatest(1, least(coalesce(p_limit, 10), 10))')
})
test('Main28 deployment requires natural queue drain and cannot self-approve production', () => {
  assert.ok(manifest.deploymentOrder.includes('verify-queue-natural-drain-without-delete'))
  assert.equal(report.releaseVersion, manifest.releaseVersion)
  assert.equal(report.priorBlocks.main27Review, 'BLOCK')
  assert.ok(Object.values(report.productionGates).every((value) => value === false))
})
