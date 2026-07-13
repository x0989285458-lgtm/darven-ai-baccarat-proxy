import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSideActions, SIDE_PREDICTION_THRESHOLDS } from '../src/supabase-writer.js'
import { buildPredictionResultRow } from './helpers/prediction-result.js'

test('v071 banker/player dragon side actions are enabled and gated by matching main prediction', () => {
  assert.equal(SIDE_PREDICTION_THRESHOLDS.bankerDragon < 101, true)
  assert.equal(SIDE_PREDICTION_THRESHOLDS.playerDragon < 101, true)
  const bankerActions = buildSideActions({ bankerDragon: 85, playerDragon: 20, superSix: 0 }, 'banker')
  assert.equal(bankerActions.bankerDragon, true)
  assert.equal(bankerActions.playerDragon, false)
  const playerActions = buildSideActions({ bankerDragon: 20, playerDragon: 85, superSix: 0 }, 'player')
  assert.equal(playerActions.bankerDragon, false)
  assert.equal(playerActions.playerDragon, true)
})

test('v071 side prediction features include A-K remaining-card counts for every target', () => {
  const round = {
    tableId: 'BAG05', shoe: 15396, round: 1, winner: 2,
    rawResult: [26,40,43,20,0,0,-1,-1,4,8],
    cardShoe: {
      remainingRankCounts: { A: 31, '2': 32, '3': 30, '4': 29, '5': 28, '6': 27, '7': 26, '8': 25, '9': 24, '10': 23, J: 22, Q: 21, K: 20 },
      remainingPointCounts: { '0': 86, '1': 31, '2': 32, '3': 30, '4': 29, '5': 28, '6': 27, '7': 26, '8': 25, '9': 24 },
      cardsSeenTotal: 13,
      cardsRemainingTotal: 403,
      shoeProgressRatio: 0.0313,
    },
  }
  const row = buildPredictionResultRow(round, { tableId: 'BAG05', shoe: 15396, round: 1, beadPlateRaw: '0202', bankerCount: 1, playerCount: 0, tieCount: 0 })
  const rankCounts = row.prediction_features.side_card_rank_features.remainingRankCounts
  assert.equal(rankCounts.A, 31)
  assert.equal(rankCounts.K, 20)
  for (const target of ['tie', 'superSix', 'bankerPair', 'playerPair', 'bankerDragon', 'playerDragon']) {
    assert.ok(row.prediction_features.side_prediction_rank_inputs[target])
    assert.equal(row.prediction_features.side_prediction_rank_inputs[target].remainingRankCounts.K, 20)
  }
})
