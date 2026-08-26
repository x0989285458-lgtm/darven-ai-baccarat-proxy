import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildV105V10MainPrediction } from '../src/v105-v10-main-strategy.js'

const root = fileURLToPath(new URL('../../', import.meta.url))
const read = (relativePath) => readFile(path.join(root, relativePath), 'utf8')
const readJson = async (relativePath) => JSON.parse(await read(relativePath))
const main33Commit = '9510ed1b97b1ecc9f87a861944f11da8fbb4d088'
const readIndexBlob = (relativePath) => execFileSync('git', ['show', `${main33Commit}:${relativePath}`], { cwd: root })
const disableMigrationPath = 'supabase/migrations/20260826035000_v105_main33_disable_legacy_runtime_settings.sql'
const migrationPath = 'supabase/migrations/20260826040000_v105_main33_legacy_runtime_teardown.sql'
const workflowPath = '.github/workflows/trusted-release-images-main33.yml'
const manifestPath = 'release/v105-v10-main33-decommission-release-manifest.json'
const reportPath = 'release/v105-v10-main33-decommission-release-report.json'
const expectedChangedPaths = [
  '.github/workflows/trusted-release-images-main33.yml',
  'proxy/src/server.js',
  'proxy/test/capture-outbox-ack.test.js',
  'proxy/test/immediate-round-ready.test.js',
  'proxy/test/shadow-process-isolation.test.js',
  'proxy/test/shadow-process-v10-resource-isolation.test.js',
  'proxy/test/v103-shadow-isolation.test.js',
  'proxy/test/v104-iteration-shadow-server.test.js',
  'proxy/test/v104-shadow-isolation.test.js',
  'proxy/test/v105-formal-ingest-backpressure-contract.test.js',
  'proxy/test/v105-formal-startup-performance-contract.test.js',
  'proxy/test/v105-shadow-v10-server.test.js',
  'proxy/test/v105-shadow-v9-server.test.js',
  'proxy/test/v105-v10-main28-db-release.test.js',
  'proxy/test/v105-v10-main29-db-release.test.js',
  'proxy/test/v105-v10-main30-idempotent-issuance-release.test.js',
  'proxy/test/v105-v10-main31-trusted-workflow-release.test.js',
  'proxy/test/v105-v10-main32-trusted-workflow-release.test.js',
  'proxy/test/v105-v10-main33-decommission-release.test.js',
  'release/v105-v10-main33-decommission-release-manifest.json',
  'release/v105-v10-main33-decommission-release-report.json',
  'supabase/migrations/20260826035000_v105_main33_disable_legacy_runtime_settings.sql',
  'supabase/migrations/20260826040000_v105_main33_legacy_runtime_teardown.sql',
]

const retiredRuntimeTokens = [
  'v103-shadow-runtime', 'v104-shadow-runtime', 'v104-iteration-shadow-runtime',
  'v104-formal-runtime', 'v105-shadow-v9-runtime', 'v105-shadow-v10-runtime',
  'shadow-process-client',
  'V103_SHADOW_ENABLED', 'V104_SHADOW_ENABLED', 'V104_ITERATION_SHADOW_ENABLED',
  'V105_SHADOW_V9_ENABLED', 'V105_SHADOW_V10_ENABLED', 'SHADOW_PROCESS_ENABLED',
  '/api/v103-shadow/', '/api/v104-shadow/', '/api/v104-iteration-shadow/',
  'issueV103ShadowPrediction', 'issueV104ShadowPrediction',
  'issueV104IterationShadowPrediction', 'issueV105ShadowV9Prediction',
  'issueV105ShadowV10Prediction',
]

const keepSet = [
  'ai_strategy_versions', 'daily_prediction_results',
  'v100_rank_ledger', 'v105_capture_settlement_outbox',
  'capture_archive', 'capture_queue', 'v106', 'rollback_receipt',
]
const retiredV104FormalObjects = new Set([
  'apply_v104_rank_ledger_event', 'get_v104_prediction_lifecycle_stats',
  'issue_v104_prediction', 'persist_v104_settled_round',
  'reconcile_v104_prediction_lifecycle', 'settle_v104_prediction',
  'v104_formal_release_previous_active',
])

