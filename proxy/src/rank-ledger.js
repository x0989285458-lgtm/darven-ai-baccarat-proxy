import { createHash } from 'node:crypto'
import { isExactTenRawResult, isVerifiedFinalRoundAction } from '../../shared/real-card-validator.js'

export const EIGHT_DECK_CARD_COUNT = 416
export const RANKS = Object.freeze(['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'])

export function createRankLedger({ rehydratedShoes = [] } = {}) {
  const shoes = new Map(rehydratedShoes.map((serialized) => {
    const state = deserializeShoeState(serialized)
    return [identityKey(state.identity), state]
  }))

  return {
    recordFinal(event = {}) {
      if (!isVerifiedFinalRoundAction(event.sourceAction) || !isExactTenRawResult(event.rawResult)) {
        return { disposition: 'rejected', status: 'unavailable' }
      }
      const identity = normalizeIdentity(event)
      if (!identity.source || !identity.table_id || !identity.shoe) {
        return { disposition: 'rejected', status: 'unavailable' }
      }
      const key = identityKey(identity)
      const state = shoes.get(key) ?? createShoeState(identity)
      shoes.set(key, state)
      if (state.status === 'conflicted' || state.status === 'invalid') {
        return publicState(state, state.status)
      }
      const round = Number(event.round)
      if (!Number.isInteger(round) || round < 1) return { disposition: 'rejected', status: 'unavailable' }
      const eventHash = hashEvent(event)
      const existing = state.events.get(round)
      if (existing && existing.hash !== eventHash) {
        state.status = 'conflicted'
        return publicState(state, 'conflicted')
      }
      if (existing?.applied) return publicState(state, 'duplicate')
      if (!existing) state.events.set(round, { hash: eventHash, applied: false })
      if (round !== state.completeThrough + 1) {
        if (state.status !== 'conflicted') state.status = 'gap'
        return publicState(state, 'gap')
      }
      const cards = event.rawResult.slice(0, 6).filter((code) => Number.isInteger(code) && code >= 1 && code <= 52)
      const invalidReason = physicalLimitViolation(state, cards)
      if (invalidReason) {
        state.status = 'invalid'
        state.invalidReason = invalidReason
        return publicState(state, 'invalid')
      }
      for (const code of cards) {
        const rank = RANKS[(code - 1) % 13]
        state.seen[rank] += 1
        state.codeCounts[code] += 1
      }
      state.cardsSeen += cards.length
      state.completeThrough = round
      state.events.get(round).applied = true
      if (state.status !== 'conflicted') state.status = 'contiguous'
      return publicState(state, 'accepted')
    },
    getState(source, tableId, shoe) {
      const state = shoes.get(identityKey({ source: String(source ?? ''), table_id: String(tableId ?? ''), shoe: String(shoe ?? '') }))
      return state ? publicState(state) : null
    },
    snapshot() {
      const payload = {
        schema_version: 1,
        deck_count: 8,
        shoes: [...shoes.values()].map(serializeShoeState).sort((a, b) => identityKey(a.identity).localeCompare(identityKey(b.identity))),
      }
      return { ...payload, checksum: stableChecksum(payload) }
    },
  }
}

export function checksumRankLedgerSnapshot(snapshot = {}) {
  const { checksum: _ignored, ...payload } = snapshot
  return stableChecksum(payload)
}

export function rehydrateRankLedger(snapshot = {}) {
  if (snapshot.schema_version !== 1 || snapshot.deck_count !== 8 || !Array.isArray(snapshot.shoes)) {
    throw new Error('invalid rank ledger snapshot')
  }
  if (snapshot.checksum !== checksumRankLedgerSnapshot(snapshot)) throw new Error('rank ledger snapshot checksum mismatch')
  return createRankLedger({ rehydratedShoes: snapshot.shoes })
}

function normalizeIdentity(event) {
  return {
    source: String(event.source ?? ''),
    table_id: String(event.tableId ?? event.table_id ?? ''),
    shoe: String(event.shoe ?? ''),
  }
}

