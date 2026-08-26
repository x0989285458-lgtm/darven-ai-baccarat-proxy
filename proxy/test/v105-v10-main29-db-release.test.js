import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../../', import.meta.url))
const migrationPath = 'supabase/migrations/20260826030000_v105_capture_outbox_batch_limit_drift_repair.sql'
const migrationBytes = () => execFileSync('git', ['show', `v105-v10-main.29:${migrationPath}`], { cwd: root })
test('Main29 migration uses PostgreSQL POSIX whitespace normalization and restores batch ten without rewriting queue', () => {
  const sql = migrationBytes().toString('utf8')
  assert.match(sql, /claim_v105_capture_settlement_outbox_batch\(p_limit integer default 10\)/i)
  assert.match(sql, /limit greatest\(1, least\(coalesce\(p_limit, 10\), 10\)\)/i)
  assert.match(sql, /regexp_replace\([\s\S]*'\[\[:space:\]\]\+'[\s\S]*pg_catalog\.strpos/i)
  assert.doesNotMatch(sql, /'\\s\+'|pg_catalog\.position|coalesce\(p_limit, 3\)|\b(drop|truncate|delete\s+from)\b/i)
})

const manifest = JSON.parse(readFileSync(new URL('../../release/v105-v10-main29-db-batch-limit-release-manifest.json', import.meta.url)))
const report = JSON.parse(readFileSync(new URL('../../release/v105-v10-main29-db-batch-limit-release-report.json', import.meta.url)))
test('Main29 is migration-only and records every prior blocked gate', () => {
  assert.equal(manifest.releaseVersion, 'v105-v10-main.29')
  assert.equal(manifest.baseCommit, 'f03e98436636b5c4c87df27a8e48f317d7827df1')
  assert.equal(manifest.runtimeReleaseVersion, 'v105-v10-main.26')
  assert.equal(manifest.releaseScope.databaseMigrationOnly, true)
  assert.equal(Object.values(manifest.releaseScope).filter(Boolean).length, 1)
  assert.equal(manifest.incident.main28Preflight, 'BLOCK')
})
test('Main29 binds exact migration bytes and POSIX normalization contract', () => {
  const bytes=migrationBytes()
  assert.equal(createHash('sha256').update(bytes).digest('hex'),manifest.releaseBinding.migration.sha256)
  assert.equal(manifest.releaseBinding.normalizationContract,'[[:space:]]+')
  assert.equal(manifest.releaseBinding.preconditionContract,'limit greatest(1, least(coalesce(p_limit, 3), 3))')
  assert.equal(manifest.releaseBinding.postconditionContract,'limit greatest(1, least(coalesce(p_limit, 10), 10))')
})
test('Main29 requires natural queue drain and cannot self-approve production',()=>{
  assert.ok(manifest.deploymentOrder.includes('verify-queue-natural-drain-without-delete'))
  assert.equal(report.priorBlocks.main28Preflight,'BLOCK')
  assert.ok(Object.values(report.productionGates).every(v=>v===false))
})
