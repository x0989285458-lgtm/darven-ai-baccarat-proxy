import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createApp } from '../src/server.js'

const repo = new URL('../../', import.meta.url)
const read = (path) => readFileSync(new URL(path, repo), 'utf8')
const manifest = JSON.parse(read('release/v105-formal-release-manifest.json'))

test('formal.14 installs the recent-performance index and JSON-free RPC before proxy cutover', () => {
  assert.equal(manifest.releaseVersion, 'v105.0.0-formal.14')
  assert.equal(manifest.databasePerformanceAdditive, 'frontend/supabase/migrate_v105_formal_recent_performance_index.sql')
  assert.equal(manifest.databasePerformanceRpcAdditive, 'frontend/supabase/migrate_v105_formal_recent_performance_rpc.sql')
  const memoryIndex = manifest.deploymentOrder.indexOf('database-memory-additive')
  const performanceIndex = manifest.deploymentOrder.indexOf('database-performance-additive')
  const rpcIndex = manifest.deploymentOrder.indexOf('database-performance-rpc-additive')
  const proxyIndex = manifest.deploymentOrder.indexOf('proxy')
  assert.equal(performanceIndex, memoryIndex + 1)
  assert.equal(rpcIndex, performanceIndex + 1)
  assert.ok(rpcIndex < proxyIndex)

  const indexMigrationPath = new URL('frontend/supabase/migrate_v105_formal_recent_performance_index.sql', repo)
  assert.equal(existsSync(indexMigrationPath), true)
  const indexMigration = read('frontend/supabase/migrate_v105_formal_recent_performance_index.sql')
  assert.match(indexMigration, /create\s+index\s+concurrently\s+if\s+not\s+exists\s+daily_prediction_results_v105_recent_table_idx/i)
  assert.match(indexMigration, /\(strategy_version,\s*table_id,\s*created_at\s+desc\)/i)
  assert.match(indexMigration, /where\s+settlement_final\s+is\s+true\s+and\s+prediction_issued_at\s+is\s+not\s+null/i)
  assert.doesNotMatch(indexMigration, /get_v105_recent_performance_rows/i)

  const rpcMigrationPath = new URL('frontend/supabase/migrate_v105_formal_recent_performance_rpc.sql', repo)
  assert.equal(existsSync(rpcMigrationPath), true)
  const rpcMigration = read('frontend/supabase/migrate_v105_formal_recent_performance_rpc.sql')
  assert.match(rpcMigration, /create\s+or\s+replace\s+function\s+public\.get_v105_recent_performance_rows/i)
  assert.doesNotMatch(rpcMigration, /cross\s+join\s+lateral/i)
  assert.equal((rpcMigration.match(/\bunion\s+all\b/gi) ?? []).length, 9)
  for (const tableId of ['BAG01', 'BAG02', 'BAG03', 'BAG03A', 'BAG05', 'BAG06', 'BAG07', 'BAG08', 'BAG09', 'BAG10']) {
    assert.match(rpcMigration, new RegExp(`d\\.table_id\\s*=\\s*'${tableId}'`))
  }
  assert.match(rpcMigration, /limit\s+least\(60,\s*greatest\(1,/i)
  assert.equal((rpcMigration.match(/'pre_result_context'::text\s+as\s+prediction_timing/gi) ?? []).length, 10)
  assert.doesNotMatch(rpcMigration, /prediction_features/i)
  for (const role of ['public', 'anon', 'authenticated']) {
    assert.match(rpcMigration, new RegExp(`revoke\\s+all\\s+on\\s+function\\s+public\\.get_v105_recent_performance_rows\\(integer\\)\\s+from\\s+${role}`, 'i'))
  }
  assert.match(rpcMigration, /grant\s+execute\s+on\s+function\s+public\.get_v105_recent_performance_rows\(integer\)\s+to\s+service_role/i)
  assert.doesNotMatch(rpcMigration, /\b(drop|delete|truncate|alter\s+table)\b/i)

  const baseline = read('frontend/supabase/schema_v100_baseline.sql')
  assert.match(baseline, /daily_prediction_results_v105_recent_table_idx[\s\S]*strategy_version,\s*table_id,\s*created_at\s+desc/i)

  const formalSchema = read('frontend/supabase/schema_v105_formal.sql')
  assert.match(formalSchema, /issue_v105_prediction[\s\S]*prediction_issued_at,\s*issued_prediction_payload,\s*settlement_final[\s\S]*now\(\),\s*p_prediction->'issued_prediction_payload',\s*false/i)
  assert.match(formalSchema, /settle_v105_prediction[\s\S]*prediction_issued_at\s+is\s+null\s+or\s+existing\.issued_prediction_payload\s+is\s+null[\s\S]*immutable pre-result evidence/i)

  const writer = read('proxy/src/supabase-writer.js')
  const start = writer.indexOf('async getRecentPredictionRows')
  const end = writer.indexOf('async getTableUiSettledPredictions', start)
  const block = writer.slice(start, end)
  assert.match(block, /readV105RecentPerformanceRows\(perTableLimit/)
  assert.doesNotMatch(block, /postRpcRows\('get_v105_recent_performance_rows'/)
  assert.doesNotMatch(block, /getRest\('daily_prediction_results'/)
  assert.doesNotMatch(block, /PRODUCTION_TABLE_IDS\.slice/)
})

test('formal hydration has a dedicated prediction-issued partial index', () => {
  const migrationPath = new URL('frontend/supabase/migrate_v105_formal_hydration_index.sql', repo)
  assert.equal(existsSync(migrationPath), true)
  const migration = read('frontend/supabase/migrate_v105_formal_hydration_index.sql')
  assert.match(migration, /create\s+index\s+concurrently\s+if\s+not\s+exists\s+daily_prediction_results_v105_hydration_idx/i)
  assert.match(migration, /\(table_id,\s*prediction_issued_at\s+desc\)/i)
  assert.doesNotMatch(migration, /strategy_version\s+in/i)
  assert.match(migration, /prediction_issued_at\s+is\s+not\s+null/i)
  assert.doesNotMatch(migration, /prediction_features/i)
  assert.doesNotMatch(migration, /\b(drop|delete|truncate|alter\s+table)\b/i)
})

test('formal latest-state hydration has a table-strategy-issued composite index', () => {
  const migrationPath = new URL('frontend/supabase/migrate_v105_formal_latest_strategy_index.sql', repo)
  assert.equal(existsSync(migrationPath), true)
  const migration = read('frontend/supabase/migrate_v105_formal_latest_strategy_index.sql')
  assert.match(migration, /create\s+index\s+concurrently\s+if\s+not\s+exists\s+daily_prediction_results_v105_latest_strategy_idx/i)
  assert.match(migration, /\(table_id,\s*strategy_version,\s*prediction_issued_at\s+desc\)/i)
  assert.match(migration, /prediction_issued_at\s+is\s+not\s+null/i)
  assert.doesNotMatch(migration, /\b(drop|delete|truncate|alter\s+table)\b/i)
})

test('formal reset bootstrap reads only v105 and its v104 predecessor', () => {
  const migrationPath = new URL('frontend/supabase/migrate_v105_formal_reset_bootstrap_rpc.sql', repo)
  assert.equal(existsSync(migrationPath), true)
  const migration = read('frontend/supabase/migrate_v105_formal_reset_bootstrap_rpc.sql')
  assert.match(migration, /values\s*\(\s*'v105'::text\s*\),\s*\(\s*'v104'::text\s*\)/i)
  assert.doesNotMatch(migration, /'v10[0-3]'/i)
  assert.match(migration, /security\s+definer/i)
  assert.match(migration, /revoke\s+all[\s\S]*from\s+anon/i)
  assert.match(migration, /grant\s+execute[\s\S]*to\s+service_role/i)
})

test('formal production Supabase reads and durable writes both use a bounded thirty-second timeout', () => {
  const server = read('proxy/src/server.js')
  assert.match(server, /createSupabaseIngestionClient\(\{[\s\S]*requestTimeoutMs:\s*Number\(process\.env\.SUPABASE_REQUEST_TIMEOUT_MS\s*\?\?\s*30000\)/)
  assert.match(server, /durableWriteRequestTimeoutMs:\s*Number\(process\.env\.DURABLE_INGEST_REQUEST_TIMEOUT_MS\s*\?\?\s*30000\)/)
})

test('formal startup hydration completes before non-blocking shadows may query the database', async () => {
  const events = []
  let releaseRecent
  const recentGate = new Promise((resolve) => { releaseRecent = resolve })
  const shadow = (name) => ({
    enabled: true,
    async start() { events.push(name) },
  })
  const app = createApp({
    autoConnect: false,
    port: 0,
    production: true,
    requireVerifiedStrategy: true,
    memberAuthRequired: false,
    supabaseClient: {
      configured: true,
      async ensureInitialStrategy() { events.push('strategy') },
      async getRecentPredictionRows() {
        events.push('recent:start')
        await recentGate
        events.push('recent:end')
        return []
      },
    },
    v103ShadowRuntime: shadow('shadow:v103'),
    v104ShadowRuntime: shadow('shadow:v104'),
    v104IterationShadowRuntime: shadow('shadow:iteration'),
    v104FormalRuntime: { async start() { events.push('formal:start') } },
  })
  const starting = app.start()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(events, ['strategy', 'recent:start'])
  releaseRecent()
  await starting
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(events, [
    'strategy', 'recent:start', 'recent:end', 'formal:start',
    'shadow:v103', 'shadow:v104', 'shadow:iteration',
  ])
  await app.stop()
})
