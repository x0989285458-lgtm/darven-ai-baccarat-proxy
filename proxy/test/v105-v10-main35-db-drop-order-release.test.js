import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const oldMigrationPath = 'supabase/migrations/20260826040000_v105_main33_legacy_runtime_teardown.sql'
const migrationPath = 'supabase/migrations/20260826105000_v105_main35_legacy_runtime_teardown_drop_order.sql'
const manifestPath = 'release/v105-v10-main35-db-drop-order-release-manifest.json'
const reportPath = 'release/v105-v10-main35-db-drop-order-release-report.json'
const expectedPaths = [
  'proxy/test/v105-v10-main35-db-drop-order-release.test.js',
  'release/v105-v10-main35-db-drop-order-release-manifest.json',
  'release/v105-v10-main35-db-drop-order-release-report.json',
  migrationPath,
]
const read = (p) => readFile(path.join(root, p), 'utf8')
const readJson = async (p) => JSON.parse(await read(p))
const indexBytes = (p) => execFileSync('git', ['show', `:${p}`], { cwd: root })
const dropNames = (sql, kind) => [...sql.matchAll(new RegExp(`^drop\\s+${kind}\\s+if\\s+exists\\s+public\\.([a-z0-9_]+)`, 'gim'))].map((m) => m[1]).sort()

test('Main35 preserves the exact Main33 teardown allowlist while ordering every function before views and tables', async () => {
  const [oldSql, sql] = await Promise.all([read(oldMigrationPath), read(migrationPath)])
  assert.deepEqual(dropNames(sql, 'function'), dropNames(oldSql, 'function'))
  assert.deepEqual(dropNames(sql, 'view'), dropNames(oldSql, 'view'))
  assert.deepEqual(dropNames(sql, 'table'), dropNames(oldSql, 'table'))
  assert.equal(dropNames(sql, 'function').length, 51)
  assert.equal(dropNames(sql, 'view').length, 11)
  assert.equal(dropNames(sql, 'table').length, 53)
  const triggerDrops = [...sql.matchAll(/^drop\s+trigger\s+if\s+exists\s+([a-z0-9_]+)\s+on\s+public\.([a-z0-9_]+)/gim)].map((m) => [m[1], m[2]])
  assert.deepEqual(triggerDrops, [['v104_iteration_shadow_2000_settlement_cap', 'v104_iteration_shadow_settlements']])
  const lower = sql.toLowerCase()
  assert.ok(lower.indexOf('drop trigger if exists v104_iteration_shadow_2000_settlement_cap on public.v104_iteration_shadow_settlements') < lower.indexOf('drop function if exists public.enforce_v104_iteration_shadow_2000_settlement_cap()'))
  const lastFunction = lower.lastIndexOf('drop function')
  const firstView = lower.indexOf('drop view')
  const firstTable = lower.indexOf('drop table')
  assert.ok(lastFunction >= 0 && lastFunction < firstView && lastFunction < firstTable)
  assert.ok(lower.indexOf('drop function if exists public.get_v103_shadow_history(integer)') < lower.indexOf('drop view if exists public.v103_shadow_history'))
  assert.doesNotMatch(sql, /\bcascade\b/i)
})

test('Main35 retains transaction locks, active-v105 gate, disabled-settings gate and exact commit boundary', async () => {
  const sql = await read(migrationPath)
  assert.match(sql, /^begin;/)
  assert.match(sql, /lock\s+table[\s\S]*share\s+row\s+exclusive\s+mode/i)
  assert.match(sql, /select\s+count\(\*\)[\s\S]*ai_strategy_versions[\s\S]*status\s*=\s*'active'\)\s*<>\s*1/i)
  assert.match(sql, /not\s+exists[\s\S]*status\s*=\s*'active'\s+and\s+version\s*=\s*'v105'/i)
  assert.match(sql, /enabled_count\s*<>\s*0[\s\S]*non_disabled_count\s*<>\s*0/i)
  assert.match(sql, /commit;\s*$/)
})

test('Main35 manifest is DB-only over immutable Main34 and binds every non-self index blob', async () => {
  const manifest = await readJson(manifestPath)
  const report = await readJson(reportPath)
  assert.equal(manifest.releaseVersion, 'v105-v10-main.35')
  assert.equal(manifest.gitTag, 'v105-v10-main.35')
  assert.equal(manifest.baseCommit, 'ed4d5650c8891eadb33715177d254c47cbfe912e')
  assert.equal(manifest.runtimeSourceVersion, 'v105-v10-main.34')
  assert.deepEqual(manifest.releaseContract.allowedChangedPaths, expectedPaths)
  assert.equal(Object.values(manifest.releaseScope).filter(Boolean).length, 1)
  assert.equal(manifest.releaseScope.databaseMigrationChanged, true)
  assert.deepEqual(Object.keys(manifest.releaseBinding.changedFileSha256).sort(), expectedPaths.filter((p) => p !== manifestPath).sort())
  for (const [p, expected] of Object.entries(manifest.releaseBinding.changedFileSha256)) {
    assert.equal(createHash('sha256').update(indexBytes(p)).digest('hex'), expected, p)
  }
  assert.equal(report.releaseVersion, 'v105-v10-main.35')
  assert.equal(report.main33TeardownFormal, 'BLOCK_ROLLED_BACK')
  assert.equal(report.productionGates.finalVerdict, 'BLOCK')
})
