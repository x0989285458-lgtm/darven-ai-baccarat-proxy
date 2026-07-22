import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SHADOW_HEAD_KEYS,
  V104_ITERATION_SHADOW_HEAD_SOURCES,
  V104_ITERATION_SHADOW_RELEASE,
  V104_ITERATION_SHADOW_MAIN_WEIGHTS,
  V104_ITERATION_SHADOW_PLAYER_PAIR_WEIGHTS,
  V104_ITERATION_SHADOW_THRESHOLDS,
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

test('v4 shadow freezes each head to the highest observed version while preserving thresholds', () => {
  assert.equal(V104_ITERATION_SHADOW_VERSION, 'v104-seven-head-shadow-v4-best-observed-heads')
  assert.equal(V104_ITERATION_SHADOW_RELEASE, 'v104.4.0-seven-head-shadow.4')
  assert.deepEqual(V104_ITERATION_SHADOW_THRESHOLDS, {
    ...SIDE_PREDICTION_THRESHOLDS,
    playerPair: 41,
  })
  assert.deepEqual(V104_ITERATION_SHADOW_MAIN_WEIGHTS, {
    roadmap_trend_signals: 0.275,
    ask_road_signals: 0.275,
    shoe_banker_player_bias: 0.35,
    neutral_reserve: 0.10,
  })
  assert.deepEqual(V104_ITERATION_SHADOW_PLAYER_PAIR_WEIGHTS, {
    pair_risk: 0.25,
    shoe_stage: 0.15,
    player_pair_count: 0.20,
    table_side_history: 0.20,
    remaining_rank_pressure: 0.20,
  })
  assert.deepEqual(V104_ITERATION_SHADOW_HEAD_SOURCES, {
    main: 'v1', tie: 'v3', superSix: 'v1', bankerDragon: 'v1',
    playerDragon: 'v1', bankerPair: 'v3', playerPair: 'v2',
  })
  assert.deepEqual(SHADOW_HEAD_KEYS, ['main','tie','superSix','bankerDragon','playerDragon','bankerPair','playerPair'])
  assert.deepEqual(frozenWeightKeys.main, Object.keys(V104_ITERATION_SHADOW_MAIN_WEIGHTS))
  assert.deepEqual(frozenWeightKeys.playerPair, Object.keys(V104_ITERATION_SHADOW_PLAYER_PAIR_WEIGHTS))
  for (const key of SHADOW_HEAD_KEYS.slice(1).filter((key) => key !== 'playerPair')) {
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
  assert.deepEqual(prediction.heads.main.weights, V104_ITERATION_SHADOW_MAIN_WEIGHTS)
  assert.equal(prediction.heads.main.sourceVersion, V104_ITERATION_SHADOW_HEAD_SOURCES.main)
  assert.deepEqual(prediction.heads.playerPair.weights, V104_ITERATION_SHADOW_PLAYER_PAIR_WEIGHTS)
  assert.deepEqual(Object.keys(prediction.heads.playerPair.featureValues), Object.keys(V104_ITERATION_SHADOW_PLAYER_PAIR_WEIGHTS))
  for (const key of SHADOW_HEAD_KEYS.slice(1)) {
    assert.equal(prediction.heads[key].sourceVersion, V104_ITERATION_SHADOW_HEAD_SOURCES[key])
    assert.equal(prediction.heads[key].threshold, V104_ITERATION_SHADOW_THRESHOLDS[key])
    assert.equal(prediction.heads[key].action, prediction.heads[key].confidence >= V104_ITERATION_SHADOW_THRESHOLDS[key])
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
