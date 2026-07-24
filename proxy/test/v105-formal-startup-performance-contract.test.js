import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

const repo = new URL('../../', import.meta.url)
const read = (path) => readFileSync(new URL(path, repo), 'utf8')
const manifest = JSON.parse(read('release/v105-formal-release-manifest.json'))

test('formal.11 installs the recent-performance startup index before proxy cutover', () => {
  assert.equal(manifest.releaseVersion, 'v105.0.0-formal.11')
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
