import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const path = new URL('../../supabase/migrations/20260727213000_v5_parallel_with_v6.sql', import.meta.url)

test('v5 parallel migration rebinds only runtime guards to active v105 and preserves independent v5 evidence', () => {
  assert.equal(fs.existsSync(path), true, 'v5/v6 parallel migration is missing')
  const sql = fs.readFileSync(path, 'utf8')
  assert.match(sql, /v104_iteration_shadow_v5_runtime_settings_active_strategy_version_check/i)
  assert.match(sql, /active_strategy_version\s+in\s*\(\s*'v104'\s*,\s*'v105'\s*\)/i)
  assert.match(sql, /insert\s+into\s+public\.v104_iteration_shadow_v5_sequence_counters[\s\S]*values\s*\(\s*'v104\.5\.0-seven-head-shadow\.5'\s*,\s*0/i)
  assert.match(sql, /on\s+conflict\s*\(\s*release_candidate\s*\)\s+do\s+nothing/i)
  assert.match(sql, /set\s+enabled\s*=\s*true\s*,\s*status\s*=\s*'shadow'\s*,\s*active_strategy_version\s*=\s*'v105'/i)
  assert.match(sql, /pg_get_functiondef\s*\(\s*function_name\s*\)/i)
  for (const name of [
    'issue_v104_iteration_shadow_v5_prediction',
    'settle_v104_iteration_shadow_v5_prediction',
    'persist_v104_iteration_shadow_v5_artifacts',
    'review_v104_iteration_shadow_v5_suggestion',
  ]) assert.match(sql, new RegExp(name))
  assert.match(sql, /version='v105'/i)
  assert.match(sql, /active_strategy_version='v105'/i)
  assert.match(sql, /v104-seven-head-shadow-v5-best-stage-side-reweight/i)
  assert.doesNotMatch(sql, /truncate\s+table/i)
  assert.doesNotMatch(sql, /v105_shadow_v6_(issuances|settlements|sequence_counters)/i)
})