function identityKey(identity) {
  return JSON.stringify([identity.source, identity.table_id, identity.shoe])
}

function createShoeState(identity) {
  return {
    identity,
    seen: Object.fromEntries(RANKS.map((rank) => [rank, 0])),
    codeCounts: Object.fromEntries(Array.from({ length: 52 }, (_, index) => [index + 1, 0])),
    cardsSeen: 0,
    completeThrough: 0,
    status: 'contiguous',
    events: new Map(),
  }
}

function serializeShoeState(state) {
  return {
    identity: { ...state.identity },
    seen: { ...state.seen },
    code_counts: { ...state.codeCounts },
    cards_seen: state.cardsSeen,
    complete_through: state.completeThrough,
    status: state.status,
    invalid_reason: state.invalidReason ?? null,
    events: [...state.events.entries()].sort((a, b) => a[0] - b[0]).map(([round, event]) => ({ round, hash: event.hash, applied: event.applied })),
  }
}

function deserializeShoeState(serialized = {}) {
  const state = {
    identity: { ...serialized.identity },
    seen: { ...serialized.seen },
    codeCounts: { ...serialized.code_counts },
    cardsSeen: serialized.cards_seen,
    completeThrough: serialized.complete_through,
    status: serialized.status,
    invalidReason: serialized.invalid_reason ?? null,
    events: new Map((serialized.events ?? []).map((event) => [event.round, { hash: event.hash, applied: event.applied }])),
  }
  if (!state.identity.source || !state.identity.table_id || !state.identity.shoe
    || !RANKS.every((rank) => Number.isInteger(state.seen[rank]) && state.seen[rank] >= 0 && state.seen[rank] <= 32)
    || !Array.from({ length: 52 }, (_, index) => index + 1).every((code) => Number.isInteger(state.codeCounts[code]) && state.codeCounts[code] >= 0 && state.codeCounts[code] <= 8)
    || !Number.isInteger(state.cardsSeen) || state.cardsSeen < 0 || state.cardsSeen > EIGHT_DECK_CARD_COUNT
    || Object.values(state.seen).reduce((sum, count) => sum + count, 0) !== state.cardsSeen) {
    throw new Error('invalid rank ledger snapshot state')
  }
  return state
}

function publicState(state, disposition = null) {
  const undealt = Object.fromEntries(RANKS.map((rank) => [rank, 32 - state.seen[rank]]))
  return {
    ...(disposition ? { disposition } : {}),
    identity: { ...state.identity },
    deck_count: 8,
    initial_cards: EIGHT_DECK_CARD_COUNT,
    undealt_after_observed_deals: undealt,
    seen_dealt_rank_counts: { ...state.seen },
    cards_seen_dealt: state.cardsSeen,
    complete_through_round: state.completeThrough,
    status: state.status,
    ...(state.invalidReason ? { invalid_reason: state.invalidReason } : {}),
    physical_remaining_exact: false,
    burn_observation_status: 'unavailable',
  }
}

function physicalLimitViolation(state, cards) {
  if (state.cardsSeen + cards.length > EIGHT_DECK_CARD_COUNT) return 'total_card_limit_exceeded'
  const codeAdds = new Map()
  const rankAdds = new Map()
  for (const code of cards) {
    codeAdds.set(code, (codeAdds.get(code) ?? 0) + 1)
    const rank = RANKS[(code - 1) % 13]
    rankAdds.set(rank, (rankAdds.get(rank) ?? 0) + 1)
  }
  for (const [code, count] of codeAdds) {
    if (state.codeCounts[code] + count > 8) return `card_code_limit_exceeded:${code}`
  }
  for (const [rank, count] of rankAdds) {
    if (state.seen[rank] + count > 32) return `rank_limit_exceeded:${rank}`
  }
  return null
}

function hashEvent(event) {
  return stableChecksum({
    sourceAction: event.sourceAction,
    rawResult: event.rawResult,
    winner: event.winner ?? null,
    playerPoint: event.playerPoint ?? null,
    bankerPoint: event.bankerPoint ?? null,
  })
}

function stableChecksum(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
