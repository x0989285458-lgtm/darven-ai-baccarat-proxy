import test from 'node:test'
import assert from 'node:assert/strict'
import { buildLivePrediction } from '../src/supabase-writer.js'

const table = {
  tableId: 'BAG69', shoe: 1, round: 0,
  bankerCount: 80, playerCount: 1, tieCount: 0,
  bankerPairCount: 0, playerPairCount: 0,
  beadPlateRaw: '02#02#02#02#02', bigRoadRaw: 'B#B#B#B#B',
}

const v104Main = {
  predictedResult: 'player',
  confidence: 51,
  scores: {
    roadmap_trend_signals: { banker: 0.45, player: 0.55 },
    ask_road_signals: { banker: 0.50, player: 0.50 },
    shoe_banker_player_bias: { banker: 0.42, player: 0.58 },
    neutral_reserve: { banker: 0.50, player: 0.50 },
  },
  total: { banker: 0.4585, player: 0.5415 },
  featureWeights: {
    roadmap_trend_signals: 0.275,
    ask_road_signals: 0.275,
    shoe_banker_player_bias: 0.35,
    neutral_reserve: 0.10,
  },
  confidenceCalibration: { mode: 'confidence_only_final_history' },
  diagnostics: { lockRisk: true, shoeBiasSuppressed: true },
}

const v104Adjustment = {
  applied: true,
  reason: 'v104_lock_guard',
  confidencePenalty: 0,
  finalConfidence: 51,
  supportGroupCount: 1,
  supportGroups: { roadmap: true, askRoad: false },
  actionSuppressed: false,
}

test('formal prediction assembly uses the approved v104 main output while retaining side prediction outputs', () => {
  const baseline = buildLivePrediction(table)
  assert.equal(baseline.predictedResult, 'banker', 'fixture must prove the override changes direction')

  const formal = buildLivePrediction(table, {
    mainPredictionOverride: v104Main,
    mainStreakAdjustmentOverride: v104Adjustment,
    strategyVersion: 'v104',
    buildVersion: 'v104',
    mainPolicyKey: 'v104_main_policy',
  })

  assert.equal(formal.predictedResult, 'player')
  assert.equal(formal.confidence, 51)
  assert.equal(formal.strategyVersion, 'v104')
  assert.equal(formal.buildVersion, 'v104')
  assert.deepEqual(formal.scoreTotals, v104Main.total)
  assert.deepEqual(formal.featureWeights, v104Main.featureWeights)
  assert.deepEqual(formal.sidePredictions, baseline.sidePredictions)
  assert.equal(formal.sideActions.superSix, false, 'Super Six remains gated off when v104 main predicts player')
  assert.deepEqual(formal.predictionFeatures.v104_main_policy.diagnostics, v104Main.diagnostics)
  assert.equal('v102_main_signal_dedup' in formal.predictionFeatures, false)
})
