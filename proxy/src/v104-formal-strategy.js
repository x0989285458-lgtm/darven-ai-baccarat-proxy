import { buildLivePrediction } from './supabase-writer.js'
import { buildV104ShadowPrediction } from './v104-shadow-strategy.js'

export const V104_FORMAL_STRATEGY_VERSION = 'v104'
export const V104_FORMAL_RELEASE_VERSION = 'v104.0.0-formal.1'

export function buildV104FormalPrediction(table = {}, historyRows = [], issuanceContext = {}) {
  const approved = buildV104ShadowPrediction(table, historyRows, issuanceContext)
  const diagnostics = structuredClone(approved.diagnostics)
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
    reason: approved.lockRisk ? 'v104_lock_guard' : 'v104_no_lock_risk',
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
    strategyVersion: V104_FORMAL_STRATEGY_VERSION,
    buildVersion: V104_FORMAL_STRATEGY_VERSION,
    mainPolicyKey: 'v104_main_policy',
    sidePolicyKey: 'v104_side_policy',
  })
  return {
    ...formal,
    releaseVersion: V104_FORMAL_RELEASE_VERSION,
    predictionTiming: 'pre_result_context',
    shadowOnly: false,
    activationEligible: true,
    memberVisible: true,
    writesSideActions: true,
    sameSideStreak: approved.sameSideStreak,
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
