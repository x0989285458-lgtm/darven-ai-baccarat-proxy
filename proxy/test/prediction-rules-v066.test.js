import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveBaccaratRoundFacts, buildSideActions } from '../src/supabase-writer.js'
import { buildPredictionResultRow } from './helpers/prediction-result.js'

test('v066 super six is actionable only when the main prediction is banker', () => {
  const playerMainActions = buildSideActions({ tie: 0, superSix: 95, bankerPair: 0, playerPair: 0, bankerDragon: 0, playerDragon: 0 }, 'player')
  const bankerMainActions = buildSideActions({ tie: 0, superSix: 95, bankerPair: 0, playerPair: 0, bankerDragon: 0, playerDragon: 0 }, 'banker')

  assert.equal(playerMainActions.superSix, false)
  assert.equal(bankerMainActions.superSix, true)
})

test('v071 dragon bonus predictions are actionable only for matching main side and separated scores', () => {
  const bankerMain = buildSideActions({ tie: 0, superSix: 0, bankerPair: 0, playerPair: 0, bankerDragon: 96, playerDragon: 10 }, 'banker')
  const playerMain = buildSideActions({ tie: 0, superSix: 0, bankerPair: 0, playerPair: 0, bankerDragon: 10, playerDragon: 96 }, 'player')

  assert.equal(bankerMain.bankerDragon, true)
  assert.equal(bankerMain.playerDragon, false)
  assert.equal(playerMain.bankerDragon, false)
  assert.equal(playerMain.playerDragon, true)

  const tiePush = buildPredictionResultRow(
    { tableId: 'BAG66', shoe: 1, round: 3, rawResult: [1, 9, 2, 10, 0, 0, -1, -1, 9, 9], winner: 'tie' },
    { tableId: 'BAG66', shoe: 1, round: 2, bankerCount: 90, playerCount: 10, tieCount: 0, beadPlateRaw: '02#02#02#02#02#02', bigRoadRaw: 'B#B#B#B#B#B' },
  )

  assert.equal(tiePush.prediction_features.side_actual_results.bankerDragon, false)
  assert.equal(tiePush.prediction_features.side_hits.bankerDragon, false)
})

test('v066 pair and tie actuals use exact rank equality and final settlement points', () => {
  const jqNoPair = deriveBaccaratRoundFacts({ rawResult: [11, 11, 12, 24, 0, 0, -1, -1, 0, 0], winner: 'tie' })
  assert.equal(jqNoPair.playerPair, false)
  assert.equal(jqNoPair.bankerPair, true)
  assert.equal(jqNoPair.winner, 'tie')

  const finalTieAfterDraw = deriveBaccaratRoundFacts({ rawResult: [1, 2, 3, 4, 5, 6, -1, -1, 6, 6] })
  assert.equal(finalTieAfterDraw.winner, 'tie')
})
