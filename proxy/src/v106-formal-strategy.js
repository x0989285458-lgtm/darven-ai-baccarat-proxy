import { buildV105FormalPrediction } from './v105-formal-strategy.js'
import { buildV105ShadowV10Prediction } from './v105-shadow-v10-contract.js'

export const V106_FORMAL_STRATEGY_VERSION = 'v106'
export const V106_FORMAL_RELEASE_VERSION = 'v106.0.0-formal.60'

export function buildV106FormalPrediction(table = {}, historyRows = [], issuanceContext = {}) {
  // The formal v105 call receives the untouched source and remains the sole authority
  // for all six side heads. Successor rows are projected into the predecessor history
  // identity so non-eligible v106 fallback retains v105 confidence calibration.
  const v105 = buildV105FormalPrediction(table, mapV106HistoryToV105(historyRows), issuanceContext)
  const v10 = buildV105ShadowV10Prediction(table, historyRows, issuanceContext)
  const structureEligible = v10.structureDiagnostics?.eligible === true
  const main = structureEligible ? v10 : v105
  const predictionFeatures = structuredClone(v105.predictionFeatures)
  if (structureEligible) {
    delete predictionFeatures.v105_main_policy
    predictionFeatures.unified_main_scores = structuredClone(v10.scoreSources)
    predictionFeatures.confidence_calibration = structuredClone(v10.diagnostics?.calibration ?? null)
  }
  predictionFeatures.v106_main_policy = {
    strategyVersion: V106_FORMAL_STRATEGY_VERSION,
    sourceStrategy: structureEligible
      ? 'v105-shadow-v10-big-road-uncommon-structure-rank-synchronized'
      : 'v105',
    structureEligible,
    diagnostics: structuredClone(v10.signals),
  }
  const mainStreakAdjustment = structureEligible
    ? {
        applied: false,
        reason: 'v106_v10_eligible_main_projection',
        confidencePenalty: 0,
        finalConfidence: v10.confidence,
        supportGroupCount: 0,
        supportGroups: {},
        actionSuppressed: false,
      }
    : structuredClone(v105.mainStreakAdjustment)
  predictionFeatures.main_streak_adjustment = structuredClone(mainStreakAdjustment)
  const {
    shadowOnly: _shadowOnly,
    memberVisible: _memberVisible,
    releaseCandidate: _releaseCandidate,
    ...formal
  } = v105
  return {
    ...formal,
    strategyVersion: V106_FORMAL_STRATEGY_VERSION,
    buildVersion: V106_FORMAL_STRATEGY_VERSION,
    releaseVersion: V106_FORMAL_RELEASE_VERSION,
    predictedResult: main.predictedResult,
    confidence: main.confidence,
    probabilities: structureEligible
      ? buildV106MainProbabilities(v10, v105.probabilities)
      : structuredClone(v105.probabilities),
    scoreTotals: structuredClone(main.scoreTotals),
    scoreSources: structuredClone(main.scoreSources),
    featureWeights: structuredClone(main.featureWeights),
    mainStreakAdjustment,
    predictionFeatures,
    sameSideStreak: main.sameSideStreak,
    v9BaseDirection: v10.v9BaseDirection,
    structureDiagnostics: structuredClone(v10.structureDiagnostics),
    rankLedgerEvidence: structuredClone(v10.rankLedgerEvidence),
    predictionTiming: 'pre_result_context',
    activationEligible: true,
    writesSideActions: true,
  }
}

function buildV106MainProbabilities(main, predecessorProbabilities = {}) {
  const bankerScore = Number(main?.scoreTotals?.banker)
  const playerScore = Number(main?.scoreTotals?.player)
  const total = bankerScore + playerScore
  if (!Number.isFinite(total) || total <= 0) return structuredClone(predecessorProbabilities)
  let banker = Math.round((bankerScore / total) * 100)
  let player = 100 - banker
  if (main.predictedResult === 'banker' && banker <= player) [banker, player] = [51, 49]
  if (main.predictedResult === 'player' && player <= banker) [banker, player] = [49, 51]
  return { ...structuredClone(predecessorProbabilities), banker, player }
}

function mapV106HistoryToV105(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    if ((row?.strategy_version ?? row?.strategyVersion) !== V106_FORMAL_STRATEGY_VERSION) {
      return structuredClone(row)
    }
    const mapped = {
      ...structuredClone(row),
      strategy_version: 'v105',
      strategyVersion: 'v105',
    }
    if (mapped.prediction_payload) mapped.prediction_payload.strategyVersion = 'v105'
    if (mapped.issued_prediction_payload) mapped.issued_prediction_payload.strategyVersion = 'v105'
    return mapped
  })
}
