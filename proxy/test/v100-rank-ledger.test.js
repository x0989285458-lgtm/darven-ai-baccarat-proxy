import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { RANKS, createRankLedger, rehydrateRankLedger, checksumRankLedgerSnapshot } from '../src/rank-ledger.js'
import { createProxyState } from '../src/state-store.js'
import { buildLivePrediction, createSupabaseIngestionClient } from '../src/supabase-writer.js'

const FINAL = '/api/v1/gametype/*/game/*/room/*/table/*/summary'

function finalRound(overrides = {}) {
  return {
    source: 'mt-cloud',
    tableId: 'BAG01',
    shoe: 'S100',
    round: 1,
    sourceAction: FINAL,
    rawResult: [1, 2, 14, 15, 27, 28, -1, -1, 4, 6],
    ...overrides,
  }
}

test('ledger rejects provisional, malformed, and incomplete-identity observations without counting cards', () => {
  const ledger = createRankLedger()
  assert.equal(ledger.recordFinal(finalRound({ sourceAction: 'show_poker' })).disposition, 'rejected')
  assert.equal(ledger.recordFinal(finalRound({ rawResult: [1, 2] })).disposition, 'rejected')
  assert.equal(ledger.recordFinal(finalRound({ source: '' })).disposition, 'rejected')
  assert.equal(ledger.getState('mt-cloud', 'BAG01', 'S100'), null)
})

test('same round and hash is idempotent while a different hash conflicts without recounting', () => {
  const ledger = createRankLedger()
  const first = ledger.recordFinal(finalRound())
  const duplicate = ledger.recordFinal(finalRound())
  const conflict = ledger.recordFinal(finalRound({ rawResult: [3, 4, 16, 17, 29, 30, -1, -1, 6, 8] }))

  assert.equal(first.disposition, 'accepted')
  assert.equal(duplicate.disposition, 'duplicate')
  assert.equal(duplicate.cards_seen_dealt, 6)
  assert.equal(conflict.disposition, 'conflicted')
  assert.equal(conflict.status, 'conflicted')
  assert.equal(conflict.cards_seen_dealt, 6)
})

test('first-seen round above one and gaps are unavailable, never deduct, and can be retried after continuity is restored', () => {
  const ledger = createRankLedger()
  const round2 = finalRound({ round: 2, rawResult: [3, 4, 16, 17, -1, -1, -1, -1, 6, 8] })
  const gap = ledger.recordFinal(round2)
  assert.equal(gap.disposition, 'gap')
  assert.equal(gap.status, 'gap')
  assert.equal(gap.cards_seen_dealt, 0)
  assert.equal(gap.complete_through_round, 0)

  assert.equal(ledger.recordFinal(finalRound()).disposition, 'accepted')
  const recovered = ledger.recordFinal(round2)
  assert.equal(recovered.disposition, 'accepted')
  assert.equal(recovered.complete_through_round, 2)
  assert.equal(recovered.cards_seen_dealt, 10)
})

test('physical card and rank limits mark the shoe invalid without clamping or applying the violating round', () => {
  const ledger = createRankLedger()
  const fourSameConcreteCards = (round) => finalRound({ round, rawResult: [1, 1, 1, 1, -1, -1, -1, -1, 4, 6] })
  assert.equal(ledger.recordFinal(fourSameConcreteCards(1)).status, 'contiguous')
  assert.equal(ledger.recordFinal(fourSameConcreteCards(2)).status, 'contiguous')

  const invalid = ledger.recordFinal(fourSameConcreteCards(3))
  assert.equal(invalid.disposition, 'invalid')
  assert.equal(invalid.status, 'invalid')
  assert.match(invalid.invalid_reason, /card_code_limit/)
  assert.equal(invalid.cards_seen_dealt, 8)
  assert.equal(invalid.seen_dealt_rank_counts.A, 8)
  assert.equal(invalid.undealt_after_observed_deals.A, 24)

  const afterInvalid = ledger.recordFinal(finalRound({ round: 3, rawResult: [2, 2, 2, 2, -1, -1, -1, -1, 4, 6] }))
  assert.equal(afterInvalid.disposition, 'invalid')
  assert.equal(afterInvalid.status, 'invalid')
  assert.equal(afterInvalid.cards_seen_dealt, 8, 'invalid is terminal and never resumes counting')
})