test('Main33 active server import graph, routes, env and writer calls cannot start retired runtimes', async () => {
  const server = await read('proxy/src/server.js')
  for (const token of retiredRuntimeTokens) assert.equal(server.includes(token), false, token)

  for (const requiredImport of [
    './v105-formal-runtime.js', './v105-v10-main-strategy.js',
  ]) assert.match(await read(requiredImport.includes('main-strategy') ? 'proxy/src/v105-formal-runtime.js' : 'proxy/src/server.js'), new RegExp(requiredImport.replaceAll('.', '\\.')))

  for (const keptPath of [
    'proxy/src/v105-v10-main-strategy.js', 'proxy/src/v105-formal-strategy.js',
    'proxy/src/v105-formal-runtime.js', 'proxy/src/v104-shadow-strategy.js',
    'proxy/src/v105-shadow-v9-contract.js', 'proxy/src/v105-shadow-v9-signal-baseline.js',
    'proxy/src/v105-shadow-v10-contract.js', 'proxy/src/v105-shadow-v10-structure.js',
  ]) assert.ok((await read(keptPath)).length > 0, keptPath)
})

test('Main33 preserves the frozen formal V105 V10 fixture byte-for-byte', () => {
  const fixtures = [
    {
      tableId: 'BAG01', shoe: '105', round: 20, bankerCount: 12, playerCount: 8, tieCount: 1,
      bigRoadRaw: 'B#P,P#B,B#P#B,B#P,P', beadPlateRaw: '02010102020102020101',
      nextBankerRaw: { big: 'B#P' }, nextPlayerRaw: { big: 'B#P' },
    },
    { tableId: 'BAG02', shoe: '77', round: 12, bankerCount: 5, playerCount: 7, tieCount: 0, bigRoadRaw: 'B#P#B#P' },
  ]
  const bytes = JSON.stringify(fixtures.map((fixture) => buildV105V10MainPrediction(fixture)))
  assert.equal(createHash('sha256').update(bytes).digest('hex'), '560fe320361263e87e9c897bf6378f088c92ebbb004a73e1f0698569ef572cb2')
})

test('Main33 disable migration retires exactly the four enabled V105 shadow settings before teardown', async () => {
  const sql = await read(disableMigrationPath)
  assert.match(sql, /^begin;/)
  const firstDo = sql.toLowerCase().search(/\bdo\s+\$/)
  assert.ok(firstDo > 0)
  const lockPreamble = sql.slice(0, firstDo).toLowerCase()
  assert.match(lockPreamble, /lock\s+table[\s\S]*in\s+share\s+row\s+exclusive\s+mode/)
  assert.ok(lockPreamble.includes('public.ai_strategy_versions'))
  assert.match(sql, /ai_strategy_versions[\s\S]*status\s*=\s*'active'[\s\S]*active_version\s*<>\s*'v105'/i)
  assert.match(sql, /count\(\*\)[\s\S]*<>\s*1/i)
  const updatedTables = [...sql.matchAll(/update\s+public\.([a-z0-9_]+runtime_settings)/gi)].map((match) => match[1])
  assert.deepEqual(updatedTables.sort(), [
    'v105_shadow_v10_big_road_runtime_settings',
    'v105_shadow_v10_rank_sync_runtime_settings',
    'v105_shadow_v10_runtime_settings',
    'v105_shadow_v9_runtime_settings',
  ])
  for (const table of updatedTables) assert.ok(lockPreamble.includes(`public.${table}`), table)
  assert.match(sql, /enabled\s*=\s*false/i)
  assert.match(sql, /status\s*=\s*'shadow_disabled'/i)
  assert.doesNotMatch(sql, /\b(?:drop|truncate|delete\s+from|insert\s+into)\b/i)
  assert.match(sql, /commit;\s*$/)
})

