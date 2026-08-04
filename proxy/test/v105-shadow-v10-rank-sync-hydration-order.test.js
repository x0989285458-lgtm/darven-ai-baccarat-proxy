import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const migration = new URL('../../supabase/migrations/20260804110000_v105_shadow_v10_rank_sync_hydration_millisecond_order.sql', import.meta.url)

test('rank-sync V10 compact hydration orders every selection at Node millisecond precision', async () => {
  const sql = await readFile(migration, 'utf8')
  assert.match(sql, /create\s+or\s+replace\s+function\s+public\.get_v105_shadow_v10_rank_sync_compact_history\s*\(p_per_table_limit\s+integer\)/i)
  assert.match(sql, /from\s+public\.v105_shadow_v10_rank_sync_issuances\s+i[\s\S]*order\s+by\s+date_trunc\('milliseconds',\s*i\.prediction_issued_at\)\s+desc,\s*i\.id\s+desc[\s\S]*limit\s+p_per_table_limit/i)
  assert.match(sql, /not\s+exists[\s\S]*order\s+by\s+date_trunc\('milliseconds',\s*i\.prediction_issued_at\)\s+desc,\s*i\.id\s+desc[\s\S]*limit\s+1/i)
  assert.match(sql, /order\s+by\s+date_trunc\('milliseconds',\s*compact\.prediction_issued_at\)\s+asc,\s*compact\.prediction_id\s+asc/i)
  assert.match(sql, /security\s+definer/i)
  assert.match(sql, /set\s+search_path\s*=\s*pg_catalog/i)
  assert.match(sql, /revoke\s+all\s+on\s+function\s+public\.get_v105_shadow_v10_rank_sync_compact_history\(integer\)\s+from\s+public/i)
  assert.match(sql, /grant\s+execute\s+on\s+function\s+public\.get_v105_shadow_v10_rank_sync_compact_history\(integer\)\s+to\s+service_role/i)
  assert.match(sql, /aclexplode\s*\(/i)
})