test('conflicted is terminal and later rounds cannot advance the ledger', () => {
  const ledger = createRankLedger()
  ledger.recordFinal(finalRound())
  ledger.recordFinal(finalRound({ rawResult: [3, 4, 16, 17, 29, 30, -1, -1, 6, 8] }))

  const later = ledger.recordFinal(finalRound({ round: 2, rawResult: [5, 6, 18, 19, -1, -1, -1, -1, 0, 2] }))
  assert.equal(later.disposition, 'conflicted')
  assert.equal(later.status, 'conflicted')
  assert.equal(later.complete_through_round, 1)
  assert.equal(later.cards_seen_dealt, 6)
})

test('table and shoe identities are isolated', () => {
  const ledger = createRankLedger()
  ledger.recordFinal(finalRound())
  ledger.recordFinal(finalRound({ tableId: 'BAG02', rawResult: [3, 4, 16, 17, -1, -1, -1, -1, 6, 8] }))
  ledger.recordFinal(finalRound({ shoe: 'S101', rawResult: [5, 6, 18, 19, -1, -1, -1, -1, 0, 2] }))

  assert.equal(ledger.getState('mt-cloud', 'BAG01', 'S100').cards_seen_dealt, 6)
  assert.equal(ledger.getState('mt-cloud', 'BAG02', 'S100').cards_seen_dealt, 4)
  assert.equal(ledger.getState('mt-cloud', 'BAG01', 'S101').cards_seen_dealt, 4)
})

test('snapshot checksum and rehydrate rebuild exactly and preserve pending gap idempotency across restart', () => {
  const ledger = createRankLedger()
  const round3 = finalRound({ round: 3, rawResult: [5, 6, 18, 19, -1, -1, -1, -1, 0, 2] })
  ledger.recordFinal(finalRound())
  ledger.recordFinal(round3)
  const snapshot = ledger.snapshot()

  assert.equal(snapshot.checksum, checksumRankLedgerSnapshot(snapshot))
  const restarted = rehydrateRankLedger(JSON.parse(JSON.stringify(snapshot)))
  assert.deepEqual(restarted.snapshot(), snapshot)

  const impossibleProgress = JSON.parse(JSON.stringify(snapshot))
  impossibleProgress.shoes[0].complete_through = 999
  impossibleProgress.checksum = checksumRankLedgerSnapshot(impossibleProgress)
  assert.throws(() => rehydrateRankLedger(impossibleProgress), /invalid rank ledger snapshot state/i)

  const invalidStatus = JSON.parse(JSON.stringify(snapshot))
  invalidStatus.shoes[0].status = 'forged'
  invalidStatus.checksum = checksumRankLedgerSnapshot(invalidStatus)
  assert.throws(() => rehydrateRankLedger(invalidStatus), /invalid rank ledger snapshot state/i)

  restarted.recordFinal(finalRound({ round: 2, rawResult: [3, 4, 16, 17, -1, -1, -1, -1, 6, 8] }))
  const completed = restarted.recordFinal(round3)
  assert.equal(completed.disposition, 'accepted')
  assert.equal(completed.complete_through_round, 3)
  assert.throws(() => rehydrateRankLedger({ ...snapshot, checksum: 'tampered' }), /checksum/i)
})

test('state store mounts trusted ledger only under v102 namespace and gates next-round rank data on exact continuity', () => {
  const state = createProxyState({ inferSnapshotRounds: false })
  state.setTables([{ tableId: 'BAG01', shoe: 'S100', round: 0 }])
  state.upsertRoundEvent(finalRound())
  let table = state.snapshot().tables[0]

  assert.equal(table.cardShoe, undefined, 'v102 must not override the formal v98 table.cardShoe input')
  assert.equal(table.v102RankLedger.status, 'contiguous')
  assert.equal(table.v102RankLedger.complete_through_round, 1)
  assert.equal(table.v102RankLedger.rankDataAvailable, true)
  assert.equal(table.v102RankLedger.targetRound, 2)
  assert.equal(table.lastRound.cardShoe.cardsSeenTotal, 6, 'legacy v98 lastRound cardShoe remains compatible')

  state.upsertRoundEvent(finalRound({ round: 3, rawResult: [5, 6, 18, 19, -1, -1, -1, -1, 0, 2] }))
  table = state.snapshot().tables[0]
  assert.equal(table.v102RankLedger.status, 'gap')
  assert.equal(table.v102RankLedger.rankDataAvailable, false)
})

