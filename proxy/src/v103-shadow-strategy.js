import { isVerifiedFinalRoundAction } from '../../shared/real-card-validator.js'
import { buildLivePrediction, deriveBaccaratRoundFacts } from './supabase-writer.js'

export const V103_SHADOW_STRATEGY_VERSION = 'v103'
export const V103_SHADOW_RELEASE_CANDIDATE = 'v103.0.0-shadow.1'
export const V103_SHADOW_MAIN_WEIGHTS = Object.freeze({
  roadmap_trend_signals: 0.05,
  ask_road_signals: 0.05,
  recent_practical_calibration: 0.45,
  shoe_banker_player_bias: 0.35,
  neutral_reserve: 0.10,
})

const DIRECTIONAL_MINIMUM_SAMPLES = 20

export function buildV103ShadowHistory(rows = [], { tableId = null, windowSize = 60 } = {}) {
  const eligibleRows = rows.filter((row) => {
    const strategy = row?.strategy_version ?? row?.strategyVersion
    const timing = row?.prediction_timing ?? row?.predictionTiming
    const issuedAt = row?.prediction_issued_at ?? row?.predictionIssuedAt
    const final = row?.settlement_final ?? row?.settlementFinal
    const rowTableId = row?.table_id ?? row?.tableId
    return strategy === V103_SHADOW_STRATEGY_VERSION
      && timing === 'pre_result_context'
      && Boolean(issuedAt)
      && final === true
      && (tableId == null || String(rowTableId ?? '') === String(tableId))
  }).sort((left, right) => {
    const leftTime = Date.parse(left?.resolved_at ?? left?.resolvedAt ?? left?.prediction_issued_at ?? left?.predictionIssuedAt ?? '') || 0
    const rightTime = Date.parse(right?.resolved_at ?? right?.resolvedAt ?? right?.prediction_issued_at ?? right?.predictionIssuedAt ?? '') || 0
    return leftTime - rightTime
  }).slice(-Math.max(1, Number(windowSize) || 60))
  const totals = {
    banker: { settledPredictionCount: 0, hits: 0 },
    player: { settledPredictionCount: 0, hits: 0 },
  }
  for (const row of eligibleRows) {
    const direction = String(row?.predicted_result ?? row?.predictedResult ?? '').toLowerCase()
    const actual = String(row?.actual_result ?? row?.actualResult ?? '').toLowerCase()
    if (!['banker', 'player'].includes(direction) || !['banker', 'player'].includes(actual)) continue
    totals[direction].settledPredictionCount += 1
    if (direction === actual) totals[direction].hits += 1
  }
  return Object.fromEntries(Object.entries(totals).map(([direction, value]) => [direction, {
    settledPredictionCount: value.settledPredictionCount,
    hitRate: value.settledPredictionCount ? value.hits / value.settledPredictionCount : null,
  }]))
}

export function buildV103ShadowPrediction(table = {}, historyRows = []) {
  const directionalHistory = buildV103ShadowHistory(historyRows, { tableId: table.tableId, windowSize: 60 })
  const scoringTable = {
    ...structuredClone(table),
    settledDirectionalPredictionStats: directionalHistory,
  }
  const sourcePrediction = buildLivePrediction(scoringTable)
  const scoreSources = structuredClone(sourcePrediction.scoreSources)
  const scoreTotals = Object.entries(V103_SHADOW_MAIN_WEIGHTS).reduce((totals, [key, weight]) => {
    const score = scoreSources[key] ?? { banker: 0.5, player: 0.5 }
    totals.banker += Number(score.banker ?? 0.5) * weight
    totals.player += Number(score.player ?? 0.5) * weight
    return totals
  }, { banker: 0, player: 0 })
  const gap = scoreTotals.banker - scoreTotals.player
  const predictedResult = Math.abs(gap) < 1e-12
    ? deterministicDirection(table)
    : gap > 0 ? 'banker' : 'player'
  const directional = directionalHistory[predictedResult]
  const enoughHistory = directional.settledPredictionCount >= DIRECTIONAL_MINIMUM_SAMPLES

  return {
    source: 'ofalive99',
    strategyVersion: V103_SHADOW_STRATEGY_VERSION,
    releaseCandidate: V103_SHADOW_RELEASE_CANDIDATE,
    shadowOnly: true,
    activationEligible: false,
    memberVisible: false,
    writesSideActions: false,
    predictionTiming: 'pre_result_context',
    targetTableId: String(table.tableId ?? ''),
    targetShoe: table.shoe == null ? null : String(table.shoe),
    targetRound: Number(table.round ?? 0) + 1,
    predictedResult,
    confidence: Math.max(30, Math.min(70, Math.round(30 + Math.abs(gap) * 100))),
    scoreSources,
    scoreTotals,
    featureWeights: { ...V103_SHADOW_MAIN_WEIGHTS },
    calibration: {
      source: 'v103_shadow_final_only',
      direction: predictedResult,
      sampleCount: directional.settledPredictionCount,
      hitRate: directional.hitRate,
      minimumSamples: DIRECTIONAL_MINIMUM_SAMPLES,
      mode: enoughHistory ? 'v103_shadow_final_history' : 'neutral_shrinkage',
    },
  }
}

export function buildV103ShadowSettlement(round = {}, issued = {}) {
  if (!isVerifiedFinalRoundAction(round?.sourceAction)) {
    throw new Error('v103 shadow settlement requires verified Final summary/show_win')
  }
  const facts = deriveBaccaratRoundFacts(round)
  const actualResult = String(facts.winner ?? round.winner ?? '').toLowerCase()
  if (!['banker', 'player', 'tie'].includes(actualResult)) throw new Error('v103 shadow settlement result is invalid')
  const sameIdentity = String(round.tableId ?? '') === String(issued.targetTableId ?? '')
    && String(round.shoe ?? '') === String(issued.targetShoe ?? '')
    && Number(round.round) === Number(issued.targetRound)
    && issued.strategyVersion === V103_SHADOW_STRATEGY_VERSION
    && Boolean(issued.predictionId)
    && Boolean(issued.issuedAt)
  if (!sameIdentity) throw new Error('v103 shadow settlement identity mismatch')
  const settlementStatus = actualResult === 'tie' ? 'push' : actualResult === issued.predictedResult ? 'hit' : 'miss'
  return {
    source: issued.source ?? 'ofalive99',
    tableId: issued.targetTableId,
    shoe: issued.targetShoe,
    round: issued.targetRound,
    strategyVersion: V103_SHADOW_STRATEGY_VERSION,
    predictionId: issued.predictionId,
    predictedResult: issued.predictedResult,
    actualResult,
    isHit: settlementStatus === 'push' ? null : settlementStatus === 'hit',
    settlementStatus,
    settlementFinal: true,
    settlementSourceAction: round.sourceAction,
    resolvedAt: new Date().toISOString(),
  }
}

function deterministicDirection(table = {}) {
  const identity = `${table.tableId ?? ''}:${table.shoe ?? ''}:${Number(table.round ?? 0) + 1}`
  let hash = 0
  for (const character of identity) hash = ((hash * 31) + character.charCodeAt(0)) >>> 0
  return hash % 2 === 0 ? 'banker' : 'player'
}
