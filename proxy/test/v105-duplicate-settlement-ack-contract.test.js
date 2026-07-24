import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const hotfixUrl = new URL('../../frontend/supabase/hotfix_v105_duplicate_settlement_ack.sql', import.meta.url)
const schemaUrl = new URL('../../frontend/supabase/schema_v105_formal.sql', import.meta.url)
const manifestUrl = new URL('../../release/v105-formal-release-manifest.json', import.meta.url)

function roadmapConflictBlock(sql) {
  const functionStart = sql.indexOf('create or replace function public.settle_v105_prediction')
  const conflictStart = sql.indexOf('  on conflict (source, table_id, shoe_no, round_no) do update', functionStart)
  const diagnosticsStart = sql.indexOf('  get diagnostics roadmap_written = row_count;', conflictStart)
  return sql.slice(conflictStart, diagnosticsStart)
}

test('v105 duplicate settlement accepts only sparse derived-count replay while still validating immutable roadmap evidence', () => {
  const sql = readFileSync(hotfixUrl, 'utf8')
  const roadmapInsert = sql.indexOf('insert into public.daily_roadmap_events')
  const duplicateAck = sql.indexOf("'duplicate', true")
  assert.ok(roadmapInsert >= 0, 'roadmap insert is required')
  assert.ok(duplicateAck > roadmapInsert, 'duplicate ACK must occur only after immutable roadmap compatibility is checked')
  assert.match(sql, /-\s*'remaining_rank_counts'\s*-\s*'remaining_point_counts'/i)
  assert.match(sql, /excluded\.remaining_rank_counts\s*=\s*'\{\}'::jsonb/i)
  assert.match(sql, /jsonb_each\(excluded\.remaining_point_counts\)/i)
  assert.match(sql, /value\s*<>\s*'null'::jsonb/i)
  assert.match(sql, /raise exception 'conflicting existing roadmap settlement'/i)
  assert.match(sql, /revoke all on function public\.settle_v105_prediction\(jsonb, jsonb\) from public, anon, authenticated/i)
  assert.match(sql, /grant execute on function public\.settle_v105_prediction\(jsonb, jsonb\) to service_role/i)

  const canonicalSchema = readFileSync(schemaUrl, 'utf8')
  assert.equal(roadmapConflictBlock(canonicalSchema), roadmapConflictBlock(sql), 'canonical additive rerun must preserve the hotfix')

  const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'))
  assert.equal(manifest.databaseHotfix, 'frontend/supabase/hotfix_v105_duplicate_settlement_ack.sql')
  assert.equal(manifest.deploymentOrder.includes('database-hotfix'), true)
  assert.ok(manifest.deploymentOrder.indexOf('database-hotfix') < manifest.deploymentOrder.indexOf('proxy'))
})