test('v102 formal runtime consumes the trusted state-store rank ledger', () => {
  const state = createProxyState({ inferSnapshotRounds: false })
  state.setTables([{ tableId: 'BAG01', shoe: 'S100', round: 0, bankerCount: 0, playerCount: 0, tieCount: 0 }])
  state.upsertRoundEvent(finalRound())
  const table = state.snapshot().tables[0]
  const withoutCandidateNamespace = structuredClone(table)
  delete withoutCandidateNamespace.v102RankLedger

  const withLedger = buildLivePrediction(table)
  const withoutLedger = buildLivePrediction(withoutCandidateNamespace)
  assert.notDeepEqual(withLedger.sidePredictions, withoutLedger.sidePredictions)
  assert.equal(withLedger.predictionFeatures.v102_side_policy.diagnostics.rank.available, true)
  assert.equal(withoutLedger.predictionFeatures.v102_side_policy.diagnostics.rank.available, false)
})

test('authoritative table snapshot switches shoe and delayed old-shoe Final cannot pollute active v102 ledger', () => {
  const state = createProxyState({ inferSnapshotRounds: false })
  state.setTables([{ tableId: 'BAG01', shoe: 'S100', round: 0 }])
  state.upsertRoundEvent(finalRound())
  state.setTables([{ tableId: 'BAG01', shoe: 'S101', round: 0 }])
  state.upsertRoundEvent(finalRound({ shoe: 'S101', round: 1, rawResult: [3, 4, 16, 17, -1, -1, -1, -1, 6, 8] }))
  const activeBeforeDelay = state.snapshot().tables[0]
  assert.equal(activeBeforeDelay.shoe, 'S101')
  assert.equal(activeBeforeDelay.v102RankLedger.identity.shoe, 'S101')

  state.upsertRoundEvent(finalRound({ shoe: 'S100', round: 2, rawResult: [5, 6, 18, 19, -1, -1, -1, -1, 0, 2] }))
  const activeAfterDelay = state.snapshot().tables[0]
  assert.equal(activeAfterDelay.shoe, 'S101')
  assert.equal(activeAfterDelay.v102RankLedger.identity.shoe, 'S101')
  assert.equal(activeAfterDelay.v102RankLedger.cards_seen_dealt, 4)
})

test('after restart an old-shoe round one cannot regress the authoritative active shoe', () => {
  const restarted = createProxyState({ inferSnapshotRounds: false })
  restarted.setTables([{ tableId: 'BAG01', shoe: 'S101', round: 10 }])
  restarted.upsertRoundEvent(finalRound({ shoe: 'S100', round: 1 }))

  const table = restarted.snapshot().tables[0]
  assert.equal(table.shoe, 'S101')
  assert.equal(table.round, 10)
  assert.equal(table.v102RankLedger, undefined)
})

