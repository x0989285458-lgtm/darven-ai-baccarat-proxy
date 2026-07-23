import { buildLivePrediction } from './supabase-writer.js'
import { buildV104ShadowPrediction } from './v104-shadow-strategy.js'

export const V105_FORMAL_STRATEGY_VERSION = 'v105'
export const V105_FORMAL_RELEASE_VERSION = 'v105.0.0-formal.7'

export function buildV105FormalPrediction(table = {}, historyRows = [], issuanceContext = {}) {
  const baseline = buildV104ShadowPrediction(table, historyRows, issuanceContext, {
    historyStrategyVersion: ['v104', V105_FORMAL_STRATEGY_VERSION],
    cyclePriority: false,
  })
  const cycleCandidate = buildV104ShadowPrediction(table, historyRows, issuanceContext, {
    historyStrategyVersion: ['v104', V105_FORMAL_STRATEGY_VERSION],
    cyclePriority: true,
  })
  const cycleApplied = cycleCandidate.diagnostics?.roadCycles?.main?.priorityEligible === true
  const approved = cycleApplied ? cycleCandidate : baseline
  const diagnostics = structuredClone(approved.diagnostics)
  diagnostics.roadCycles = structuredClone(cycleCandidate.diagnostics?.roadCycles ?? null)
  diagnostics.v104Baseline = {
    predictedResult: baseline.predictedResult,
    sameSideStreak: baseline.sameSideStreak,
    cycleApplied,
  }
  const mainPredictionOverride = {
    predictedResult: approved.predictedResult,
    confidence: approved.confidence,
    scores: structuredClone(approved.scoreSources),
    total: structuredClone(approved.scoreTotals),
    featureWeights: structuredClone(approved.featureWeights),
    confidenceCalibration: structuredClone(approved.diagnostics.calibration),
    diagnostics,
  }
  const mainStreakAdjustmentOverride = {
    applied: approved.lockRisk,
    reason: approved.lockRisk ? 'v105_lock_guard' : 'v105_no_lock_risk',
    confidencePenalty: 0,
    finalConfidence: approved.confidence,
    supportGroupCount: approved.independentSupportCount,
    supportGroups: {
      roadmap: supportsDirection(approved.scoreSources.roadmap_trend_signals, approved.predictedResult),
      askRoad: supportsDirection(approved.scoreSources.ask_road_signals, approved.predictedResult),
    },
    actionSuppressed: false,
  }
  const formal = buildLivePrediction(table, {
    mainPredictionOverride,
    mainStreakAdjustmentOverride,
    strategyVersion: V105_FORMAL_STRATEGY_VERSION,
    buildVersion: V105_FORMAL_STRATEGY_VERSION,
    mainPolicyKey: 'v105_main_policy',
    sidePolicyKey: 'v105_side_policy',
  })
  return {
    ...formal,
    releaseVersion: V105_FORMAL_RELEASE_VERSION,
    predictionTiming: 'pre_result_context',
    shadowOnly: false,
    activationEligible: true,
    memberVisible: true,
    writesSideActions: true,
    sameSideStreak: approved.sameSideStreak,
    baselineV104PredictedResult: baseline.predictedResult,
    baselineV104SameSideStreak: baseline.sameSideStreak,
    cycleApplied,
    independentSupportCount: approved.independentSupportCount,
    shoeBiasSuppressed: approved.shoeBiasSuppressed,
    askRoadSuppressed: approved.askRoadSuppressed,
    lockRisk: approved.lockRisk,
    diagnostics,
  }
}

function supportsDirection(score = {}, direction) {
  const banker = Number(score.banker)
  const player = Number(score.player)
  if (!Number.isFinite(banker) || !Number.isFinite(player) || Math.abs(banker - player) <= 1e-12) return false
  return direction === 'banker' ? banker > player : player > banker
}
