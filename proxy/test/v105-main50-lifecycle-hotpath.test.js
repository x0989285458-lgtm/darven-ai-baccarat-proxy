import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const migrationUrl = new URL('../../supabase/migrations/20260827103000_v105_lifecycle_hotpath.sql', import.meta.url)
const rollbackUrl = new URL('../../supabase/operations/rollback_v105_main50_lifecycle_hotpath.sql', import.meta.url)

test('Main50 lifecycle migration bounds reconciliation to pending issuance rows', () => {
  const sql = readFileSync(migrationUrl, 'utf8')
  assert.match(sql, /drop\s+index\s+concurrently\s+if\s+exists\s+public\.daily_prediction_results_v105_lifecycle_hot_idx/i)
  assert.match(sql, /create\s+index\s+concurrently\s+daily_prediction_results_v105_lifecycle_hot_idx/i)
  assert.doesNotMatch(sql, /create\s+index\s+concurrently\s+if\s+not\s+exists/i)
  assert.doesNotMatch(sql, /\b(begin|commit)\s*;/i)
  assert.match(sql, /create\s+or\s+replace\s+function\s+public\.reconcile_v105_prediction_lifecycle\s*\(/i)
  assert.match(sql, /security\s+definer/i)
  assert.match(sql, /set\s+search_path\s*=\s*pg_catalog\s*,\s*public/i)
  assert.match(sql, /and\s*\(\s*issuance_status\s+is\s+null\s+or\s+issuance_status\s+in\s*\(\s*'pending'\s*,\s*'expired_no_final'\s*\)\s*\)/i)
  assert.match(sql, /issuance_status\s*=\s*'pending'\s+and\s*\(\s*shoe_no\s+is\s+distinct\s+from\s+p_current_shoe\s+or\s+round_no\s*<\s*p_current_visible_round\s*\)/i)
  assert.match(sql, /issuance_status\s*=\s*'expired_no_final'\s+and\s+shoe_no\s+is\s+distinct\s+from\s+p_current_shoe/i)
  assert.doesNotMatch(sql, /issuance_status\s+is\s+distinct\s+from\s+case/i)
  assert.match(sql, /create\s+index\s+concurrently\s+daily_prediction_results_v105_lifecycle_hot_idx[\s\S]*issuance_status\s+is\s+null\s+or\s+issuance_status\s+in\s*\(\s*'pending'\s*,\s*'expired_no_final'\s*\)/i)
  assert.match(sql, /when\s+shoe_no\s+is\s+distinct\s+from\s+p_current_shoe\s+then\s+'abandoned_shoe_change'/i)
})

test('Main50 lifecycle migration preserves fail-closed function ACL', () => {
  const sql = readFileSync(migrationUrl, 'utf8')
  assert.match(sql, /revoke\s+all\s+on\s+function\s+public\.reconcile_v105_prediction_lifecycle\(text\s*,\s*text\s*,\s*text\s*,\s*integer\)\s+from\s+public\s*,\s*anon\s*,\s*authenticated\s*,\s*service_role/i)
  assert.match(sql, /grant\s+execute\s+on\s+function\s+public\.reconcile_v105_prediction_lifecycle\(text\s*,\s*text\s*,\s*text\s*,\s*integer\)\s+to\s+service_role/i)
})

test('Main50 rollback restores the exact broad Main49 lifecycle contract without deleting evidence', () => {
  const sql = readFileSync(rollbackUrl, 'utf8')
  assert.match(sql, /create\s+or\s+replace\s+function\s+public\.reconcile_v105_prediction_lifecycle/i)
  assert.match(sql, /issuance_status\s+is\s+distinct\s+from\s+case/i)
  assert.match(sql, /set\s+search_path\s*=\s*pg_catalog\s*,\s*public/i)
  assert.match(sql, /grant\s+execute[\s\S]*to\s+service_role/i)
  assert.doesNotMatch(sql, /\b(delete\s+from|truncate|drop\s+table)\b/i)
})
