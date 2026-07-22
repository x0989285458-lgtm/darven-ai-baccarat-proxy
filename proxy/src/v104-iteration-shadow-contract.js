import { isVerifiedFinalRoundAction } from '../../shared/real-card-validator.js'
import {
  SIDE_PREDICTION_THRESHOLDS,
  SIDE_PREDICTION_WEIGHT_PROFILES,
  V100_SIDE_SCORE_CALIBRATION_OFFSETS,
  buildSideFeatureScores,
  deriveBaccaratRoundFacts,
} from './supabase-writer.js'
import { buildV104FormalPrediction } from './v104-formal-strategy.js'
import { buildV104ShadowPrediction } from './v104-shadow-strategy.js'

export const V104_ITERATION_SHADOW_VERSION = 'v104-seven-head-shadow-v3-main-player-pair-reweight'
export const V104_ITERATION_SHADOW_RELEASE = 'v104.3.0-seven-head-shadow.3'
export const V104_ITERATION_SHADOW_MAIN_WEIGHTS = Object.freeze({
  roadmap_trend_signals: 0.25,
  ask_road_signals: 0.35,
  shoe_banker_player_bias: 0.30,
  neutral_reserve: 0.10,
})
export const V104_ITERATION_SHADOW_PLAYER_PAIR_WEIGHTS = Object.freeze({
  remaining_rank_pressure: 0.25,
  shoe_stage: 0.05,
  player_pair_count: 0.25,
  player_pair_residual: 0.15,
  pair_shared_factor: 0.30,
})
export const V104_ITERATION_SHADOW_THRESHOLDS = Object.freeze({
  ...SIDE_PREDICTION_THRESHOLDS,
  playerPair: 41,
})
export const SHADOW_HEAD_KEYS = Object.freeze(['main', 'tie', 'superSix', 'bankerDragon', 'playerDragon', 'bankerPair', 'playerPair'])
export const SHADOW_HEAD_LABELS = Object.freeze({
  main: '莊／閒', tie: '和', superSix: '超六', bankerDragon: '莊龍寶',
  playerDragon: '閒龍寶', bankerPair: '莊對', playerPair: '閒對',
})

export const frozenWeightKeys = Object.freeze({
  main: Object.freeze(Object.keys(V104_ITERATION_SHADOW_MAIN_WEIGHTS)),
  ...Object.fromEntries(SHADOW_HEAD_KEYS.slice(1).map((key) => [
    key,
    Object.freeze(Object.keys(SIDE_PREDICTION_WEIGHT_PROFILES[key]).filter((name) => Number(SIDE_PREDICTION_WEIGHT_PROFILES[key][name]) > 0)),
  ])),
  playerPair: Object.freeze(Object.keys(V104_ITERATION_SHADOW_PLAYER_PAIR_WEIGHTS)),
})

export function confidenceToMainUnits(confidence) {
  const value = Math.min(70, Math.max(50, finitePercent(confidence)))
  return Math.max(1, Math.min(5, Math.round(1 + ((value - 50) * 4 / 20))))
}

export function confidenceToSideUnits(confidence, threshold) {
  const value = finitePercent(confidence)
  const gate = finitePercent(threshold)
  if (value < gate || gate >= 100) return value >= 100 && gate === 100 ? 1 : 0
  return Math.max(1, Math.min(10, Math.round(1 + ((value - gate) * 9 / (100 - gate)))))
}

export function calculateV104IterationPlayerPairConfidence(featureValues = {}) {
  const raw = Object.entries(V104_ITERATION_SHADOW_PLAYER_PAIR_WEIGHTS)
    .reduce((sum, [key, weight]) => sum + finitePercent(featureValues[key]) * weight, 0)
  return finitePercent(raw + Number(V100_SIDE_SCORE_CALIBRATION_OFFSETS.playerPair ?? 0))
}

