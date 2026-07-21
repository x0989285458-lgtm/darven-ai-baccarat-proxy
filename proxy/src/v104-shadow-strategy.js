import { isVerifiedFinalRoundAction } from '../../shared/real-card-validator.js'
import { buildLivePrediction, deriveBaccaratRoundFacts } from './supabase-writer.js'
import { V104_DIRECTION_WEIGHTS, V104_SHOE_BIAS } from './v104-main-contract.js'

export const V104_SHADOW_STRATEGY_VERSION = 'v104'
export const V104_SHADOW_RELEASE_CANDIDATE = 'v104.0.0-shadow.1'
export const V104_SHADOW_DIRECTION_WEIGHTS = V104_DIRECTION_WEIGHTS
export const V104_SHADOW_SHOE_BIAS = V104_SHOE_BIAS

const CALIBRATION_MINIMUM_SAMPLES = 20

export function buildV104ShadowHistory(rows = [], { tableId = null, windowSize = 60 } = {}) {
  const eligible = rows.filter((row) => {
    const strategy = row?.strategy_version ?? row?.strategyVersion
    const timing = row?.prediction_timing ?? row?.predictionTiming
    const issuedAt = row?.prediction_issued_at ?? row?.predictionIssuedAt
    const final = row?.settlement_final ?? row?.settlementFinal
    const rowTableId = row?.table_id ?? row?.tableId
    return strategy === V104_SHADOW_STRATEGY_VERSION
      && timing === 'pre_result_context'
      && Boolean(issuedAt)
      && final === true
      && (tableId == null || String(rowTableId ?? '') === String(tableId))
  }).sort((left, right) => rowTime(left) - rowTime(right))
    .slice(-Math.max(1, Number(windowSize) || 60))
  const totals = {
    banker: { settledPredictionCount: 0, hits: 0 },
    player: { settledPredictionCount: 0, hits: 0 },
  }
  for (const row of eligible) {
    const direction = normalizeDirection(row?.predicted_result ?? row?.predictedResult)
    const actual = normalizeDirection(row?.actual_result ?? row?.actualResult)
    if (!direction || !actual) continue
    totals[direction].settledPredictionCount += 1
    if (direction === actual) totals[direction].hits += 1
  }
  return Object.fromEntries(Object.entries(totals).map(([direction, value]) => [direction, {
    settledPredictionCount: value.settledPredictionCount,
    hitRate: value.settledPredictionCount ? value.hits / value.settledPredictionCount : null,
  }]))
}

export function buildV104ShoeBias(table = {}) {
  const banker = nonNegativeCount(table.bankerCount)
  const player = nonNegativeCount(table.playerCount)
  const sampleCount = banker + player
  const rawBankerRate = sampleCount ? banker / sampleCount : 0.5
  const priorHalf = V104_SHADOW_SHOE_BIAS.priorSampleSize / 2
  const posteriorBankerRate = sampleCount
    ? (banker + priorHalf) / (sampleCount + V104_SHADOW_SHOE_BIAS.priorSampleSize)
    : 0.5
  const bankerRate = Math.max(0.5 - V104_SHADOW_SHOE_BIAS.maximumEdge, Math.min(0.5 + V104_SHADOW_SHOE_BIAS.maximumEdge, posteriorBankerRate))
  return {
    banker: rounded(bankerRate),
    player: rounded(1 - bankerRate),
    sampleCount,
    rawBankerRate: rounded(rawBankerRate),
    posteriorBankerRate: rounded(posteriorBankerRate),
    capped: Math.abs(posteriorBankerRate - 0.5) > V104_SHADOW_SHOE_BIAS.maximumEdge,
  }
}

