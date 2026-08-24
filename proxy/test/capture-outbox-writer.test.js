import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createSupabaseIngestionClient } from '../src/supabase-writer.js'

const migrationUrl = new URL('../../supabase/migrations/20260729043000_v105_capture_settlement_outbox.sql', import.meta.url)
const zeroFinalHeartbeatMigrationUrl = new URL('../../supabase/migrations/20260823113000_v105_zero_final_heartbeat_outbox_fast_complete.sql', import.meta.url)
const sameSessionBatchMigrationUrl = new URL('../../supabase/migrations/20260824010000_v105_capture_outbox_same_session_batch.sql', import.meta.url)

const response = (payload) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(payload),
  json: async () => payload,
})

test('capture outbox migration is additive, atomic, service-role-only, and conflict-safe', () => {
  const sql = readFileSync(migrationUrl, 'utf8')
  assert.match(sql, /create table if not exists public\.v105_capture_settlement_outbox/i)
  assert.match(sql, /create or replace function public\.persist_v105_capture_envelope\(p_capture jsonb\)/i)
  assert.match(sql, /cloud_table_rounds/i)
  assert.match(sql, /persist_latest_cloud_table_snapshot/i)
  assert.match(sql, /cloud_capture_status/i)
  assert.match(sql, /v105_capture_settlement_outbox/i)
  assert.match(sql, /capture identity conflict/i)
  assert.match(sql, /for update skip locked/i)
  assert.match(sql, /status = 'processing'.*locked_at < pg_catalog\.now\(\) - interval '5 minutes'/is)
  assert.match(sql, /status = 'error'.*next_attempt_at <= pg_catalog\.now\(\)/is)
  assert.match(sql, /revoke all on function public\.persist_v105_capture_envelope\(jsonb\) from public,\s*anon,\s*authenticated,\s*service_role/i)
  assert.match(sql, /grant execute on function public\.persist_v105_capture_envelope\(jsonb\) to service_role/i)
  assert.doesNotMatch(sql, /\b(drop|truncate|delete\s+from)\b/i)
})