export function buildV104IterationShadowPrediction(table = {}, historyRows = [], issuanceContext = {}) {
  const formal = buildV104FormalPrediction(table, historyRows, issuanceContext)
  const candidateMain = buildV104ShadowPrediction(table, historyRows, issuanceContext, {
    directionWeights: V104_ITERATION_SHADOW_MAIN_WEIGHTS,
    historyStrategyVersion: V104_ITERATION_SHADOW_VERSION,
  })
  const featureScores = buildSideFeatureScores(table, {
    tableId: table.tableId,
    shoe: table.shoe,
    round: Number(table.round ?? 0) + 1,
    cardShoe: table.v102RankLedger ?? table.cardShoe ?? null,
  })
  const sideDiagnostics = formal.predictionFeatures?.v104_side_policy?.diagnostics ?? {}
  const sidePrimitives = sideDiagnostics.primitives ?? {}
  const sideResiduals = sideDiagnostics.residuals ?? {}
  const playerPairFeatureValues = {
    remaining_rank_pressure: finitePercent(sidePrimitives.Q),
    shoe_stage: finitePercent(sidePrimitives.S),
    player_pair_count: finitePercent(sidePrimitives.XP),
    player_pair_residual: finitePercent(sideResiduals.playerPair),
    pair_shared_factor: finitePercent(sidePrimitives.Hpair),
  }
  const playerPairConfidence = calculateV104IterationPlayerPairConfidence(playerPairFeatureValues)
  const rankAvailable = sideDiagnostics.rank?.available === true
  const main = {
    key: 'main', label: SHADOW_HEAD_LABELS.main, action: true, threshold: null,
    predictedResult: candidateMain.predictedResult,
    confidence: finitePercent(candidateMain.confidence),
    units: confidenceToMainUnits(candidateMain.confidence),
    weights: structuredClone(V104_ITERATION_SHADOW_MAIN_WEIGHTS),
    featureValues: buildMainFeatureValues(candidateMain),
  }
  const sideHeads = Object.fromEntries(SHADOW_HEAD_KEYS.slice(1).map((key) => {
    const confidence = key === 'playerPair'
      ? playerPairConfidence
      : finitePercent(formal.sidePredictions?.[key])
    const threshold = Number(V104_ITERATION_SHADOW_THRESHOLDS[key])
    const action = rankAvailable && confidence >= threshold
    const weights = key === 'playerPair'
      ? V104_ITERATION_SHADOW_PLAYER_PAIR_WEIGHTS
      : SIDE_PREDICTION_WEIGHT_PROFILES[key]
    const featureValues = key === 'playerPair'
      ? playerPairFeatureValues
      : Object.fromEntries(frozenWeightKeys[key].map((name) => [name, finitePercent(featureScores[name])]))
    return [key, {
      key, label: SHADOW_HEAD_LABELS[key], action, threshold, confidence,
      units: action ? confidenceToSideUnits(confidence, threshold) : 0,
      weights: structuredClone(weights),
      featureValues,
      rankAvailable,
    }]
  }))
  return {
    source: 'ofalive99',
    strategyVersion: V104_ITERATION_SHADOW_VERSION,
    releaseCandidate: V104_ITERATION_SHADOW_RELEASE,
    formalStrategyVersion: 'v104',
    predictionTiming: 'pre_result_context',
    shadowOnly: true,
    activationEligible: false,
    memberVisible: false,
    writesSideActions: false,
    targetTableId: String(formal.targetTableId ?? table.tableId ?? ''),
    targetShoe: formal.targetShoe == null ? null : String(formal.targetShoe),
    targetRound: Number(candidateMain.targetRound),
    predictedResult: candidateMain.predictedResult,
    confidence: main.confidence,
    sameSideStreak: candidateMain.sameSideStreak,
    independentSupportCount: candidateMain.independentSupportCount,
    shoeBiasSuppressed: candidateMain.shoeBiasSuppressed,
    lockRisk: candidateMain.lockRisk,
    heads: { main, ...sideHeads },
    formalReference: {
      releaseVersion: formal.releaseVersion,
      sameSideStreak: formal.sameSideStreak,
      independentSupportCount: formal.independentSupportCount,
      shoeBiasSuppressed: formal.shoeBiasSuppressed,
      askRoadSuppressed: formal.askRoadSuppressed,
      lockRisk: formal.lockRisk,
    },
  }
}