test('v102 Supabase client sends only immutable Final evidence and verifies a complete DB-derived ledger ACK', async () => {
  const calls = []
  const dbState = createRankLedger().recordFinal(finalRound())
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    return new Response(JSON.stringify({
      accepted: true,
      duplicate: calls.length > 1,
      status: 'contiguous',
      complete_through_round: 1,
      revision: 1,
      seen_dealt_rank_counts: dbState.seen_dealt_rank_counts,
      seen_dealt_code_counts: Object.fromEntries(Array.from({ length: 52 }, (_, index) => [index + 1, [1, 2, 14, 15, 27, 28].includes(index + 1) ? 1 : 0])),
      undealt_after_observed_deals: dbState.undealt_after_observed_deals,
      cards_seen_dealt: 6,
      ledger_checksum: 'a'.repeat(64),
      physical_remaining_exact: false,
      burn_observation_status: 'unavailable',
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const client = createSupabaseIngestionClient({ url: 'https://example.supabase.co', serviceKey: 'test-only', fetchImpl, requireVerifiedStrategy: false })
  const result = await client.applyV100RankLedgerEvent(finalRound())
  const duplicateResult = await client.applyV100RankLedgerEvent(finalRound())

  assert.equal(result.rankDataAvailable, true)
  assert.equal(duplicateResult.rankDataAvailable, true)
  assert.equal(duplicateResult.targetRound, 2)
  assert.equal(result.targetRound, 2)
  const body = JSON.parse(calls[0].options.body)
  assert.equal(calls[0].url.endsWith('/rest/v1/rpc/apply_v102_rank_ledger_event'), true)
  assert.deepEqual(Object.keys(body.p_event).sort(), ['raw_result_exact10', 'round_no', 'shoe_no', 'source', 'source_action', 'table_id'])
  assert.equal(body.p_event.event_hash, undefined)
  assert.equal(body.p_event.dealt_rank_delta, undefined)
  assert.equal(body.p_ledger, null)
})

test('v102 Supabase client rejects a DB ACK whose code counts do not aggregate to its rank counts', async () => {
  const seen = Object.fromEntries(RANKS.map((rank) => [rank, rank === 'A' || rank === '2' ? 3 : 0]))
  const undealt = Object.fromEntries(RANKS.map((rank) => [rank, 32 - seen[rank]]))
  const mismatchedCodes = Object.fromEntries(Array.from({ length: 52 }, (_, index) => [index + 1, [1, 14, 27, 40, 2, 15].includes(index + 1) ? 1 : 0]))
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    fetchImpl: async () => new Response(JSON.stringify({
      accepted: true, duplicate: false, status: 'contiguous', complete_through_round: 1, revision: 1,
      seen_dealt_rank_counts: seen, seen_dealt_code_counts: mismatchedCodes,
      undealt_after_observed_deals: undealt, cards_seen_dealt: 6,
      ledger_checksum: 'c'.repeat(64), physical_remaining_exact: false, burn_observation_status: 'unavailable',
    }), { status: 200 }),
  })
  await assert.rejects(() => client.applyV100RankLedgerEvent(finalRound()), /acknowledgement failed/i)
})

test('v102 Supabase client rehydrates only one exact durable ledger identity and rejects mismatches', async () => {
  const row = {
    source: 'mt-cloud', table_id: 'BAG01', shoe_no: 'S100', complete_through_round: 1,
    seen_dealt_rank_counts: Object.fromEntries(RANKS.map((rank) => [rank, rank === 'A' || rank === '2' ? 3 : 0])),
    seen_dealt_code_counts: Object.fromEntries(Array.from({ length: 52 }, (_, index) => [index + 1, [1, 2, 14, 15, 27, 28].includes(index + 1) ? 1 : 0])),
    undealt_after_observed_deals: Object.fromEntries(RANKS.map((rank) => [rank, rank === 'A' || rank === '2' ? 29 : 32])),
    cards_seen_dealt: 6, status: 'contiguous', ledger_checksum: 'b'.repeat(64), revision: 1,
    physical_remaining_exact: false, burn_observation_status: 'unavailable',
  }
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    fetchImpl: async () => new Response(JSON.stringify([row]), { status: 200 }),
  })
  const result = await client.readV100RankLedger({ source: 'mt-cloud', tableId: 'BAG01', shoe: 'S100' })
  assert.equal(result.rankDataAvailable, true)
  assert.equal(result.completeThroughRound, 1)

  const gapRow = {
    ...row,
    complete_through_round: 0,
    seen_dealt_rank_counts: Object.fromEntries(RANKS.map((rank) => [rank, 0])),
    seen_dealt_code_counts: Object.fromEntries(Array.from({ length: 52 }, (_, index) => [index + 1, 0])),
    undealt_after_observed_deals: Object.fromEntries(RANKS.map((rank) => [rank, 0])),
    cards_seen_dealt: 0,
    status: 'gap',
    ledger_checksum: '0'.repeat(64),
  }
  const gapClient = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    fetchImpl: async () => new Response(JSON.stringify([gapRow]), { status: 200 }),
  })
  const gap = await gapClient.readV100RankLedger({ source: 'mt-cloud', tableId: 'BAG01', shoe: 'S100' })
  assert.equal(gap.status, 'gap')
  assert.equal(gap.rankDataAvailable, false)
  assert.equal(gap.completeThroughRound, 0)

  const mismatch = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    fetchImpl: async () => new Response(JSON.stringify([{ ...row, shoe_no: 'S999' }]), { status: 200 }),
  })
  await assert.rejects(() => mismatch.readV100RankLedger({ source: 'mt-cloud', tableId: 'BAG01', shoe: 'S100' }), /identity mismatch/i)
})

