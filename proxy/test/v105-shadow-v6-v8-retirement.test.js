import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createSupabaseIngestionClient } from '../src/supabase-writer.js'
import { createShadowProcessClient } from '../src/shadow-process-client.js'

const retiredSourcePaths = [
  '../src/v105-shadow-contract.js',
  '../src/v105-shadow-runtime.js',
  '../src/v105-shadow-v7-contract.js',
  '../src/v105-shadow-v7-runtime.js',
  '../src/v105-shadow-v8-contract.js',
  '../src/v105-shadow-v8-runtime.js',
]

const productionSources = [
  '../src/server.js',
  '../src/shadow-process-client.js',
  '../src/shadow-process-worker.js',
  '../src/shadow-process-work.js',
  '../src/supabase-writer.js',
]

const retiredWriterMethods = [
  'issueV105ShadowPrediction', 'readV105ShadowIssuance', 'settleV105ShadowPrediction',
  'getV105ShadowCounters', 'getV105ShadowHistory',
  'issueV105ShadowV7Prediction', 'readV105ShadowV7Issuance', 'settleV105ShadowV7Prediction',
  'getV105ShadowV7Counters', 'getV105ShadowV7History',
  'issueV105ShadowV8Prediction', 'readV105ShadowV8Issuance', 'settleV105ShadowV8Prediction',
  'getV105ShadowV8Counters', 'getV105ShadowV8History',
]

test('V6-V8 strategy contracts and runtimes have no production source entry point', () => {
  for (const path of retiredSourcePaths) {
    assert.equal(existsSync(new URL(path, import.meta.url)), false, `${path} must be retired`)
  }
  for (const path of productionSources) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /V105_SHADOW_V(?:6|7|8)_ENABLED|v105-shadow-v(?:6|7|8)-(?:runtime|contract)\.js|v105ShadowV(?:7|8)|v105_shadow_v(?:6|7|8)/i, path)
  }
  const v9Source = readFileSync(new URL('../src/v105-shadow-v9-contract.js', import.meta.url), 'utf8')
  assert.doesNotMatch(v9Source, /from\s+['"]\.\/v105-shadow-(?:contract|v7-contract|v8-contract)\.js['"]/i)
})

test('writer and isolated-process registry expose only V9/V10 from the v105 shadow line', () => {
  const writer = createSupabaseIngestionClient({
    url: 'https://example.supabase.co',
    serviceKey: 'test-only',
    requireVerifiedStrategy: false,
    fetchImpl: async () => assert.fail('retired writer absence check must not perform I/O'),
  })
  for (const method of retiredWriterMethods) assert.equal(Object.hasOwn(writer, method), false, method)
  for (const method of ['issueV105ShadowV9Prediction', 'settleV105ShadowV9Prediction', 'issueV105ShadowV10Prediction', 'settleV105ShadowV10Prediction']) {
    assert.equal(typeof writer[method], 'function', method)
  }
  const client = createShadowProcessClient()
  for (const key of ['v105', 'v105-v7', 'v105-v8']) assert.throws(() => client.runtime(key), /unknown shadow runtime/i)
  for (const key of ['v105-v9', 'v105-v10']) assert.equal(client.runtime(key).enabled, true)
})

test('teardown migration disables settings first and removes only exact V6-V8 database objects', () => {
  const migration = readFileSync(new URL('../../supabase/migrations/20260802020000_retire_v105_shadow_v6_v8.sql', import.meta.url), 'utf8')
  for (const historical of [
    '../../supabase/migrations/20260727200000_v105_shadow_v6.sql',
    '../../supabase/migrations/20260727210000_v105_shadow_v7.sql',
    '../../supabase/migrations/20260727220000_v105_shadow_v8.sql',
  ]) assert.equal(existsSync(new URL(historical, import.meta.url)), true, historical)
  assert.match(migration, /^begin;/i)
  assert.match(migration, /update\s+public\.v105_shadow_v6_runtime_settings\s+set\s+enabled\s*=\s*false/i)
  assert.match(migration, /update\s+public\.v105_shadow_v7_runtime_settings\s+set\s+enabled\s*=\s*false/i)
  assert.match(migration, /update\s+public\.v105_shadow_v8_runtime_settings\s+set\s+enabled\s*=\s*false/i)
  assert.match(migration, /from\s+pg_catalog\.pg_proc/i)
  assert.match(migration, /pg_catalog\.pg_get_function_identity_arguments/i)
  assert.match(migration, /p\.proname\s*=\s*any\s*\(/i)
  const firstDrop = migration.search(/\bdrop\s+(?:function|view|table)\b/i)
  const lastDisable = migration.lastIndexOf('set enabled = false;')
  assert.equal(lastDisable >= 0 && lastDisable < firstDrop, true)
  for (const version of [6, 7, 8]) {
    for (const functionName of [`issue_v105_shadow_v${version}_prediction`, `settle_v105_shadow_v${version}_prediction`, `get_v105_shadow_v${version}_compact_history`]) {
      assert.match(migration, new RegExp(`'${functionName}'`, 'i'))
    }
    assert.match(migration, new RegExp(`drop view if exists public\\.v105_shadow_v${version}_history`, 'i'))
    const orderedTables = ['settlements', 'issuances', 'sequence_counters', 'runtime_settings']
      .map((suffix) => migration.search(new RegExp(`drop table if exists public\\.v105_shadow_v${version}_${suffix}`, 'i')))
    assert.equal(orderedTables.every((position) => position >= 0), true)
    assert.deepEqual([...orderedTables].sort((a, b) => a - b), orderedTables)
  }
  assert.doesNotMatch(migration, /\bcascade\b/i)
  assert.doesNotMatch(migration, /\b(?:drop|truncate|delete\s+from|update)\b[^;]*(?:v105_shadow_v9|v105_shadow_v10|ai_predictions|prediction_issuances)/i)
  assert.match(migration, /raise exception 'V6-V8 teardown left database objects behind'/i)
  assert.match(migration, /commit;\s*$/i)
})

test('V9 and V10 source and migrations do not depend on retired database objects', () => {
  const paths = [
    '../src/v105-shadow-v9-contract.js', '../src/v105-shadow-v9-runtime.js',
    '../src/v105-shadow-v10-contract.js', '../src/v105-shadow-v10-runtime.js',
    '../../supabase/migrations/20260729050000_v105_shadow_v9.sql',
    '../../supabase/migrations/20260802010000_v105_shadow_v10.sql',
  ]
  for (const path of paths) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /public\.v105_shadow_v(?:6|7|8)_|from\s+['"]\.\/v105-shadow-(?:contract|v7-contract|v8-contract)\.js['"]/i, path)
  }
})
