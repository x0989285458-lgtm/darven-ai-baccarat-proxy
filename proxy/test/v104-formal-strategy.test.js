import test from 'node:test'
import assert from 'node:assert/strict'
import { buildV104ShadowPrediction } from '../src/v104-shadow-strategy.js'

const table = {
  tableId: 'BAG08', shoe: '19064', round: 20,
  bankerCount: 12, playerCount: 8, tieCount: 1,
  bankerPairCount: 1, playerPairCount: 2,
  beadPlateRaw: '01#02#01#02#01', bigRoadRaw: 'P#B#P#B#P',
}

const history = [
  { table_id: 'BAG08', strategy_version: 'v104', prediction_timing: 'pre_result_context', prediction_issued_at: '2026-07-21T00:00:00Z', settlement_final: true, predicted_result: 'banker', actual_result: 'player', resolved_at: '2026-07-21T00:01:00Z' },
]

const issuanceContext = { priorShoe: '19064', priorDirection: 'banker', priorSameSideStreak: 4 }

test('v104 formal prediction preserves the approved shadow main calculation and enables formal visibility with inherited side outputs', async () => {
  const module = await import('../src/v104-formal-strategy.js').catch(() => ({}))
  assert.equal(typeof module.buildV104FormalPrediction, 'function', 'v104 formal strategy module must exist')

  const shadow = buildV104ShadowPrediction(table, history, issuanceContext)
  const formal = module.buildV104FormalPrediction(table, history, issuanceContext)

  assert.equal(formal.strategyVersion, 'v104')
  assert.equal(formal.releaseVersion, 'v104.0.0-formal.2')
  assert.equal(formal.predictedResult, shadow.predictedResult)
  assert.equal(formal.confidence, shadow.confidence)
  assert.deepEqual(formal.scoreSources, shadow.scoreSources)
  assert.deepEqual(formal.scoreTotals, shadow.scoreTotals)
  assert.deepEqual(formal.featureWeights, shadow.featureWeights)
  assert.equal(formal.shadowOnly, false)
  assert.equal(formal.activationEligible, true)
  assert.equal(formal.memberVisible, true)
  assert.equal(formal.writesSideActions, true)
  assert.equal(typeof formal.sidePredictions.tie, 'number')
  assert.equal(typeof formal.sideActions.tie, 'boolean')
  assert.deepEqual(formal.predictionFeatures.v104_main_policy.diagnostics.direction, shadow.diagnostics.direction)
  assert.equal('v102_main_signal_dedup' in formal.predictionFeatures, false)
  assert.equal(typeof formal.predictionFeatures.v104_side_policy, 'object')
  assert.equal('v102_side_policy' in formal.predictionFeatures, false)
})
