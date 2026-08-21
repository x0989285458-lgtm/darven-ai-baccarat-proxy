import test from 'node:test'
import assert from 'node:assert/strict'
import { buildV105FormalPrediction } from '../src/v105-formal-strategy.js'
import { buildV105ShadowV10Prediction } from '../src/v105-shadow-v10-contract.js'
import { buildV106FormalPrediction, V106_FORMAL_RELEASE_VERSION, V106_FORMAL_STRATEGY_VERSION } from '../src/v106-formal-strategy.js'

const SIDE_KEYS = ['tie', 'superSix', 'bankerPair', 'playerPair', 'bankerDragon', 'playerDragon']
const table = {
  tableId: 'BAG01', shoe: '106', round: 20,
  bankerCount: 12, playerCount: 8, tieCount: 1,
  bigRoadRaw: 'B#P,P#B,B#P#B,B#P,P',
  beadPlateRaw: '02010102020102020101',
  nextBankerRaw: { big: 'B#P', bead_plate: 'malformed-banker-alias' },
  nextPlayerRaw: { big: 'B#P', bead: 'malformed-player-alias' },
}

const mainProjection = (prediction) => ({
  predictedResult: prediction.predictedResult,
  confidence: prediction.confidence,
  probabilities: prediction.probabilities,
  featureWeights: prediction.featureWeights,
  scoreSources: prediction.scoreSources,
  scoreTotals: prediction.scoreTotals,
})

test('v106 formal identity promotes the exact V10 main projection without shadow visibility fields', () => {
  assert.equal(V106_FORMAL_STRATEGY_VERSION, 'v106')
  assert.equal(V106_FORMAL_RELEASE_VERSION, 'v106.0.0-formal.44')
  const expected = buildV105ShadowV10Prediction(table)
  const actual = buildV106FormalPrediction(table)
  assert.equal(expected.structureDiagnostics.eligible, true)
  assert.equal(actual.strategyVersion, 'v106')
  assert.equal(actual.buildVersion, 'v106')
  assert.equal(actual.predictedResult, expected.predictedResult)
  assert.equal(actual.confidence, expected.confidence)
  assert.equal(actual.probabilities.banker + actual.probabilities.player, 100)
  assert.ok(actual.probabilities[actual.predictedResult] > actual.probabilities[actual.predictedResult === 'banker' ? 'player' : 'banker'])
  assert.equal(actual.probabilities.tie, buildV105FormalPrediction(table).probabilities.tie)
  assert.deepEqual(actual.featureWeights, expected.featureWeights)
  assert.deepEqual(actual.scoreSources, expected.scoreSources)
  assert.deepEqual(actual.scoreTotals, expected.scoreTotals)
  assert.deepEqual(actual.structureDiagnostics, expected.structureDiagnostics)
  assert.equal('shadowOnly' in actual, false)
  assert.equal('memberVisible' in actual, false)
  assert.equal('releaseCandidate' in actual, false)
})

test('v106 formal preserves all six v105 formal side outputs exactly under adversarial input', () => {
  const adversarial = {
    ...table,
    tieCount: 999, bankerPairCount: -4, playerPairCount: 123,
    bankerPoint: 0, playerPoint: 9, bankerNatural: false, playerNatural: true,
    v102RankLedger: { status: 'broken', rankDataAvailable: false, remainingRankCounts: { A: -99 } },
  }
  const v105 = buildV105FormalPrediction(adversarial)
  const v106 = buildV106FormalPrediction(adversarial)
  for (const key of SIDE_KEYS) assert.deepEqual(v106.sidePredictions[key], v105.sidePredictions[key], key)
})

test('v106 complete main projection is invariant to nested bead aliases', () => {
  const variants = [
    table,
    { ...table, beadPlateRaw: '', nested: { bead_plate2: 'x' } },
    { ...table, beadPlateRaw: 'contradiction', nested: [{ beadPlate: 'y' }, { bead_plate_raw: 'z' }] },
  ]
  const project = (prediction) => ({
    predictedResult: prediction.predictedResult, confidence: prediction.confidence,
    featureWeights: prediction.featureWeights, scoreSources: prediction.scoreSources,
    scoreTotals: prediction.scoreTotals, structureDiagnostics: prediction.structureDiagnostics,
  })
  const expected = project(buildV106FormalPrediction(variants[0]))
  for (const variant of variants.slice(1)) assert.deepEqual(project(buildV106FormalPrediction(variant)), expected)
})

test('v106 missing, malformed, or ineligible big road preserves the exact v105 formal main projection', () => {
  for (const bigRoadRaw of ['', 'B#P#INVALID', 'B#P#B#P']) {
    const source = { ...table, bigRoadRaw }
    const prediction = buildV106FormalPrediction(source)
    const predecessor = buildV105FormalPrediction(source)
    assert.equal(prediction.structureDiagnostics.eligible, false)
    assert.deepEqual(mainProjection(prediction), mainProjection(predecessor))
  }
})

test('v106 ineligible fallback maps successor history into the v105 calibration contract', () => {
  const source = { ...table, bigRoadRaw: 'B#P#B#P' }
  const predecessorHistory = Array.from({ length: 20 }, (_, index) => ({
    table_id: 'BAG01', strategy_version: 'v105', prediction_timing: 'pre_result_context',
    prediction_issued_at: `2026-08-18T00:${String(index).padStart(2, '0')}:00Z`, settlement_final: true,
    predicted_result: 'banker', actual_result: 'banker', settlement_status: 'hit',
  }))
  const successorHistory = predecessorHistory.map((row) => ({ ...row, strategy_version: 'v106' }))
  const expected = buildV105FormalPrediction(source, predecessorHistory)
  const actual = buildV106FormalPrediction(source, successorHistory)
  assert.equal(actual.structureDiagnostics.eligible, false)
  assert.deepEqual(mainProjection(actual), mainProjection(expected))
})
