import {
  V105_SHADOW_V9_TABLE_IDS,
  V105_SHADOW_V9_VERSION,
  buildV105ShadowV9Prediction,
  buildV105ShadowV9Settlement,
} from './v105-shadow-v9-contract.js'
import { analyzeV105ShadowV10UncommonRoadStructure } from './v105-shadow-v10-structure.js'

export const V105_SHADOW_V10_VERSION = 'v105-shadow-v10-big-road-uncommon-structure'
export const V105_SHADOW_V10_RELEASE = V105_SHADOW_V10_VERSION
export const V105_SHADOW_V10_TABLE_IDS = V105_SHADOW_V9_TABLE_IDS
export const V105_SHADOW_V10_WEIGHTS = Object.freeze({
  v7RoadCycle: 0.315,
  v8AskRoad: 0.315,
  recentPracticalCalibration: 0.18,
  shoeBankerPlayerBias: 0.09,
  uncommonRoadStructure: 0.10,
})

export function buildV105ShadowV10Prediction(table = {}, historyRows = [], issuanceContext = {}) {
  const beadIndependentTable = buildV105ShadowV10MainTable(table)
  const v9 = buildV105ShadowV9Prediction(beadIndependentTable, mapHistory(historyRows), issuanceContext)
  const v9SideHeads = buildV105ShadowV9Prediction(table, mapHistory(historyRows), issuanceContext).heads
  const structureDiagnostics = analyzeV105ShadowV10UncommonRoadStructure(beadIndependentTable)
  const signals = {
    ...structuredClone(v9.signals),
    uncommonRoadStructure: structuredClone(structureDiagnostics),
  }
  const scoreSources = {
    ...structuredClone(v9.scoreSources),
    uncommonRoadStructure: structureDiagnostics.eligible
      ? directionScore(structureDiagnostics.direction)
      : { banker: 0.5, player: 0.5 },
  }
  const scoreTotals = Object.entries(V105_SHADOW_V10_WEIGHTS).reduce((totals, [key, weight]) => {
    totals.banker += Number(scoreSources[key].banker) * weight
    totals.player += Number(scoreSources[key].player) * weight
    return totals
  }, { banker: 0, player: 0 })
  const predictedResult = resolveV105ShadowV10Direction(scoreTotals, v9.predictedResult)
  const sameShoe = String(issuanceContext?.priorShoe ?? '') === String(table?.shoe ?? '')
  const sameSideStreak = predictedResult === issuanceContext?.priorDirection && sameShoe
    ? Math.max(0, Math.floor(Number(issuanceContext?.priorSameSideStreak) || 0)) + 1
    : 1
  const confidence = Math.max(30, Math.min(70, Math.round(30 + Math.abs(scoreTotals.banker - scoreTotals.player) * 100)))
  const main = {
    ...structuredClone(v9.heads.main),
    sourceVersion: 'v10-big-road-uncommon-structure',
    predictedResult,
    structureEligible: structureDiagnostics.eligible,
  }
  return deepFreeze({
    ...structuredClone(v9),
    strategyVersion: V105_SHADOW_V10_VERSION,
    releaseCandidate: V105_SHADOW_V10_RELEASE,
    v9BaseDirection: v9.predictedResult,
    predictedResult,
    confidence,
    sameSideStreak,
    heads: { ...structuredClone(v9SideHeads), main },
    featureWeights: { ...V105_SHADOW_V10_WEIGHTS },
    scoreSources,
    scoreTotals,
    signals,
    structureDiagnostics: structuredClone(structureDiagnostics),
  })
}

export function buildV105ShadowV10MainTable(table = {}) {
  return stripBeadPlateFields(structuredClone(table))
}

function stripBeadPlateFields(value) {
  if (Array.isArray(value)) return value.map(stripBeadPlateFields)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).flatMap(([key, nested]) => (
    isBeadPlateKey(key) ? [] : [[key, stripBeadPlateFields(nested)]]
  )))
}

function isBeadPlateKey(key) {
  return ['bead', 'beadplate', 'beadplateraw', 'beadplate2'].includes(String(key).toLowerCase().replace(/[^a-z0-9]/g, ''))
}

export function buildV105ShadowV10Settlement(round = {}, issued = {}) {
  if (issued?.strategyVersion !== V105_SHADOW_V10_VERSION) throw new Error('V10 identity mismatch')
  const settlement = buildV105ShadowV9Settlement(round, {
    ...structuredClone(issued),
    strategyVersion: V105_SHADOW_V9_VERSION,
  })
  return { ...settlement, strategyVersion: V105_SHADOW_V10_VERSION }
}

export function resolveV105ShadowV10Direction(scoreTotals = {}, v9Direction = 'banker') {
  const banker = Number(scoreTotals?.banker)
  const player = Number(scoreTotals?.player)
  const fallback = v9Direction === 'player' ? 'player' : 'banker'
  if (!Number.isFinite(banker) || !Number.isFinite(player)) return fallback
  if (Math.abs(banker - player) <= 1e-12) return fallback
  return banker > player ? 'banker' : 'player'
}

function directionScore(direction) {
  return direction === 'player' ? { banker: 0.45, player: 0.55 } : { banker: 0.55, player: 0.45 }
}

function mapHistory(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    ...structuredClone(row),
    strategy_version: V105_SHADOW_V9_VERSION,
    strategyVersion: V105_SHADOW_V9_VERSION,
    prediction_payload: row?.prediction_payload ? {
      ...structuredClone(row.prediction_payload),
      strategyVersion: V105_SHADOW_V9_VERSION,
      releaseCandidate: V105_SHADOW_V9_VERSION,
    } : row?.prediction_payload,
  }))
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}