export function calculateV104Direction({ tableIdentity = '', scoreSources = {}, priorDirection = null, priorSameSideStreak = 0 } = {}) {
  const normalizedSources = {
    roadmap_trend_signals: normalizeScore(scoreSources.roadmap_trend_signals),
    ask_road_signals: normalizeScore(scoreSources.ask_road_signals),
    shoe_banker_player_bias: normalizeScore(scoreSources.shoe_banker_player_bias),
    neutral_reserve: normalizeScore(scoreSources.neutral_reserve),
  }
  const raw = totalDirection(normalizedSources)
  const rawDirection = pickDirection(raw, tableIdentity)
  const normalizedPriorDirection = normalizeDirection(priorDirection)
  const priorStreak = Math.max(0, Math.floor(Number(priorSameSideStreak) || 0))
  const continuingStreak = rawDirection === normalizedPriorDirection ? priorStreak + 1 : 1
  const independentSupportCount = ['roadmap_trend_signals', 'ask_road_signals']
    .filter((key) => supportsDirection(normalizedSources[key], rawDirection)).length
  const lockRisk = continuingStreak >= 5 && independentSupportCount < 2
  const appliedScoreSources = structuredClone(normalizedSources)
  let askRoadSuppressed = false
  if (lockRisk) {
    appliedScoreSources.shoe_banker_player_bias = neutralScore()
    const roadmapDirection = scoreDirection(normalizedSources.roadmap_trend_signals)
    const askRoadDirection = scoreDirection(normalizedSources.ask_road_signals)
    if (roadmapDirection && askRoadDirection && roadmapDirection !== askRoadDirection) {
      appliedScoreSources.ask_road_signals = neutralScore()
      askRoadSuppressed = true
    }
  }
  const scoreTotals = totalDirection(appliedScoreSources)
  const predictedResult = pickDirection(scoreTotals, tableIdentity)
  const sameSideStreak = predictedResult === normalizedPriorDirection ? priorStreak + 1 : 1
  return {
    predictedResult,
    sameSideStreak,
    independentSupportCount,
    shoeBiasSuppressed: lockRisk,
    askRoadSuppressed,
    lockRisk,
    rawPredictedResult: rawDirection,
    rawScoreTotals: raw,
    scoreTotals,
    appliedScoreSources,
  }
}

export function buildV104ShadowPrediction(table = {}, historyRows = [], issuanceContext = {}) {
  const directionalHistory = buildV104ShadowHistory(historyRows, { tableId: table.tableId, windowSize: 60 })
  const source = buildLivePrediction({
    ...structuredClone(table),
    settledDirectionalPredictionStats: directionalHistory,
  })
  const shoe = buildV104ShoeBias(table)
  const scoreSources = {
    ...structuredClone(source.scoreSources),
    shoe_banker_player_bias: { banker: shoe.banker, player: shoe.player },
    neutral_reserve: neutralScore(),
  }
  const currentShoe = table.shoe == null ? null : String(table.shoe)
  const contextShoe = issuanceContext.priorShoe == null ? currentShoe : String(issuanceContext.priorShoe)
  const sameShoe = contextShoe === currentShoe
  const direction = calculateV104Direction({
    tableIdentity: `${table.tableId ?? ''}:${currentShoe ?? ''}:${Number(table.round ?? 0) + 1}`,
    scoreSources,
    priorDirection: sameShoe ? issuanceContext.priorDirection : null,
    priorSameSideStreak: sameShoe ? issuanceContext.priorSameSideStreak : 0,
  })
  const calibration = directionalHistory[direction.predictedResult]
  const rawConfidence = Math.max(30, Math.min(70, Math.round(30 + Math.abs(direction.scoreTotals.banker - direction.scoreTotals.player) * 100)))
  const confidence = calibrateConfidence(rawConfidence, calibration)
  return {
    source: 'ofalive99',
    strategyVersion: V104_SHADOW_STRATEGY_VERSION,
    releaseCandidate: V104_SHADOW_RELEASE_CANDIDATE,
    shadowOnly: true,
    activationEligible: false,
    memberVisible: false,
    writesSideActions: false,
    predictionTiming: 'pre_result_context',
    targetTableId: String(table.tableId ?? ''),
    targetShoe: currentShoe,
    targetRound: Number(table.round ?? 0) + 1,
    predictedResult: direction.predictedResult,
    confidence,
    scoreSources: { ...scoreSources, ...direction.appliedScoreSources },
    scoreTotals: direction.scoreTotals,
    featureWeights: { ...V104_SHADOW_DIRECTION_WEIGHTS },
    sameSideStreak: direction.sameSideStreak,
    independentSupportCount: direction.independentSupportCount,
    shoeBiasSuppressed: direction.shoeBiasSuppressed,
    askRoadSuppressed: direction.askRoadSuppressed,
    lockRisk: direction.lockRisk,
    diagnostics: {
      direction: {
        rawPredictedResult: direction.rawPredictedResult,
        rawScoreTotals: direction.rawScoreTotals,
        finalScoreTotals: direction.scoreTotals,
        askRoadSuppressed: direction.askRoadSuppressed,
        lockGuardPrimarySource: direction.askRoadSuppressed ? 'roadmap_trend_signals' : null,
      },
      calibration: {
        directionContribution: 0,
        source: 'v104_shadow_final_only',
        sampleCount: calibration.settledPredictionCount,
        hitRate: calibration.hitRate,
        minimumSamples: CALIBRATION_MINIMUM_SAMPLES,
        mode: calibration.settledPredictionCount >= CALIBRATION_MINIMUM_SAMPLES ? 'confidence_only_final_history' : 'neutral_shrinkage',
        rawConfidence,
        finalConfidence: confidence,
      },
      shoeBias: { ...shoe, ...V104_SHADOW_SHOE_BIAS },
    },
  }
}

