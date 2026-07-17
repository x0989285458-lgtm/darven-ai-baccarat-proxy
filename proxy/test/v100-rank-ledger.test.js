import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRankLedger, rehydrateRankLedger, checksumRankLedgerSnapshot } from '../src/rank-ledger.js'
import { createProxyState } from '../src/state-store.js'

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

  restarted.recordFinal(finalRound({ round: 2, rawResult: [3, 4, 16, 17, -1, -1, -1, -1, 6, 8] }))
  const completed = restarted.recordFinal(round3)
  assert.equal(completed.disposition, 'accepted')
  assert.equal(completed.complete_through_round, 3)
  assert.throws(() => rehydrateRankLedger({ ...snapshot, checksum: 'tampered' }), /checksum/i)
})

test('state store mounts trusted ledger on table and gates next-round rank data on exact continuity', () => {
  const state = createProxyState({ inferSnapshotRounds: false })
  state.setTables([{ tableId: 'BAG01', shoe: 'S100', round: 0 }])
  state.upsertRoundEvent(finalRound())
  let table = state.snapshot().tables[0]

  assert.equal(table.cardShoe.status, 'contiguous')
  assert.equal(table.cardShoe.complete_through_round, 1)
  assert.equal(table.cardShoe.rankDataAvailable, true)
  assert.equal(table.cardShoe.targetRound, 2)
  assert.equal(table.lastRound.cardShoe.cardsSeenTotal, 6, 'legacy v98 lastRound cardShoe remains compatible')

  state.upsertRoundEvent(finalRound({ round: 3, rawResult: [5, 6, 18, 19, -1, -1, -1, -1, 0, 2] }))
  table = state.snapshot().tables[0]
  assert.equal(table.cardShoe.status, 'gap')
  assert.equal(table.cardShoe.rankDataAvailable, false)
})

test('state store switches to a new shoe at round one and delayed old-shoe Final cannot pollute active cardShoe', () => {
  const state = createProxyState({ inferSnapshotRounds: false })
  state.setTables([{ tableId: 'BAG01', shoe: 'S100', round: 0 }])
  state.upsertRoundEvent(finalRound())
  state.upsertRoundEvent(finalRound({ shoe: 'S101', round: 1, rawResult: [3, 4, 16, 17, -1, -1, -1, -1, 6, 8] }))
  const activeBeforeDelay = state.snapshot().tables[0]
  assert.equal(activeBeforeDelay.shoe, 'S101')
  assert.equal(activeBeforeDelay.cardShoe.identity.shoe, 'S101')

  state.upsertRoundEvent(finalRound({ shoe: 'S100', round: 2, rawResult: [5, 6, 18, 19, -1, -1, -1, -1, 0, 2] }))
  const activeAfterDelay = state.snapshot().tables[0]
  assert.equal(activeAfterDelay.shoe, 'S101')
  assert.equal(activeAfterDelay.cardShoe.identity.shoe, 'S101')
  assert.equal(activeAfterDelay.cardShoe.cards_seen_dealt, 4)
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

test('v100 SQL contract is additive, conflict-safe, service-only, and rollback preserves evidence', () => {
  const schema = readFileSync(new URL('../../frontend/supabase/schema_v100_rank_ledger.sql', import.meta.url), 'utf8')
  const rollback = readFileSync(new URL('../../frontend/supabase/rollback_v100_rank_ledger.sql', import.meta.url), 'utf8')

  assert.match(schema, /create table if not exists public\.shoe_round_card_events/i)
  assert.match(schema, /unique \(source, table_id, shoe_no, round_no\)/i)
  assert.match(schema, /create table if not exists public\.shoe_rank_ledgers/i)
  assert.match(schema, /deck_count = 8/i)
  assert.match(schema, /status = 'conflicted'/i)
  assert.match(schema, /conflicting_round_identity/i)
  assert.match(schema, /shoe_round_card_events\.event_hash = excluded\.event_hash/i)
  assert.match(schema, /enable row level security/i)
  assert.match(schema, /revoke all on function public\.apply_v100_rank_ledger_event/i)
  assert.match(schema, /grant execute on function public\.apply_v100_rank_ledger_event\(jsonb, jsonb\) to service_role/i)
  assert.doesNotMatch(schema, /set\s+raw_result_exact10\s*=/i)
  assert.match(rollback, /revoke execute on function public\.apply_v100_rank_ledger_event/i)
  assert.doesNotMatch(rollback, /drop\s+(table|function)/i)
})
