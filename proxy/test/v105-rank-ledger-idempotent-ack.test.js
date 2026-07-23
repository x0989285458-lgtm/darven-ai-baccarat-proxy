import test from 'node:test'
import assert from 'node:assert/strict'
import { createSupabaseIngestionClient } from '../src/supabase-writer.js'

const faces = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']
const seen = Object.fromEntries(faces.map((face) => [face, 0]))
const undealt = Object.fromEntries(faces.map((face) => [face, 32]))
const codes = Object.fromEntries(Array.from({ length: 52 }, (_, index) => [String(index + 1), 0]))

function response(payload) {
  return { ok: true, status: 200, text: async () => JSON.stringify(payload) }
}

function acknowledgement(completeThroughRound) {
  return {
    accepted: true,
    status: 'contiguous',
    complete_through_round: completeThroughRound,
    seen_dealt_rank_counts: seen,
    seen_dealt_code_counts: codes,
    undealt_after_observed_deals: undealt,
    cards_seen_dealt: 0,
    physical_remaining_exact: false,
    burn_observation_status: 'unavailable',
    ledger_checksum: '0'.repeat(64),
    revision: completeThroughRound,
  }
}

const duplicateRound = {
  source: 'ofalive99',
  tableId: 'BAG03A',
  shoe: '15915',
  round: 21,
  sourceAction: '/api/v1/gametype/*/game/*/room/*/table/*/summary',
  rawResult: [1, 2, 14, 15, -1, -1, -1, -1, 3, 5],
}

test('accepts an idempotent older Final when durable ACK has already advanced beyond that round', async () => {
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co',
    serviceKey: 'test-only',
    requireVerifiedStrategy: false,
    fetchImpl: async () => response(acknowledgement(22)),
  })
  const ledger = await client.applyV100RankLedgerEvent(duplicateRound)
  assert.equal(ledger.completeThroughRound, 22)
  assert.equal(ledger.status, 'contiguous')
})
