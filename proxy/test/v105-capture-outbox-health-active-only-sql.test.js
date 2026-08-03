import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const migrationUrl = new URL('../../supabase/migrations/20260803124500_v105_capture_outbox_health_active_only.sql', import.meta.url)

async function sql() {
  return readFile(migrationUrl, 'utf8')
}

test('capture outbox health excludes completed history before aggregation', async () => {
  const migration = await sql()
  const functionBody = migration.match(/create or replace function public\.get_v105_capture_outbox_health\(\)[\s\S]*?\$\$;/i)?.[0] ?? ''
  assert.match(functionBody, /where\s+outbox\.status\s*<>\s*'completed'/i)
  assert.doesNotMatch(functionBody, /select\s+outbox\.\*/i)
})

test('capture outbox health has a scalar partial index that excludes completed history', async () => {
  const migration = await sql()
  assert.match(migration, /create\s+index\s+concurrently\s+if\s+not\s+exists\s+v105_capture_settlement_outbox_health_idx/i)
  assert.match(migration, /where\s+status\s*<>\s*'completed'/i)
})

test('capture outbox health migration is additive and backend-only', async () => {
  const migration = await sql()
  assert.doesNotMatch(migration, /\b(?:drop|truncate|delete)\b/i)
  assert.match(migration, /set\s+search_path\s*=\s*pg_catalog/i)
  assert.match(migration, /revoke\s+all\s+on\s+function\s+public\.get_v105_capture_outbox_health\(\)\s+from\s+public,\s*anon,\s*authenticated,\s*service_role/i)
  assert.match(migration, /grant\s+execute\s+on\s+function\s+public\.get_v105_capture_outbox_health\(\)\s+to\s+service_role/i)
})