test('migration fences leases, isolates poison rows, and serializes monotonic session state', () => {
  const sql = readFileSync(migrationUrl, 'utf8')
  assert.match(sql, /claim_token\s+uuid/i)
  assert.match(sql, /lease_generation\s+bigint/i)
  assert.match(sql, /next_attempt_at\s+timestamptz/i)
  assert.match(sql, /dead_letter/i)
  assert.match(sql, /pg_catalog\.pg_advisory_xact_lock\s*\(\s*pg_catalog\.hashtextextended\s*\(capture_session/is)
  assert.match(sql, /latest_sequence\s+bigint/i)
  assert.match(sql, /claimable_heads[\s\S]*not exists[\s\S]*earlier\.session_id\s*=\s*outbox\.session_id[\s\S]*next_wakeup_at/i)
  assert.match(sql, /complete_v105_capture_settlement_outbox\(p_session_id text, p_sequence bigint, p_claim_token uuid, p_attempt integer\)/i)
  assert.match(sql, /status\s*=\s*'processing'[\s\S]*claim_token\s*=\s*p_claim_token[\s\S]*attempts\s*=\s*p_attempt/i)
  assert.match(sql, /set search_path = pg_catalog, public, extensions/i)
})

test('same-session batch migration claims one ordered prefix and atomically completes or fails exact leases', () => {
  const sql = readFileSync(sameSessionBatchMigrationUrl, 'utf8')
  assert.match(sql, /claim_v105_capture_settlement_outbox_batch\(p_limit integer default 10\)/i)
  assert.match(sql, /head as materialized[\s\S]*for update skip locked[\s\S]*limit 1/i)
  assert.match(sql, /join head on head\.session_id = outbox\.session_id/i)
  assert.match(sql, /bool_or[\s\S]*blocked[\s\S]*where ordered\.blocked is false/i)
  assert.match(sql, /complete_v105_capture_settlement_outbox_batch\(p_claims jsonb\)/i)
  assert.match(sql, /fail_v105_capture_settlement_outbox_batch\(p_claims jsonb, p_error text\)/i)
  assert.match(sql, /if affected <> expected then raise exception 'capture outbox stale batch completion rejected'/i)
  assert.match(sql, /if affected <> expected then raise exception 'capture outbox stale batch failure rejected'/i)
  assert.match(sql, /grant execute on function public\.claim_v105_capture_settlement_outbox_batch\(integer\) to service_role/i)
  assert.doesNotMatch(sql, /\b(drop|truncate|delete\s+from)\b/i)
})

test('zero-Final heartbeat keeps an idempotency row but completes it without settlement work', () => {
  const sql = readFileSync(zeroFinalHeartbeatMigrationUrl, 'utf8')
  assert.match(sql, /jsonb_array_length\(capture_rounds\)\s*=\s*0[\s\S]*'completed'/i)
  assert.match(sql, /insert into public\.v105_capture_settlement_outbox[\s\S]*status[\s\S]*processed_at/i)
  assert.match(sql, /create or replace function public\.persist_v105_capture_envelope\(p_capture jsonb\)/i)
  assert.match(sql, /grant execute on function public\.persist_v105_capture_envelope\(jsonb\) to service_role/i)
  assert.doesNotMatch(sql, /\b(drop|truncate|delete\s+from)\b/i)
})

test('writer persists one atomic capture envelope and verifies exact accepted round keys', async () => {
  const requests = []
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co',
    serviceKey: 'test-only',
    requireVerifiedStrategy: false,
    fetchImpl: async (url, options) => {
      requests.push({ url: new URL(url), body: JSON.parse(options.body) })
      return response({ persisted: true, duplicate: false, accepted_round_keys: ['BAG01:88:21'] })
    },
  })
  const result = await client.persistCaptureEnvelope({
    sessionId: 'worker-session',
    sequence: 7,
    roundKeys: ['BAG01:88:21'],
    status: { connected: true, authenticated: true, tableCount: 1 },
    tables: [{ tableId: 'BAG01', shoe: 88, round: 21 }],
    rounds: [{
      tableId: 'BAG01', shoe: 88, round: 21, winner: 'banker',
      rawResult: [1, 9, 2, 10, -1, -1, -1, -1, 1, 9], sourceAction: '/summary',
    }],
  })
  assert.deepEqual(result.acceptedRoundKeys, ['BAG01:88:21'])
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url.pathname, '/rest/v1/rpc/persist_v105_capture_envelope')
  assert.equal(requests[0].body.p_capture.sequence, 7)
  assert.deepEqual(requests[0].body.p_capture.round_keys, ['BAG01:88:21'])
  assert.equal(requests[0].body.p_capture.rounds[0].table_id, 'BAG01')
  assert.equal(requests[0].body.p_capture.status.last_round_at, new Date(7).toISOString())
})

test('claim, complete, fail, and their batch variants use direct DB RPCs with unforgeable lease identity', async () => {
  const queries = []
  const pool = {
    async query(query) {
      queries.push(query)
      if (/claim_v105_capture_settlement_outbox_batch/.test(query.text)) return { rows: [{ session_id: 's', sequence: 1, claim_token: 'token', attempts: 2 }] }
      const functionName = /as\s+(\w+)/i.exec(query.text)?.[1]
      return { rows: [{ [functionName]: { ok: true } }] }
    },
  }
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false, strategyPool: pool,
    fetchImpl: async () => { assert.fail('direct DB must be preferred when configured') },
  })
  const claimed = await client.claimCaptureOutbox({ limit: 7 })
  await client.completeCaptureOutbox({ sessionId: 's', sequence: 1, claimToken: 'token', attempt: 2 })
  await client.failCaptureOutbox({ sessionId: 's', sequence: 2, claimToken: 'token-2', attempt: 3, error: 'safe error' })
  const claims = [{ sessionId: 's', sequence: 3, claimToken: 'token-3', attempt: 1 }]
  await client.completeCaptureOutboxBatch({ claims })
  await client.failCaptureOutboxBatch({ claims, error: 'batch error' })
  assert.equal(claimed[0].claim_token, 'token')
  assert.match(queries[0].text, /claim_v105_capture_settlement_outbox_batch\(\$1::integer\)/)
  assert.deepEqual(queries[1].values, ['s', 1, 'token', 2])
  assert.deepEqual(queries[2].values, ['s', 2, 'token-2', 3, 'safe error'])
  const wireClaims = [{ session_id: 's', sequence: 3, claim_token: 'token-3', attempt: 1 }]
  assert.deepEqual(queries[3].values, [JSON.stringify(wireClaims)])
  assert.deepEqual(queries[4].values, [JSON.stringify(wireClaims), 'batch error'])
})