export function buildV104ShadowSettlement(round = {}, issued = {}) {
  if (!isVerifiedFinalRoundAction(round?.sourceAction)) throw new Error('v104 shadow settlement requires verified Final summary/show_win')
  const facts = deriveBaccaratRoundFacts(round)
  const actualResult = String(facts.winner ?? round.winner ?? '').toLowerCase()
  if (!['banker', 'player', 'tie'].includes(actualResult)) throw new Error('v104 shadow settlement result is invalid')
  const sameIdentity = String(round.tableId ?? '') === String(issued.targetTableId ?? '')
    && String(round.shoe ?? '') === String(issued.targetShoe ?? '')
    && Number(round.round) === Number(issued.targetRound)
    && issued.strategyVersion === V104_SHADOW_STRATEGY_VERSION
    && Boolean(issued.predictionId)
    && Boolean(issued.issuedAt)
  if (!sameIdentity) throw new Error('v104 shadow settlement identity mismatch')
  const settlementStatus = actualResult === 'tie' ? 'push' : actualResult === issued.predictedResult ? 'hit' : 'miss'
  return {
    source: issued.source ?? 'ofalive99', tableId: issued.targetTableId, shoe: issued.targetShoe,
    round: issued.targetRound, strategyVersion: V104_SHADOW_STRATEGY_VERSION,
    predictionId: issued.predictionId, predictedResult: issued.predictedResult, actualResult,
    isHit: settlementStatus === 'push' ? null : settlementStatus === 'hit',
    settlementStatus, settlementFinal: true, settlementSourceAction: round.sourceAction,
    resolvedAt: new Date().toISOString(),
  }
}

function totalDirection(scoreSources) {
  return Object.entries(V104_SHADOW_DIRECTION_WEIGHTS).reduce((total, [key, weight]) => {
    const score = normalizeScore(scoreSources[key])
    total.banker += score.banker * weight
    total.player += score.player * weight
    return total
  }, { banker: 0, player: 0 })
}

function pickDirection(total, identity) {
  const gap = total.banker - total.player
  if (Math.abs(gap) > 1e-12) return gap > 0 ? 'banker' : 'player'
  let hash = 0
  for (const character of String(identity)) hash = ((hash * 31) + character.charCodeAt(0)) >>> 0
  return hash % 2 === 0 ? 'banker' : 'player'
}

function calibrateConfidence(rawConfidence, calibration) {
  const signalAdjustment = (rawConfidence - 50) * 0.2
  if (calibration.settledPredictionCount < CALIBRATION_MINIMUM_SAMPLES || calibration.hitRate == null) {
    return Math.round(Math.max(30, Math.min(70, 50 + signalAdjustment)))
  }
  return Math.round(Math.max(30, Math.min(70, calibration.hitRate * 100 + signalAdjustment)))
}

function scoreDirection(score) {
  const margin = score.banker - score.player
  if (Math.abs(margin) <= 1e-12) return null
  return margin > 0 ? 'banker' : 'player'
}

function supportsDirection(score, direction) {
  return scoreDirection(score) === direction
}

function normalizeScore(score) {
  const banker = Number(score?.banker)
  const player = Number(score?.player)
  return Number.isFinite(banker) && Number.isFinite(player) ? { banker, player } : neutralScore()
}

function normalizeDirection(value) {
  const direction = String(value ?? '').toLowerCase()
  return direction === 'banker' || direction === 'player' ? direction : null
}

function nonNegativeCount(value) {
  const count = Number(value)
  return Number.isFinite(count) ? Math.max(0, count) : 0
}

function rowTime(row) {
  return Date.parse(row?.resolved_at ?? row?.resolvedAt ?? row?.prediction_issued_at ?? row?.predictionIssuedAt ?? '') || 0
}

function rounded(value) {
  return Number(Number(value).toFixed(12))
}

function neutralScore() {
  return { banker: 0.5, player: 0.5 }
}
