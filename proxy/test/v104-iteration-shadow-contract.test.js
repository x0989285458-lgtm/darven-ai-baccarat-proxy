import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SHADOW_HEAD_KEYS,
  V104_ITERATION_SHADOW_VERSION,
  buildV104IterationShadowPrediction,
  buildV104IterationShadowSettlement,
  confidenceToMainUnits,
  confidenceToSideUnits,
  frozenWeightKeys,
} from '../src/v104-iteration-shadow-contract.js'
import { SIDE_PREDICTION_THRESHOLDS, SIDE_PREDICTION_WEIGHT_PROFILES } from '../src/supabase-writer.js'
import { V104_DIRECTION_WEIGHTS } from '../src/v104-main-contract.js'

const table = {
  tableId: 'BAG01', shoe: '700', round: 20,
  bankerCount: 12, playerCount: 8, tieCount: 2,
  bankerPairCount: 2, playerPairCount: 2,
  beadPlateRaw: '010201020102', bigRoadRaw: 'B#P#B#P',
  cardShoe: { rankDataAvailable: true, deckCount: 8, remainingRankCounts: Object.fromEntries(['A','2','3','4','5','6','7','8','9','10','J','Q','K'].map((x) => [x, 30])) },
  v102RankLedger: { rankDataAvailable: true, remainingRankCounts: Object.fromEntries(['A','2','3','4','5','6','7','8','9','10','J','Q','K'].map((x) => [x, 30])) },
}

test('seven-head shadow freezes exact existing weight content and strategy identity', () => {
  assert.equal(V104_ITERATION_SHADOW_VERSION, 'v104-seven-head-shadow-v1')
  assert.deepEqual(SHADOW_HEAD_KEYS, ['main','tie','superSix','bankerDragon','playerDragon','bankerPair','playerPair'])
  assert.deepEqual(frozenWeightKeys.main, Object.keys(V104_DIRECTION_WEIGHTS))
  for (const key of SHADOW_HEAD_KEYS.slice(1)) {
    assert.deepEqual(frozenWeightKeys[key], Object.keys(SIDE_PREDICTION_WEIGHT_PROFILES[key]).filter((name) => SIDE_PREDICTION_WEIGHT_PROFILES[key][name] > 0))
  }
})

test('main and side confidence map to bounded rounded units without tiers', () => {
  assert.equal(confidenceToMainUnits(30), 1)
  assert.equal(confidenceToMainUnits(50), 1)
  assert.equal(confidenceToMainUnits(55), 2)
  assert.equal(confidenceToMainUnits(60), 3)
  assert.equal(confidenceToMainUnits(70), 5)
  assert.equal(confidenceToMainUnits(100), 5)
  assert.equal(confidenceToSideUnits(29, 30), 0)
  assert.equal(confidenceToSideUnits(30, 30), 1)
  assert.equal(confidenceToSideUnits(100, 30), 10)
})

test('six side heads act independently at their existing thresholds without main-direction gates', () => {
  const prediction = buildV104IterationShadowPrediction(table)
  assert.equal(prediction.shadowOnly, true)
  assert.equal(prediction.activationEligible, false)
  assert.equal(prediction.memberVisible, false)
  assert.equal(prediction.writesSideActions, false)
  assert.match(prediction.heads.main.predictedResult, /^(banker|player)$/)
  for (const key of SHADOW_HEAD_KEYS.slice(1)) {
    assert.equal(prediction.heads[key].threshold, SIDE_PREDICTION_THRESHOLDS[key])
    assert.equal(prediction.heads[key].action, prediction.heads[key].confidence >= SIDE_PREDICTION_THRESHOLDS[key])
  }
  if (prediction.heads.bankerDragon.confidence >= SIDE_PREDICTION_THRESHOLDS.bankerDragon
      && prediction.heads.playerDragon.confidence >= SIDE_PREDICTION_THRESHOLDS.playerDragon) {
    assert.equal(prediction.heads.bankerDragon.action, true)
    assert.equal(prediction.heads.playerDragon.action, true)
  }
})

test('Final settlement handles main tie PUSH and exact MT fixed/weighted net units', () => {
  const issued = buildV104IterationShadowPrediction(table)
  const settlement = buildV104IterationShadowSettlement({
    tableId: 'BAG01', shoe: '700', round: 21, sourceAction: 'summary',
    rawResult: [1, 2, 3, 4, 0, 0, -1, -1, 4, 4], winner: 3,
  }, { ...issued, predictionId: 'pid-1', issuedAt: '2026-07-21T00:00:00Z' })
  assert.equal(settlement.actualResult, 'tie')
  assert.equal(settlement.headResults.main.status, 'push')
  assert.equal(settlement.headResults.main.fixedNetUnits, 0)
  assert.equal(settlement.headResults.main.weightedNetUnits, 0)
  assert.deepEqual(settlement.actualFacts.playerCardRanks, [1, 3])
  assert.deepEqual(settlement.actualFacts.bankerCardRanks, [2, 4])
})

test('settlement rejects provisional show_poker and mismatched immutable identity', () => {
  const issued = { ...buildV104IterationShadowPrediction(table), predictionId: 'pid-1', issuedAt: '2026-07-21T00:00:00Z' }
  const round = { tableId: 'BAG01', shoe: '700', round: 21, sourceAction: 'show_poker', rawResult: [1,2,3,4,0,0,-1,-1,4,4], winner: 3 }
  assert.throws(() => buildV104IterationShadowSettlement(round, issued), /verified Final/)
  assert.throws(() => buildV104IterationShadowSettlement({ ...round, sourceAction: 'summary', round: 22 }, issued), /identity mismatch/)
})
