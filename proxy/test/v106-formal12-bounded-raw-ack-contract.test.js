import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

const migrationUrl = new URL('../../supabase/migrations/20260820010000_v106_formal12_bounded_raw_ack.sql', import.meta.url)
const serverUrl = new URL('../src/server.js', import.meta.url)
const writerUrl = new URL('../src/supabase-writer.js', import.meta.url)

test('Formal.12 raw ACK migration keeps only immutable durable work in the ACK transaction and fails lock contention fast', () => {
  assert.equal(existsSync(migrationUrl), true, 'Formal.12 bounded raw ACK migration is missing')
  const sql = readFileSync(migrationUrl, 'utf8')
  assert.match(sql, /create or replace function public\.persist_v105_capture_envelope\(p_capture jsonb\)/i)
  assert.match(sql, /create or replace function public\.persist_v105_fenced_capture_envelope\(p_capture jsonb\)/i)
  assert.match(sql, /set_config\('lock_timeout',\s*'5000',\s*true\)/i)
  assert.match(sql, /pg_try_advisory_xact_lock/i)
  assert.match(sql, /pg_try_advisory_xact_lock_shared/i)
  assert.match(sql, /source_epoch\s*=\s*current_fence\.epoch[\s\S]*source_owner_id\s+is not distinct from current_fence\.owner_id[\s\S]*pg_try_advisory_xact_lock_shared/i)
  assert.match(sql, /raise exception 'capture_lock_busy_retry'/i)
  assert.match(sql, /for update nowait/i)
  assert.match(sql, /insert into public\.cloud_table_rounds/i)
  assert.match(sql, /insert into public\.v105_capture_settlement_outbox/i)
  assert.match(sql, /insert into public\.v105_capture_ingest_sessions/i)
  assert.doesNotMatch(sql, /persist_latest_cloud_table_snapshot/i)
  assert.doesNotMatch(sql, /(?:insert into|update) public\.cloud_capture_status/i)
  assert.match(sql, /revoke all on function public\.persist_v105_capture_envelope\(jsonb\) from public, anon, authenticated, service_role/i)
  assert.match(sql, /grant execute on function public\.persist_v105_fenced_capture_envelope\(jsonb\) to service_role/i)
})

test('Formal.12 raw lane and HTTP deadline fail before the upstream edge while ancillary snapshot writes stay outside the ACK await path', () => {
  const server = readFileSync(serverUrl, 'utf8')
  const writer = readFileSync(writerUrl, 'utf8')
  assert.match(server, /INGEST_REQUEST_DEADLINE_MS \?\? 15000/)
  assert.match(writer, /createPool\(2, \{ connectionTimeoutMillis: 5000, queryTimeoutMs: 12000, statementTimeoutMs: 10000 \}\)/)
  const ackStart = server.indexOf("const rawAcknowledgement = await supabaseClient.persistCaptureEnvelope")
  const ackReturn = server.indexOf('return jsonResponse(200, ack, frontendOrigin)', ackStart)
  const ancillarySchedule = server.indexOf('scheduleCaptureAncillaryPersistence(parsed)', ackStart)
  assert.ok(ackStart >= 0 && ancillarySchedule > ackStart && ancillarySchedule < ackReturn)
  assert.doesNotMatch(server.slice(ackStart, ackReturn), /await scheduleCaptureAncillaryPersistence/)
  assert.match(server, /async function persistCaptureAncillaryProjection\(parsed\)[\s\S]*writeCloudCaptureStatus[\s\S]*writeCloudTableSnapshot/)
  assert.match(server, /runLeasePhase\('ancillary_projection'[\s\S]*persistCaptureAncillaryProjection[\s\S]*completeCaptureOutbox/)
})
