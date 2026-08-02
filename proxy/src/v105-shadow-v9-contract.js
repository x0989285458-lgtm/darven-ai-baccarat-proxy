import { buildV105FormalPrediction } from './v105-formal-strategy.js'
import {
  V105_SHADOW_V9_SIGNAL_TABLE_IDS,
  buildV105ShadowV9BaselineSettlement,
  buildV105ShadowV9SignalBaseline,
} from './v105-shadow-v9-signal-baseline.js'

export const V105_SHADOW_V9_VERSION = 'v105-shadow-v9-weighted-v7-v8'
export const V105_SHADOW_V9_RELEASE = V105_SHADOW_V9_VERSION
export const V105_SHADOW_V9_TABLE_IDS = V105_SHADOW_V9_SIGNAL_TABLE_IDS
export const V105_SHADOW_V9_WEIGHTS = Object.freeze({
  v7RoadCycle: 0.35,
  v8AskRoad: 0.35,
  shoeBankerPlayerBias: 0.10,
  recentPracticalCalibration: 0.20,
})

export function buildV105ShadowV9Prediction(table = {}, historyRows = [], issuanceContext = {}) {
  const ownHistory = Array.isArray(historyRows) ? historyRows : []
  const { roadCyclePrediction: v7, runLengthPrediction: v8 } = buildV105ShadowV9SignalBaseline(
    table,
    ownHistory,
    issuanceContext,
  )
  const formal = buildV105FormalPrediction(table, mapHistory(ownHistory, 'v105'), issuanceContext)
  const signals = {
    v7RoadCycle: structuredClone(v7.askRoadSignal),
    v8AskRoad: structuredClone(v8.askRoadSignal),
    recentPracticalCalibration: structuredClone(formal.scoreSources.recent_practical_calibration),
    shoeBankerPlayerBias: structuredClone(formal.scoreSources.shoe_banker_player_bias),
  }
  const scoreSources = {
    v7RoadCycle: directionScore(v7.predictedResult),
    v8AskRoad: directionScore(v8.predictedResult),
    recentPracticalCalibration: structuredClone(signals.recentPracticalCalibration),
    shoeBankerPlayerBias: structuredClone(signals.shoeBankerPlayerBias),
  }
  const scoreTotals = Object.entries(V105_SHADOW_V9_WEIGHTS).reduce((totals, [key, weight]) => {
    totals.banker += Number(scoreSources[key].banker) * weight
    totals.player += Number(scoreSources[key].player) * weight
    return totals
  }, { banker: 0, player: 0 })
  const predictedResult = resolveV105ShadowV9Direction(scoreTotals, formal.predictedResult)
  const sameShoe = String(issuanceContext?.priorShoe ?? '') === String(table?.shoe ?? '')
  const sameSideStreak = predictedResult === issuanceContext?.priorDirection && sameShoe
    ? Math.max(0, Math.floor(Number(issuanceContext?.priorSameSideStreak) || 0)) + 1
    : 1
  const confidence = Math.max(30, Math.min(70, Math.round(30 + Math.abs(scoreTotals.banker - scoreTotals.player) * 100)))
  const main = {
    ...structuredClone(v8.heads.main),
    sourceVersion: 'v9-weighted-v7-v8',
    predictedResult,
  }
  return deepFreeze({
    ...structuredClone(v8),
    strategyVersion: V105_SHADOW_V9_VERSION,
    releaseCandidate: V105_SHADOW_V9_RELEASE,
    formalStrategyVersion: 'v105',
    shadowOnly: true,
    activationEligible: false,
    memberVisible: false,
    writesSideActions: false,
    predictedResult,
    confidence,
    sameSideStreak,
    heads: { ...structuredClone(v8.heads), main },
    featureWeights: { ...V105_SHADOW_V9_WEIGHTS },
    scoreSources,
    scoreTotals,
    signals,
  })
}

export function buildV105ShadowV9Settlement(round = {}, issued = {}) {
  if (issued?.strategyVersion !== V105_SHADOW_V9_VERSION) {
    throw new Error('V9 identity mismatch')
  }
  const settlement = buildV105ShadowV9BaselineSettlement(round, issued)
  return { ...settlement, strategyVersion: V105_SHADOW_V9_VERSION }
}

export function resolveV105ShadowV9Direction(scoreTotals = {}, formalDirection = 'banker') {
  const banker = Number(scoreTotals?.banker)
  const player = Number(scoreTotals?.player)
  const fallback = formalDirection === 'player' ? 'player' : 'banker'
  if (!Number.isFinite(banker) || !Number.isFinite(player)) return fallback
  if (Math.abs(banker - player) <= 1e-12) return fallback
  return banker > player ? 'banker' : 'player'
}

function directionScore(direction) {
  return direction === 'player' ? { banker: 0.45, player: 0.55 } : { banker: 0.55, player: 0.45 }
}

function mapHistory(rows, strategyVersion) {
  return rows.map((row) => ({
    ...structuredClone(row),
    strategy_version: strategyVersion,
    strategyVersion,
    prediction_payload: row?.prediction_payload ? {
      ...structuredClone(row.prediction_payload), strategyVersion, releaseCandidate: strategyVersion,
    } : row?.prediction_payload,
  }))
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}
