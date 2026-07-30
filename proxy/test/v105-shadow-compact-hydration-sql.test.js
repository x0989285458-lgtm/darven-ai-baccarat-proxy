import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const INDEX_MIGRATION = new URL('../../supabase/migrations/20260730010000_v105_shadow_compact_hydration.sql', import.meta.url)
const RPC_MIGRATION = new URL('../../supabase/migrations/20260730010100_v105_shadow_compact_hydration_rpcs.sql', import.meta.url)
const VERSIONS = ['v6', 'v7', 'v8', 'v9']

test('compact hydration indexes are additive, concurrent, and outside an explicit transaction', async () => {
  const sql = await readFile(INDEX_MIGRATION, 'utf8')
  assert.doesNotMatch(sql, /\b(drop|truncate|delete\s+from|alter\s+table\s+[^;]+\s+drop)\b/i)
  assert.doesNotMatch(sql, /\b(begin|commit)\s*;/i)
  for (const version of VERSIONS) {
    assert.match(sql, new RegExp(`create\\s+index\\s+concurrently\\s+if\\s+not\\s+exists\\s+v105_shadow_${version}_issuances_table_issued_idx\\s+on\\s+public\\.v105_shadow_${version}_issuances\\s*\\(table_id\\s*,\\s*prediction_issued_at\\s+desc\\s*,\\s*id\\s+desc\\s*\\)`, 'i'))
  }
})

test('each compact hydration RPC is SECURITY DEFINER, bounded to 1..60, and service-role-only', async () => {
  const sql = await readFile(RPC_MIGRATION, 'utf8')
  assert.match(sql, /^\s*begin\s*;/i)
  assert.match(sql, /commit\s*;\s*$/i)
  assert.doesNotMatch(sql, /create\s+index/i)
  for (const version of VERSIONS) {
    const name = `get_v105_shadow_${version}_compact_history`
    assert.match(sql, new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\(p_per_table_limit\\s+integer\\)`, 'i'))
    assert.match(sql, new RegExp(`${name}[\\s\\S]+security\\s+definer[\\s\\S]+set\\s+search_path\\s*=\\s*pg_catalog\\s*,\\s*public`, 'i'))
    assert.match(sql, new RegExp(`${name}[\\s\\S]+p_per_table_limit\\s+not\\s+between\\s+1\\s+and\\s+60`, 'i'))
    assert.match(sql, new RegExp(`v105_shadow_${version}_settlements[\\s\\S]+settlement_final\\s*=\\s*true`, 'i'))
    assert.match(sql, new RegExp(`revoke\\s+all\\s+on\\s+function\\s+public\\.${name}\\(integer\\)\\s+from\\s+public\\s*,\\s*anon\\s*,\\s*authenticated\\s*,\\s*service_role`, 'i'))
    assert.match(sql, new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${name}\\(integer\\)\\s+to\\s+service_role`, 'i'))
  }
})

test('each compact hydration RPC uses fixed-table lateral early limits for Final and pending rows without WindowAgg', async () => {
  const sql = await readFile(RPC_MIGRATION, 'utf8')
  assert.doesNotMatch(sql, /\b(row_number\s*\(|over\s*\(|window\s+)/i)
  for (const version of VERSIONS) {
    const start = sql.indexOf(`create or replace function public.get_v105_shadow_${version}_compact_history`)
    const end = sql.indexOf('$$;', start)
    const body = sql.slice(start, end)
    assert.match(body, /values\s*\('BAG01'\)\s*,\s*\('BAG02'\)\s*,\s*\('BAG03'\)\s*,\s*\('BAG03A'\)\s*,\s*\('BAG05'\)\s*,\s*\('BAG06'\)\s*,\s*\('BAG07'\)\s*,\s*\('BAG08'\)\s*,\s*\('BAG09'\)\s*,\s*\('BAG10'\)/i)
    assert.equal((body.match(/cross\s+join\s+lateral/gi) ?? []).length, 2)
    assert.match(body, /settlement_final\s*=\s*true[\s\S]+order\s+by\s+i\.prediction_issued_at\s+desc\s*,\s*i\.id\s+desc[\s\S]+limit\s+p_per_table_limit/i)
    assert.match(body, /null::text\s+as\s+actual_result\s*,\s*false\s+as\s+settlement_final[\s\S]+not\s+exists\s*\([\s\S]+settlement_final\s*=\s*true[\s\S]+order\s+by\s+i\.prediction_issued_at\s+desc\s*,\s*i\.id\s+desc[\s\S]+limit\s+1/i)
  }
})

test('compact hydration RPCs expose exactly the compact fields and never select wide JSON', async () => {
  const sql = await readFile(RPC_MIGRATION, 'utf8')
  const forbidden = ['prediction_payload', 'actual_facts', 'head_results']
  for (const field of forbidden) assert.doesNotMatch(sql, new RegExp(`\\b${field}\\b`, 'i'))
  for (const field of ['prediction_id', 'source', 'table_id', 'shoe_no', 'round_no', 'strategy_version', 'prediction_timing', 'prediction_issued_at', 'predicted_result', 'same_side_streak', 'actual_result', 'settlement_final']) {
    assert.match(sql, new RegExp(`\\b${field}\\b`, 'i'))
  }
  assert.match(sql, /order\s+by\s+(?:compact\.)?prediction_issued_at\s+asc\s*,\s*(?:compact\.)?prediction_id\s+asc/i)
})
