import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const migrationUrl = new URL('../../supabase/migrations/20260820020000_v106_formal13_monotonic_projection.sql', import.meta.url)
const writerUrl = new URL('../src/supabase-writer.js', import.meta.url)
const serverUrl = new URL('../src/server.js', import.meta.url)

test('Formal.13 projection migration atomically skips an older session sequence', () => {
  const sql = readFileSync(migrationUrl, 'utf8')
  assert.match(sql, /create or replace function public\.persist_v105_capture_ancillary_projection\(p_projection jsonb\)/i)
  assert.match(sql, /projection_sequence\s+bigint/i)
  assert.match(sql, /projection_captured_at\s+timestamptz/i)
  assert.match(sql, /current_status_sequence[\s\S]*current_snapshot_sequence/i)
  assert.match(sql, /projection_sequence\s*<\s*greatest\(/i)
  assert.match(sql, /if projection_captured_at\s*<\s*current_captured_at then/i)
  assert.doesNotMatch(sql, /projection_sequence\s*=\s*current_sequence\s+and\s+projection_captured_at/i)
  assert.match(sql, /return jsonb_build_object\('persisted', false, 'skipped', true, 'reason', 'stale_sequence'/i)
  assert.match(sql, /update public\.cloud_capture_status[\s\S]*update public\.cloud_table_snapshots/i)
  assert.match(sql, /metadata\s*=\s*projection_status_metadata/i)
  assert.match(sql, /metadata\s*=\s*projection_snapshot_metadata/i)
  assert.match(sql, /revoke all on function public\.persist_v105_capture_ancillary_projection\(jsonb\) from public, anon, authenticated/i)
  assert.match(sql, /grant execute on function public\.persist_v105_capture_ancillary_projection\(jsonb\) to service_role/i)
})

test('Formal.13 runtime carries immutable sequence and capture time from Raw outbox through the atomic projection RPC', () => {
  const writer = readFileSync(writerUrl, 'utf8')
  const server = readFileSync(serverUrl, 'utf8')
  assert.match(writer, /work:\s*\{\s*sessionId:\s*normalizedSessionId,\s*sequence:\s*normalizedSequence,\s*capturedAt:\s*captureTime,/)
  assert.match(writer, /async persistCaptureAncillaryProjection\(\{\s*sessionId,\s*sequence,\s*capturedAt,/)
  assert.match(writer, /rpc\/persist_v105_capture_ancillary_projection/)
  assert.match(server, /work\.sequence\s*\?\?\s*sequence/)
  assert.match(server, /work\.capturedAt/)
  assert.match(server, /supabaseClient\.persistCaptureAncillaryProjection/)
  assert.match(server, /if \(production\) throw new Error\('atomic monotonic capture projection writer is required'\)[\s\S]*Promise\.all/)
})