test('Main33 teardown is fail-closed and drops only the explicit retired DB allowlist', async () => {
  const sql = await read(migrationPath)
  assert.match(sql, /^begin;/)
  const firstDo = sql.toLowerCase().search(/\bdo\s+\$/)
  assert.ok(firstDo > 0)
  const lockPreamble = sql.slice(0, firstDo).toLowerCase()
  assert.match(lockPreamble, /lock\s+table[\s\S]*in\s+share\s+row\s+exclusive\s+mode/)
  assert.ok(lockPreamble.includes('public.ai_strategy_versions'))
  const guardedSettingTables = [...new Set([...sql.matchAll(/drop\s+table\s+if\s+exists\s+public\.([a-z0-9_]+runtime_settings)/gi)].map((match) => match[1]))]
  assert.ok(guardedSettingTables.length >= 11, guardedSettingTables)
  for (const table of guardedSettingTables) assert.ok(lockPreamble.includes(`public.${table}`), table)
  assert.match(sql, /ai_strategy_versions[\s\S]*status\s*=\s*'active'[\s\S]*version\s*=\s*'v105'/i)
  assert.match(sql, /count\(\*\)[\s\S]*<>\s*1/i)
  assert.match(sql, /runtime_settings/i)
  assert.match(sql, /enabled\s*=\s*true|enabled\s+is\s+true/i)
  assert.match(sql, /raise exception/i)
  assert.match(sql, /commit;\s*$/)

  const droppedNames = [...sql.matchAll(/drop\s+(?:function|view|table|trigger)\s+(?:if\s+exists\s+)?(?:public\.)?([a-z0-9_]+)/gi)].map((match) => match[1])
  assert.ok(droppedNames.length >= 47, droppedNames)
  for (const name of droppedNames) {
    if (retiredV104FormalObjects.has(name)) continue
    assert.match(name, /^(?:issue|settle|get|persist|review|begin|finish|enforce)_v10[345]_(?:shadow|iteration_shadow)|^v10[345]_(?:shadow|iteration_shadow)/, name)
  }
  for (const retired of retiredV104FormalObjects) assert.ok(droppedNames.includes(retired), retired)
  for (const kept of keepSet) assert.equal(sql.toLowerCase().includes(`drop table if exists public.${kept}`), false, kept)
})

test('Main33 manifest and report bind Main32/Main30 predecessors and local-only candidate evidence', async () => {
  const manifest = await readJson(manifestPath)
  const report = await readJson(reportPath)
  assert.equal(manifest.releaseVersion, 'v105-v10-main.33')
  assert.equal(manifest.gitTag, 'v105-v10-main.33')
  assert.equal(manifest.baseCommit, 'fe2d6aed2098630d755fef8398bb0bb9ce46d42c')
  assert.equal(manifest.predecessorManifest, 'release/v105-v10-main32-trusted-workflow-release-manifest.json')
  assert.equal(manifest.runtimeSourceVersion, 'v105-v10-main.30')
  assert.deepEqual(manifest.workflowContract.allowedChangedPaths, expectedChangedPaths)
  assert.deepEqual(
    Object.keys(manifest.releaseBinding.changedFileSha256).sort(),
    expectedChangedPaths.filter((relativePath) => relativePath !== manifestPath).sort(),
  )
  for (const [relativePath, expected] of Object.entries(manifest.releaseBinding.changedFileSha256)) {
    assert.equal(createHash('sha256').update(readIndexBlob(relativePath)).digest('hex'), expected, relativePath)
  }
  assert.equal(manifest.releaseScope.predictionChanged, false)
  assert.equal(manifest.releaseScope.databaseChanged, true)
  assert.equal(report.releaseVersion, 'v105-v10-main.33')
  assert.equal(report.scope.predictionRulesChanged, false)
  assert.equal(report.productionGates.finalVerdict, 'BLOCK')
  assert.ok(Object.values(report.productionGates).every((value) => value !== 'PASS'))
})

test('Main33 trusted workflow keeps Main32 fail-closed verifier semantics and exact tag only', async () => {
  const workflow = (await read(workflowPath)).replace(/\r\n/g, '\n')
  const simulatedWindowsWorkflow = workflow.replace(/\n/g, '\r\n').replace(/\r\n/g, '\n')
  assert.equal(simulatedWindowsWorkflow, workflow)
  assert.equal(workflow.slice(workflow.indexOf('on:\n'), workflow.indexOf('\npermissions:')).trim(), [
    'on:', '  push:', '    tags:', '      - v105-v10-main.33',
  ].join('\n'))
  assert.match(workflow, /if: github\.ref == 'refs\/tags\/v105-v10-main\.33'/)
  assert.match(workflow, /ref: refs\/tags\/v105-v10-main\.33/)
  assert.match(workflow, /test "\$\{GITHUB_REF\}" = "refs\/tags\/v105-v10-main\.33"/)
  assert.match(workflow, /test "\$\(git rev-parse HEAD\)" = "\$\{GITHUB_SHA\}"/)
  assert.match(workflow, /verify-trusted-release-delta\.sh/)
  assert.match(workflow, /fe2d6aed2098630d755fef8398bb0bb9ce46d42c/)
  for (const changedPath of expectedChangedPaths) assert.ok(workflow.includes(changedPath), changedPath)
  assert.match(workflow, /gh attestation verify/)
  assert.match(workflow, /--source-digest "\$\{GITHUB_SHA\}"/)
  assert.match(workflow, /--source-ref "\$\{GITHUB_REF\}"/)
  assert.match(workflow, /--deny-self-hosted-runners/)
})
