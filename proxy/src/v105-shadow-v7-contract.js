import {
  V105_SHADOW_VERSION as V6_VERSION,
  V105_SHADOW_TABLE_IDS,
  buildV105ShadowPrediction,
  buildV105ShadowSettlement,
} from './v105-shadow-contract.js'
import { decodeRoadColorSequence, detectRepeatedCycle } from './v105-road-cycle.js'

export const V105_SHADOW_V7_VERSION = 'v105-shadow-v7-ask-road'
export const V105_SHADOW_V7_RELEASE = 'v105-shadow-v7-ask-road'
export const V105_SHADOW_V7_TABLE_IDS = V105_SHADOW_TABLE_IDS

const ROAD_SPECS = Object.freeze([
  { name: 'bigEye', current: 'bigEyeRaw', candidate: ['big_eye', 'bigEye'] },
  { name: 'smallRoad', current: 'smallRoadRaw', candidate: ['small', 'small_road', 'smallRoad'] },
  { name: 'cockroach', current: 'cockroachRaw', candidate: ['cockroach', 'cockroach_road'] },
])

export function analyzeV105ShadowV7AskRoad(table = {}, v6Direction = null, v6RoadPatternClear = false) {
  const roads = Object.fromEntries(ROAD_SPECS.map((spec) => [spec.name, analyzeRoad(table, spec)]))
  const directions = Object.values(roads).map((road) => road.candidateDirection).filter(Boolean)
  const votes = {
    banker: directions.filter((direction) => direction === 'banker').length,
    player: directions.filter((direction) => direction === 'player').length,
    eligible: directions.length,
  }
  const consensusDirection = votes.banker >= 2 && votes.player === 0
    ? 'banker'
    : votes.player >= 2 && votes.banker === 0
      ? 'player'
      : null
  const relationToV6 = !consensusDirection
    ? 'fallback_v6'
    : v6RoadPatternClear
      ? consensusDirection === v6Direction ? 'confirmed' : 'conflict'
      : 'override_unclear_v6'
  const reason = !consensusDirection
    ? votes.eligible < 2 ? 'insufficient_valid_votes' : 'no_unique_two_of_three_support'
    : relationToV6 === 'confirmed' ? 'ask_road_confirms_clear_v6'
      : relationToV6 === 'conflict' ? 'clear_v6_retained_despite_ask_road_conflict'
        : 'ask_road_consensus_controls_unclear_v6'
  return deepFreeze({ roads, votes, consensusDirection, relationToV6, reason })
}

export function buildV105ShadowV7Prediction(table = {}, historyRows = [], issuanceContext = {}) {
  const v6History = (Array.isArray(historyRows) ? historyRows : [])
    .filter((row) => (row?.strategy_version ?? row?.strategyVersion) === V105_SHADOW_V7_VERSION)
    .map((row) => ({
      ...structuredClone(row),
      strategy_version: V6_VERSION,
      strategyVersion: V6_VERSION,
      prediction_payload: row?.prediction_payload ? {
        ...structuredClone(row.prediction_payload), strategyVersion: V6_VERSION, releaseCandidate: V6_VERSION,
      } : row?.prediction_payload,
    }))
  const v6 = buildV105ShadowPrediction(table, v6History, issuanceContext)
  const askRoadSignal = analyzeV105ShadowV7AskRoad(
    table,
    v6.roadPatternSignal?.direction ?? v6.predictedResult,
    v6.roadPatternSignal?.clear === true,
  )
  const askControls = v6.roadPatternSignal?.clear !== true && Boolean(askRoadSignal.consensusDirection)
  const predictedResult = askControls ? askRoadSignal.consensusDirection : v6.predictedResult
  const sameShoe = String(issuanceContext?.priorShoe ?? '') === String(table?.shoe ?? '')
  const sameSideStreak = predictedResult === issuanceContext?.priorDirection && sameShoe
    ? Math.max(0, Math.floor(Number(issuanceContext?.priorSameSideStreak) || 0)) + 1
    : 1
  const main = askControls ? {
    ...structuredClone(v6.heads.main),
    sourceVersion: 'v7-ask-road',
    predictedResult,
    roadPatternControlled: false,
    askRoadControlled: true,
  } : structuredClone(v6.heads.main)
  return deepFreeze({
    ...structuredClone(v6),
    strategyVersion: V105_SHADOW_V7_VERSION,
    releaseCandidate: V105_SHADOW_V7_RELEASE,
    predictedResult,
    sameSideStreak,
    heads: { ...structuredClone(v6.heads), main },
    askRoadSignal: structuredClone(askRoadSignal),
  })
}

export function buildV105ShadowV7Settlement(round = {}, issued = {}) {
  if (issued?.strategyVersion !== V105_SHADOW_V7_VERSION) {
    throw new Error('v105-shadow-v7-ask-road identity mismatch')
  }
  const settlement = buildV105ShadowSettlement(round, {
    ...structuredClone(issued), strategyVersion: V6_VERSION,
  })
  return { ...settlement, strategyVersion: V105_SHADOW_V7_VERSION }
}

function analyzeRoad(table, spec) {
  const currentSequence = decodeRoadColorSequence(table?.[spec.current])
  const cycle = detectRepeatedCycle(currentSequence)
  const rhythmEligible = cycle.detected === true
    && Array.isArray(cycle.motif)
    && (cycle.motif.length >= 4 || cycle.repeats >= 3)
  const expectedColor = rhythmEligible ? cycle.next : null
  const bankerCandidate = decodeCandidate(table?.nextBankerRaw, spec.candidate)
  const playerCandidate = decodeCandidate(table?.nextPlayerRaw, spec.candidate)
  const bankerNextColor = exactAppendedColor(currentSequence, bankerCandidate)
  const playerNextColor = exactAppendedColor(currentSequence, playerCandidate)
  let candidateDirection = null
  let reason = null
  if (!expectedColor) reason = 'insufficient_rhythm_data'
  else if (!bankerNextColor || !playerNextColor) reason = 'candidate_not_exact_append'
  else if (bankerNextColor === playerNextColor) reason = 'candidate_colors_same'
  else if (bankerNextColor === expectedColor) candidateDirection = 'banker'
  else if (playerNextColor === expectedColor) candidateDirection = 'player'
  else reason = 'expected_color_not_uniquely_supported'
  return {
    currentSequence: [...currentSequence],
    expectedColor,
    bankerNextColor,
    playerNextColor,
    candidateDirection,
    reason: candidateDirection ? 'unique_expected_color_match' : reason,
  }
}

function decodeCandidate(raw, keys) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  for (const key of keys) {
    if (Object.hasOwn(raw, key)) return decodeRoadColorSequence(raw[key])
  }
  return []
}

function exactAppendedColor(current, candidate) {
  if (candidate.length !== current.length + 1) return null
  if (current.some((color, index) => candidate[index] !== color)) return null
  return candidate.at(-1) ?? null
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}