export function buildV104IterationShadowSettlement(round = {}, issued = {}) {
  if (!isVerifiedFinalRoundAction(round?.sourceAction)) throw new Error('iteration shadow settlement requires verified Final summary/show_win')
  if (!issued?.predictionId || !issued?.issuedAt
      || issued.strategyVersion !== V104_ITERATION_SHADOW_VERSION
      || issued.predictionTiming !== 'pre_result_context'
      || String(round.tableId ?? '') !== String(issued.targetTableId ?? '')
      || String(round.shoe ?? '') !== String(issued.targetShoe ?? '')
      || Number(round.round) !== Number(issued.targetRound)) throw new Error('iteration shadow settlement identity mismatch')
  const facts = deriveBaccaratRoundFacts(round)
  const actualResult = String(facts.winner ?? round.winner ?? '').toLowerCase()
  if (!['banker', 'player', 'tie'].includes(actualResult)) throw new Error('iteration shadow settlement result is invalid')
  const actuals = {
    tie: actualResult === 'tie',
    superSix: Boolean(facts.superSix),
    bankerPair: Boolean(facts.bankerPair),
    playerPair: Boolean(facts.playerPair),
    bankerDragon: Boolean(facts.bankerDragon),
    playerDragon: Boolean(facts.playerDragon),
  }
  const headResults = {}
  for (const key of SHADOW_HEAD_KEYS) {
    const head = issued.heads?.[key]
    if (!head || typeof head !== 'object') throw new Error(`iteration shadow issuance missing ${key}`)
    if (key === 'main') {
      const status = actualResult === 'tie' ? 'push' : actualResult === head.predictedResult ? 'hit' : 'miss'
      headResults[key] = settleHead({ key, status, fixedUnits: 1, weightedUnits: Number(head.units), multiplier: mainPayout(head.predictedResult) })
      continue
    }
    if (head.action !== true) {
      headResults[key] = { key, action: false, status: 'no_action', isHit: null, fixedStakeUnits: 0, weightedStakeUnits: 0, fixedNetUnits: 0, weightedNetUnits: 0 }
      continue
    }
    const hit = actuals[key] === true
    headResults[key] = settleHead({
      key, status: hit ? 'hit' : 'miss', fixedUnits: 1, weightedUnits: Number(head.units),
      multiplier: sidePayout(key, facts, hit),
    })
  }
  const mainResult = headResults.main
  return {
    predictionId: issued.predictionId,
    source: issued.source ?? 'ofalive99', tableId: issued.targetTableId,
    shoe: issued.targetShoe, round: issued.targetRound,
    strategyVersion: V104_ITERATION_SHADOW_VERSION,
    actualResult,
    actualFacts: {
      tie: actuals.tie,
      superSix: actuals.superSix,
      bankerDragon: actuals.bankerDragon,
      playerDragon: actuals.playerDragon,
      bankerPair: actuals.bankerPair,
      playerPair: actuals.playerPair,
      bankerNatural: Boolean(facts.bankerNatural),
      playerNatural: Boolean(facts.playerNatural),
      pointDiff: Number(facts.pointDiff),
      bankerPoints: Number(facts.bankerPoint),
      playerPoints: Number(facts.playerPoint),
      bankerCardRanks: facts.bankerCardRanks.filter((rank) => Number.isInteger(rank)),
      playerCardRanks: facts.playerCardRanks.filter((rank) => Number.isInteger(rank)),
    },
    predictedResult: issued.heads.main.predictedResult,
    settlementStatus: mainResult.status,
    isHit: mainResult.isHit,
    headResults,
    settlementFinal: true, settlementSourceAction: normalizeFinalAction(round.sourceAction),
    resolvedAt: new Date().toISOString(),
  }
}

function normalizeFinalAction(action) {
  const value = String(action ?? '').toLowerCase()
  if (value === 'summary' || value.endsWith('/summary')) return 'summary'
  if (value === 'show_win' || value.endsWith('/show_win')) return 'show_win'
  throw new Error('iteration shadow settlement requires verified Final summary/show_win')
}

function settleHead({ key, status, fixedUnits, weightedUnits, multiplier }) {
  const isHit = status === 'push' ? null : status === 'hit'
  const net = (units) => status === 'push' ? 0 : status === 'hit' ? roundUnits(units * multiplier) : roundUnits(-units)
  return {
    key, action: true, status, isHit,
    fixedStakeUnits: fixedUnits, weightedStakeUnits: weightedUnits,
    fixedNetUnits: net(fixedUnits), weightedNetUnits: net(weightedUnits),
  }
}

function mainPayout(direction) {
  return direction === 'banker' ? 0.95 : 1
}

function sidePayout(key, facts, hit) {
  if (!hit) return 0
  if (key === 'tie') return 8
  if (key === 'superSix') return 12
  if (key === 'bankerPair' || key === 'playerPair') return 11
  const natural = key === 'bankerDragon' ? facts.bankerNatural : facts.playerNatural
  if (natural) return 1
  return ({ 4: 1, 5: 2, 6: 4, 7: 6, 8: 10, 9: 30 })[Number(facts.pointDiff)] ?? 0
}

function buildMainFeatureValues(formal) {
  const direction = formal.predictedResult
  return Object.fromEntries(frozenWeightKeys.main.map((key) => {
    const score = formal.scoreSources?.[key] ?? { banker: 0.5, player: 0.5 }
    const banker = Number(score.banker)
    const player = Number(score.player)
    const total = banker + player
    const value = Number.isFinite(total) && total > 0 ? (direction === 'banker' ? banker : player) / total * 100 : 50
    return [key, finitePercent(value)]
  }))
}

function finitePercent(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : 0
}

function roundUnits(value) {
  return Math.round(Number(value) * 10000) / 10000
}
