import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const repo = new URL('../../', import.meta.url)
const manifestUrl = new URL('release/v105-shadow-compact-hydration-release-manifest.json', repo)
const runbookUrl = new URL('docs/runbooks/v105-shadow-compact-hydration-release.md', repo)

test('compact hydration release is DB-first with split migration and fail-closed ledger gates', async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'))

  assert.equal(manifest.releaseVersion, 'v105-shadow-compact-hydration.1')
  assert.equal(manifest.gitTag, 'v105-shadow-compact-hydration.1')
  assert.equal(manifest.applicationVersion, '1.0.25')
  assert.equal(manifest.baseRelease, 'v1.0.24')
  assert.deepEqual(manifest.database.migrations, [
    'supabase/migrations/20260730010000_v105_shadow_compact_hydration.sql',
    'supabase/migrations/20260730010100_v105_shadow_compact_hydration_rpcs.sql',
  ])
  assert.equal(manifest.database.indexBuild.concurrent, true)
  assert.equal(manifest.database.indexBuild.explicitTransaction, false)
  assert.equal(manifest.database.rpcMigration.explicitTransaction, true)
  assert.deepEqual(manifest.database.ledgerVersions, ['20260730010000', '20260730010100'])
  assert.equal(manifest.database.blockOnLedgerCatalogMismatch, true)
  assert.equal(manifest.deployment.dbFirst, true)
  assert.equal(manifest.deployment.keepAllShadowRuntimeEnvDisabledUntilDatabaseReadback, true)
  assert.equal(manifest.deployment.keepV6ThroughV9DisabledThroughRelease, true)
  assert.equal(manifest.deployment.runtimeActivation, 'deferred-by-user')
  assert.deepEqual(manifest.deployment.runtimeEnvTarget, {
    V105_SHADOW_V6_ENABLED: 'false',
    V105_SHADOW_V7_ENABLED: 'false',
    V105_SHADOW_V8_ENABLED: 'false',
    V105_SHADOW_V9_ENABLED: 'false',
  })
  assert.equal(manifest.deployment.order.includes('stagger-v6-v7-v8-v9-runtime-enable'), false)
})

test('compact hydration rollback preserves DB evidence and refuses runtime restart before guards pass', async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'))
  const runbook = await readFile(runbookUrl, 'utf8')

  assert.equal(manifest.rollback.dropDatabaseObjects, false)
  assert.equal(manifest.rollback.clearQueueOrDeadLetter, false)
  assert.equal(manifest.rollback.restorePreviousRenderArtifactBeforeRuntimeEnable, true)
  assert.equal(manifest.rollback.requireRawFormalTenTablesHealthy, true)
  assert.match(runbook, /supabase\s+migration\s+list\s+--linked/i)
  assert.match(runbook, /supabase\s+db\s+push\s+--dry-run/i)
  assert.match(runbook, /indisvalid[\s\S]*indisready/i)
  assert.match(runbook, /V105_SHADOW_(?:V7_|V8_|V9_)?ENABLED[\s\S]*false/i)
  assert.match(runbook, /V6\/V7\/V8\/V9[\s\S]*只部署修復、不啟用/i)
  assert.match(runbook, /禁止.*(?:Queue|Dead-letter)/i)
})
