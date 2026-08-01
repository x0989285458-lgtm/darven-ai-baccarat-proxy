import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const migration = new URL('../../supabase/migrations/20260801162200_v105_shadow_v9_hydration_millisecond_order.sql', import.meta.url)

test('v9 hydration hotfix aligns PostgreSQL ordering with Node millisecond timestamps', async () => {
  const sql = await readFile(migration, 'utf8')
  assert.match(sql, /create\s+or\s+replace\s+function\s+public\.get_v105_shadow_v9_compact_history\s*\(p_per_table_limit\s+integer\)/i)
  assert.match(sql, /order\s+by\s+date_trunc\('milliseconds',\s*compact\.prediction_issued_at\)\s+asc,\s*compact\.prediction_id\s+asc/i)
  assert.match(sql, /security\s+definer/i)
  assert.match(sql, /set\s+search_path\s*=\s*pg_catalog\s*\n/i)
  assert.match(sql, /aclexplode\s*\(/i)
  assert.match(sql, /unexpected execute acl/i)
  assert.match(sql, /grant\s+execute\s+on\s+function\s+public\.get_v105_shadow_v9_compact_history\(integer\)\s+to\s+service_role/i)
  assert.doesNotMatch(sql, /\b(drop|truncate|delete\s+from)\b/i)
})
