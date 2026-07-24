import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createApp } from '../src/server.js'

const repo = new URL('../../', import.meta.url)
const read = (path) => readFileSync(new URL(path, repo), 'utf8')
const manifest = JSON.parse(read('release/v105-formal-release-manifest.json'))

test('formal.13 installs the recent-performance startup index before proxy cutover', () => {
  assert.equal(manifest.releaseVersion, 'v105.0.0-formal.13')
  assert.equal(manifest.databasePerformanceAdditive, 'frontend/supabase/migrate_v105_formal_recent_performance_index.sql')
  const memoryIndex = manifest.deploymentOrder.indexOf('database-memory-additive')
  const performanceIndex = manifest.deploymentOrder.indexOf('database-performance-additive')
  const proxyIndex = manifest.deploymentOrder.indexOf('proxy')
  assert.equal(performanceIndex, memoryIndex + 1)
  assert.ok(performanceIndex < proxyIndex)

  const migrationPath = new URL('frontend/supabase/migrate_v105_formal_recent_performance_index.sql', repo)
  assert.equal(existsSync(migrationPath), true)
  const migration = read('frontend/supabase/migrate_v105_formal_recent_performance_index.sql')
  assert.match(migration, /create\s+index\s+concurrently\s+if\s+not\s+exists\s+daily_prediction_results_v105_recent_table_idx/i)
  assert.match(migration, /\(strategy_version,\s*table_id,\s*created_at\s+desc\)/i)
  assert.match(migration, /where\s+settlement_final\s+is\s+true\s+and\s+prediction_issued_at\s+is\s+not\s+null/i)
  assert.doesNotMatch(migration, /\b(drop|delete|truncate|alter\s+table)\b/i)

  const baseline = read('frontend/supabase/schema_v100_baseline.sql')
  assert.match(baseline, /daily_prediction_results_v105_recent_table_idx[\s\S]*strategy_version,\s*table_id,\s*created_at\s+desc/i)

  const writer = read('proxy/src/supabase-writer.js')
  const start = writer.indexOf('async getRecentPredictionRows')
  const end = writer.indexOf('async getTableUiSettledPredictions', start)
  const block = writer.slice(start, end)
  assert.match(block, /PRODUCTION_TABLE_IDS\.slice\(index,\s*index\s*\+\s*2\)/)
  assert.match(block, /Math\.min\(60,/)
  assert.match(block, /prediction_timing:prediction_features->>prediction_timing/)
  assert.doesNotMatch(block, /,prediction_features,/)
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
