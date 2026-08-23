import { buildV105FormalPrediction } from './v105-formal-strategy.js'
import { buildV105ShadowV10Prediction } from './v105-shadow-v10-contract.js'

export const V105_V10_MAIN_RELEASE_VERSION = 'v105-v10-main.17'

export function buildV105V10MainPrediction(table = {}, historyRows = [], issuanceContext = {}) {
  const baseline = buildV105FormalPrediction(table, historyRows, issuanceContext)
  const v10 = buildV105ShadowV10Prediction(table, historyRows, issuanceContext)
  const structureEligible = v10.structureDiagnostics?.eligible === true
  const main = structureEligible ? v10 : baseline
  const predictionFeatures = structuredClone(baseline.predictionFeatures)
  if (structureEligible) {
    predictionFeatures.unified_main_scores = structuredClone(v10.scoreSources)
    predictionFeatures.confidence_calibration = structuredClone(v10.diagnostics?.calibration ?? null)
  }
  predictionFeatures.v105_v10_main_policy = {
    strategyVersion: 'v105',
    releaseVersion: V105_V10_MAIN_RELEASE_VERSION,
    sourceStrategy: structureEligible
      ? 'v105-shadow-v10-big-road-uncommon-structure-rank-synchronized'
      : 'v105',
    structureEligible,
    diagnostics: structuredClone(v10.signals),
  }
  const mainStreakAdjustment = structureEligible
    ? {
        applied: false,
        reason: 'v105_v10_eligible_main_projection',
        confidencePenalty: 0,
        finalConfidence: v10.confidence,
        supportGroupCount: 0,
        supportGroups: {},
        actionSuppressed: false,
      }
    : structuredClone(baseline.mainStreakAdjustment)
  predictionFeatures.main_streak_adjustment = structuredClone(mainStreakAdjustment)
  const {
    releaseCandidate: _releaseCandidate,
    ...formal
  } = baseline
  return {
    ...formal,
    strategyVersion: 'v105',
    buildVersion: 'v105',
    releaseVersion: V105_V10_MAIN_RELEASE_VERSION,
    predictedResult: main.predictedResult,
    confidence: main.confidence,
    probabilities: structureEligible
      ? buildMainProbabilities(v10, baseline.probabilities)
      : structuredClone(baseline.probabilities),
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

function buildMainProbabilities(main, predecessorProbabilities = {}) {
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