test('fixed eight-deck ledger accepts contiguous verified Final exact10 and exposes observation-only semantics', () => {
  const ledger = createRankLedger()
  const result = ledger.recordFinal(finalRound())

  assert.equal(result.disposition, 'accepted')
  assert.equal(result.status, 'contiguous')
  assert.equal(result.complete_through_round, 1)
  assert.equal(result.cards_seen_dealt, 6)
  assert.equal(result.seen_dealt_rank_counts.A, 3)
  assert.equal(result.seen_dealt_rank_counts['2'], 3)
  assert.equal(result.undealt_after_observed_deals.A, 29)
  assert.equal(result.undealt_after_observed_deals['2'], 29)
  assert.equal(Object.values(result.undealt_after_observed_deals).reduce((sum, count) => sum + count, 0), 410)
  assert.equal(result.physical_remaining_exact, false)
  assert.equal(result.burn_observation_status, 'unavailable')
  assert.deepEqual(result.identity, { source: 'mt-cloud', table_id: 'BAG01', shoe: 'S100' })
})

test('v102 migration is conflict-safe and service-only while rollback preserves evidence', () => {
  const baseline = readFileSync(new URL('../../frontend/supabase/schema_v100_baseline.sql', import.meta.url), 'utf8')
  const migration = readFileSync(new URL('../../frontend/supabase/schema_v102_latest_only.sql', import.meta.url), 'utf8')
  const rollback = readFileSync(new URL('../../frontend/supabase/rollback_v102_to_v101.sql', import.meta.url), 'utf8')

  assert.match(baseline, /create table public\.shoe_round_card_events/i)
  assert.match(baseline, /unique \(source, table_id, shoe_no, round_no\)/i)
  assert.match(baseline, /create table public\.shoe_rank_ledgers/i)
  assert.match(baseline, /deck_count integer[^;]+default 8/i)
  assert.match(baseline, /status = 'conflicted'/i)
  assert.match(baseline, /conflicting_round_identity/i)
  assert.match(baseline, /reject_v100_rank_event_evidence_mutation/i)
  assert.match(baseline, /grant select on table public\.shoe_round_card_events to service_role/i)
  assert.doesNotMatch(baseline, /grant[^;]*insert[^;]*shoe_round_card_events[^;]*service_role/i)
  assert.doesNotMatch(baseline, /grant[^;]*update[^;]*shoe_round_card_events[^;]*service_role/i)

  assert.match(migration, /create or replace function public\.apply_v102_rank_ledger_event/i)
  assert.match(migration, /pg_advisory_xact_lock/i)
  assert.match(migration, /extensions\.digest/i)
  assert.doesNotMatch(migration, /p_ledger\s*->/i)
  assert.match(migration, /values \(v_source, v_table, v_shoe, v_round, v_raw, v_delta, v_action, v_hash, false\)/i)
  assert.doesNotMatch(migration, /v_raw, '\{\}'::jsonb, v_action, v_hash, false/i)
  assert.match(migration, /revoke all on function public\.apply_v102_rank_ledger_event/i)
  assert.match(migration, /grant execute on function public\.apply_v102_rank_ledger_event\(jsonb, jsonb\) to service_role/i)
  assert.match(migration, /position between 1 and 4[^\n]*not between 1 and 52/i)
  assert.doesNotMatch(migration, /set\s+raw_result_exact10\s*=/i)

  assert.match(rollback, /status\s*=\s*'archived'/i)
  assert.match(rollback, /version\s*=\s*'v101'/i)
  assert.doesNotMatch(rollback, /drop\s+(table|function)/i)
})
