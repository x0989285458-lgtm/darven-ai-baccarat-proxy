import test from 'node:test'
import assert from 'node:assert/strict'
import { buildV105FormalPrediction } from '../src/v105-formal-strategy.js'
import { buildV105ShadowV10Prediction } from '../src/v105-shadow-v10-contract.js'
import { buildV105V10MainPrediction, V105_V10_MAIN_RELEASE_VERSION } from '../src/v105-v10-main-strategy.js'

const SIDE_KEYS = ['tie', 'superSix', 'bankerPair', 'playerPair', 'bankerDragon', 'playerDragon']
const table = {
  tableId: 'BAG01', shoe: '105', round: 20,
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

test('V105 identity promotes the exact V10 main projection without changing product namespace', () => {
  const expected = buildV105ShadowV10Prediction(table)
  const actual = buildV105V10MainPrediction(table)
  assert.equal(expected.structureDiagnostics.eligible, true)
  assert.equal(actual.strategyVersion, 'v105')
  assert.equal(actual.buildVersion, 'v105')
  assert.equal(actual.releaseVersion, V105_V10_MAIN_RELEASE_VERSION)
  assert.equal(actual.predictedResult, expected.predictedResult)
  assert.equal(actual.confidence, expected.confidence)
  assert.equal(actual.probabilities.banker + actual.probabilities.player, 100)
  assert.ok(actual.probabilities[actual.predictedResult] > actual.probabilities[actual.predictedResult === 'banker' ? 'player' : 'banker'])
  assert.deepEqual(actual.featureWeights, expected.featureWeights)
  assert.deepEqual(actual.scoreSources, expected.scoreSources)
  assert.deepEqual(actual.scoreTotals, expected.scoreTotals)
  assert.equal('shadowOnly' in actual, false)
  assert.equal('releaseCandidate' in actual, false)
})

test('V105 V10 main preserves every V105 side output', () => {
  const baseline = buildV105FormalPrediction(table)
  const actual = buildV105V10MainPrediction(table)
  for (const key of SIDE_KEYS) assert.deepEqual(actual.sidePredictions[key], baseline.sidePredictions[key], key)
})

test('V105 V10 main is independent from bead plate aliases', () => {
  const variants = [table, { ...table, beadPlateRaw: '', nested: { bead_plate2: 'x' } }, { ...table, beadPlateRaw: 'contradiction', nested: [{ beadPlate: 'y' }] }]
  const project = (prediction) => ({ predictedResult: prediction.predictedResult, confidence: prediction.confidence, featureWeights: prediction.featureWeights, scoreSources: prediction.scoreSources, scoreTotals: prediction.scoreTotals, structureDiagnostics: prediction.structureDiagnostics })
  const expected = project(buildV105V10MainPrediction(variants[0]))
  for (const variant of variants.slice(1)) assert.deepEqual(project(buildV105V10MainPrediction(variant)), expected)
})

test('missing malformed or ineligible big road keeps the exact existing V105 main output', () => {
  for (const bigRoadRaw of ['', 'B#P#INVALID', 'B#P#B#P']) {
    const source = { ...table, bigRoadRaw }
    const actual = buildV105V10MainPrediction(source)
    const baseline = buildV105FormalPrediction(source)
    assert.equal(actual.structureDiagnostics.eligible, false)
    assert.deepEqual(mainProjection(actual), mainProjection(baseline))
  }
})
