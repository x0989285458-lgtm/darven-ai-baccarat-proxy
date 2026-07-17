import { createRankLedger } from './rank-ledger.js'
import { SIDE_PREDICTION_ACTION_RATE_TARGETS, SIDE_PREDICTION_THRESHOLDS } from './supabase-writer.js'

export function reconstructV100BacktestTable(row = {}) {
  const features = row.prediction_features ?? {}
  const mt = features.mt_context ?? {}
  const roads = features.road_features ?? {}
  const performance = features.table_performance ?? {}
  return {
    ...structuredClone(mt),
    ...structuredClone(roads),
    tableId: String(mt.tableId ?? row.table_id ?? ''),
    shoe: mt.shoe ?? row.shoe_no ?? null,
    round: Number(mt.round ?? Number(row.round_no) - 1),
    recentHitRate: performance.recentHitRate ?? performance.recent_hit_rate ?? null,
    recentPredictionCount: performance.recentPredictionCount ?? performance.recent_prediction_count ?? null,
  }
}

export function buildStrictTemporalRankState(prediction = {}, events = []) {
  const targetRound = Number(prediction.round_no)
  const cutoffMs = Date.parse(prediction.created_at)
  if (!Number.isSafeInteger(targetRound) || targetRound < 2 || !Number.isFinite(cutoffMs)) return null
  const identityEvents = events.filter((event) => String(event.source ?? '') === String(prediction.source ?? '')
    && String(event.table_id ?? '') === String(prediction.table_id ?? '')
    && String(event.shoe_no ?? '') === String(prediction.shoe_no ?? '')
    && Number(event.round_no) >= 1 && Number(event.round_no) < targetRound
    && Date.parse(event.received_at) <= cutoffMs)
  const byRound = new Map()
  for (const event of identityEvents) {
    const round = Number(event.round_no)
    const raw = JSON.stringify(event.raw_event ?? {})
    const existing = byRound.get(round)
    if (existing && JSON.stringify(existing.raw_event ?? {}) !== raw) return null
    byRound.set(round, event)
  }
  if (byRound.size !== targetRound - 1) return null
  for (let round = 1; round < targetRound; round += 1) if (!byRound.has(round)) return null

  const ledger = createRankLedger()
  let state = null
  for (let round = 1; round < targetRound; round += 1) {
    const row = byRound.get(round)
    const rawEvent = row.raw_event ?? {}
    state = ledger.recordFinal({
      ...rawEvent,
      source: row.source,
      tableId: row.table_id,
      shoe: row.shoe_no,
      round,
      sourceAction: rawEvent.sourceAction,
      rawResult: rawEvent.rawResult,
    })
    if (state.status !== 'contiguous' || state.complete_through_round !== round) return null
  }
  return {
    identity: state.identity,
    status: 'contiguous',
    completeThroughRound: state.complete_through_round,
    complete_through_round: state.complete_through_round,
    targetRound,
    rankDataAvailable: true,
    remainingRankCounts: structuredClone(state.undealt_after_observed_deals),
    seen_dealt_rank_counts: structuredClone(state.seen_dealt_rank_counts),
    cardsSeenTotal: state.cards_seen_dealt,
    cards_seen_dealt: state.cards_seen_dealt,
    physicalRemainingExact: false,
    burnObservationStatus: 'unavailable',
  }
}

function topCut(values, desiredCount) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => b - a)
  if (sorted.length === 0) return 100
  const index = Math.min(sorted.length - 1, Math.max(0, desiredCount - 1))
  return sorted[index]
}

export function deriveTrainOnlyCalibrationOffsets(trainRows = [], _holdoutIgnored = []) {
  const count = trainRows.length
  const desired = (key) => Math.max(1, Math.round(count * SIDE_PREDICTION_ACTION_RATE_TARGETS[key]))
  const cuts = {
    tie: topCut(trainRows.map((row) => Number(row.raw?.tie)), desired('tie')),
    superSix: topCut(trainRows.filter((row) => row.main === 'banker').map((row) => Number(row.raw?.superSix)), desired('superSix')),
    bankerPair: topCut(trainRows.map((row) => Number(row.raw?.bankerPair)), desired('bankerPair')),
    playerPair: topCut(trainRows.map((row) => Number(row.raw?.playerPair)), desired('playerPair')),
  }
  return {
    tie: SIDE_PREDICTION_THRESHOLDS.tie - cuts.tie,
    superSix: SIDE_PREDICTION_THRESHOLDS.superSix - cuts.superSix,
    bankerPair: SIDE_PREDICTION_THRESHOLDS.bankerPair - cuts.bankerPair,
    playerPair: SIDE_PREDICTION_THRESHOLDS.playerPair - cuts.playerPair,
    bankerDragon: 0,
    playerDragon: 0,
  }
}
