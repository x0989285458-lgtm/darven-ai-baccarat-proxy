import test from 'node:test'
import assert from 'node:assert/strict'
import { buildV105ShadowV9Prediction, V105_SHADOW_V9_WEIGHTS } from '../src/v105-shadow-v9-contract.js'

const VERSION = 'v105-shadow-v10-uncommon-road-structure'
const SIDE_HEADS = ['tie', 'superSix', 'bankerDragon', 'playerDragon', 'bankerPair', 'playerPair']
const baseTable = {
  tableId: 'BAG01', shoe: 105, round: 20,
  bankerCount: 12, playerCount: 8, tieCount: 1,
  beadPlateRaw: '020102010201', bigRoadRaw: 'B#P#B#P#B#P',
}

test('V10 gives 90 percent of V9 weight to the same four signals and 10 percent to structure', async () => {
  const { V105_SHADOW_V10_WEIGHTS } = await import('../src/v105-shadow-v10-contract.js')
  assert.deepEqual(V105_SHADOW_V10_WEIGHTS, {
    v7RoadCycle: 0.315,
    v8AskRoad: 0.315,
    recentPracticalCalibration: 0.18,
    shoeBankerPlayerBias: 0.09,
    uncommonRoadStructure: 0.10,
  })
  assert.equal(Object.values(V105_SHADOW_V10_WEIGHTS).reduce((sum, weight) => sum + weight, 0), 1)
  const scaledV9Weights = Object.values(V105_SHADOW_V9_WEIGHTS).map((weight) => weight * 0.9)
  for (const [index, expected] of [0.315, 0.315, 0.09, 0.18].entries()) {
    assert.ok(Math.abs(scaledV9Weights[index] - expected) <= Number.EPSILON)
  }
})

test('V10 neutral structure preserves V9 direction ordering and exact direction', async () => {
  const { buildV105ShadowV10Prediction } = await import('../src/v105-shadow-v10-contract.js')
  const v9 = buildV105ShadowV9Prediction(baseTable)
  const v10 = buildV105ShadowV10Prediction(baseTable)
  assert.equal(v10.structureDiagnostics.eligible, false)
  assert.deepEqual(v10.scoreSources.uncommonRoadStructure, { banker: 0.5, player: 0.5 })
  assert.equal(Math.sign(v10.scoreTotals.banker - v10.scoreTotals.player), Math.sign(v9.scoreTotals.banker - v9.scoreTotals.player))
  assert.equal(v10.predictedResult, v9.predictedResult)
  assert.equal(v10.v9BaseDirection, v9.predictedResult)
})

test('V10 eligible structure contributes only its ten-percent directional score and persists diagnostics', async () => {
  const { buildV105ShadowV10Prediction } = await import('../src/v105-shadow-v10-contract.js')
  const table = { ...baseTable, beadPlateRaw: '02010102020102020101', bigRoadRaw: 'B#P,P#B,B#P#B,B#P,P' }
  const prediction = buildV105ShadowV10Prediction(table)
  assert.equal(prediction.structureDiagnostics.eligible, true)
  assert.deepEqual(prediction.structureDiagnostics.motifRunLengths, [1, 2, 2])
  assert.deepEqual(prediction.scoreSources.uncommonRoadStructure, { banker: 0.55, player: 0.45 })
  assert.deepEqual(prediction.signals.uncommonRoadStructure, prediction.structureDiagnostics)
  assert.equal(Object.isFrozen(prediction.structureDiagnostics), true)
})

test('V10 exact aggregate tie falls back to the V9 direction', async () => {
  const { resolveV105ShadowV10Direction } = await import('../src/v105-shadow-v10-contract.js')
  assert.equal(resolveV105ShadowV10Direction({ banker: 0.5, player: 0.5 }, 'player'), 'player')
  assert.equal(resolveV105ShadowV10Direction({ banker: 0.5, player: 0.5 }, 'banker'), 'banker')
  assert.equal(resolveV105ShadowV10Direction({ banker: 0.5001, player: 0.4999 }, 'player'), 'banker')
})

test('V10 has an independent identity and preserves all V9 safety flags and six side heads bit-for-bit', async () => {
  const { V105_SHADOW_V10_VERSION, V105_SHADOW_V10_TABLE_IDS, buildV105ShadowV10Prediction } = await import('../src/v105-shadow-v10-contract.js')
  const v9 = buildV105ShadowV9Prediction(baseTable)
  const v10 = buildV105ShadowV10Prediction(baseTable)
  assert.equal(V105_SHADOW_V10_VERSION, VERSION)
  assert.equal(v10.strategyVersion, VERSION)
  assert.equal(v10.releaseCandidate, VERSION)
  assert.deepEqual(V105_SHADOW_V10_TABLE_IDS, ['BAG01', 'BAG02', 'BAG03', 'BAG03A', 'BAG05', 'BAG06', 'BAG07', 'BAG08', 'BAG09', 'BAG10'])
  for (const flag of ['shadowOnly', 'activationEligible', 'memberVisible', 'writesSideActions']) assert.equal(v10[flag], v9[flag])
  for (const head of SIDE_HEADS) assert.deepEqual(v10.heads[head], v9.heads[head])
})

test('V10 settlement accepts verified Final only for the V10 identity', async () => {
  const { buildV105ShadowV10Prediction, buildV105ShadowV10Settlement } = await import('../src/v105-shadow-v10-contract.js')
  const prediction = buildV105ShadowV10Prediction(baseTable)
  const issued = { ...prediction, predictionId: 'v10-id', issuedAt: '2026-08-02T01:00:00.000Z' }
  const round = { ...baseTable, round: 21, sourceAction: '/summary', winner: 'banker', rawResult: [1, 9, 2, 10, 0, 0, -1, -1, 3, 9] }
  assert.equal(buildV105ShadowV10Settlement(round, issued).strategyVersion, VERSION)
  for (const strategyVersion of ['v105-shadow-v8-run-length-ask-road', 'v105-shadow-v9-weighted-v7-v8', 'v105']) {
    assert.throws(() => buildV105ShadowV10Settlement(round, { ...issued, strategyVersion }), /V10|identity/i)
  }
})