test('batch rank-ledger hydration recovers missing current shoes before one exact reread', async () => {
  const queries = []
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    strategyPool: { async query(query) {
      queries.push(query)
      if (/rebuild_v100_rank_ledger_from_cloud_rounds/i.test(query.text)) return { rows: [{ recovery: { accepted: true, status: 'contiguous' } }] }
      return { rows: [] }
    } },
    fetchImpl: async () => assert.fail('Direct DB batch hydration must not use REST'),
  })
  const identities = [
    { source: 'mt-cloud', tableId: 'BAG01', shoe: 'S1' },
    { source: 'mt-cloud', tableId: 'BAG10', shoe: 'S9' },
  ]

  assert.deepEqual(await client.readV100RankLedgers(identities), [])
  assert.equal(queries.length, 4)
  assert.match(queries[0].text, /unnest\(\$1::text\[\], \$2::text\[\], \$3::text\[\]\)/i)
  assert.match(queries[1].text, /rebuild_v100_rank_ledger_from_cloud_rounds\(\$1,\$2,\$3\)/i)
  assert.deepEqual(queries[1].values, ['mt-cloud', 'BAG01', 'S1'])
  assert.deepEqual(queries[2].values, ['mt-cloud', 'BAG10', 'S9'])
  assert.deepEqual(queries[3].values, [['mt-cloud', 'mt-cloud'], ['BAG01', 'BAG10'], ['S1', 'S9']])
})

test('batch rank-ledger hydration never rebuilds a terminal invalid ledger', async () => {
  const queries = []
  const ranks = Object.fromEntries(['A','2','3','4','5','6','7','8','9','10','J','Q','K'].map((rank) => [rank, 0]))
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    strategyPool: { async query(query) {
      queries.push(query)
      return { rows: [{
        source: 'mt-cloud', table_id: 'BAG01', shoe_no: 'S1', complete_through_round: 0,
        seen_dealt_rank_counts: ranks,
        seen_dealt_code_counts: Object.fromEntries(Array.from({ length: 52 }, (_, index) => [String(index + 1), 0])),
        undealt_after_observed_deals: Object.fromEntries(Object.keys(ranks).map((rank) => [rank, 32])),
        cards_seen_dealt: 0, status: 'invalid', ledger_checksum: '0'.repeat(64), revision: 1,
        physical_remaining_exact: false, burn_observation_status: 'unavailable',
      }] }
    } },
    fetchImpl: async () => assert.fail('Direct DB hydration must not use REST'),
  })

  const rows = await client.readV100RankLedgers([{ source: 'mt-cloud', tableId: 'BAG01', shoe: 'S1' }])

  assert.equal(rows[0].status, 'invalid')
  assert.equal(queries.length, 1)
  assert.doesNotMatch(queries[0].text, /rebuild_v100_rank_ledger_from_cloud_rounds/i)
})

test('outbox health is available through direct DB and REST fallback', async () => {
  const direct = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    strategyPool: { async query(query) {
      assert.match(query.text, /get_v105_capture_outbox_health\(\)/)
      return { rows: [{ health: { pending: 1, dead_letter: 2, alert: true } }] }
    } },
    fetchImpl: async () => assert.fail('direct health must not use REST'),
  })
  assert.deepEqual(await direct.getCaptureOutboxHealth(), { pending: 1, dead_letter: 2, alert: true })

  let requested
  const rest = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    fetchImpl: async (url) => {
      requested = new URL(url)
      return response({ pending: 0, error: 0, processing: 0, dead_letter: 0, alert: false })
    },
  })
  assert.equal((await rest.getCaptureOutboxHealth()).alert, false)
  assert.equal(requested.pathname, '/rest/v1/rpc/get_v105_capture_outbox_health')
})
