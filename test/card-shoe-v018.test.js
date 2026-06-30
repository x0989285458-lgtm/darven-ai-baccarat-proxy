import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildRoundCardSnapshot,
  createShoeTracker,
  scoreCardShoeInfluence,
} from '../src/card-shoe.js'

test('v019 parses each baccarat card into code rank face and baccarat point', () => {
  const snapshot = buildRoundCardSnapshot({ rawResult: [26, 20, 39, 23, 14, 0, -1, -1, 1, 7], winner: 2 })

  assert.deepEqual(snapshot.playerCards.map((card) => card && [card.code, card.rank, card.face, card.baccaratPoint]), [
    [26, 13, 'K', 0],
    [39, 13, 'K', 0],
    [14, 1, 'A', 1],
  ])
  assert.deepEqual(snapshot.bankerCards.map((card) => card && [card.code, card.rank, card.face, card.baccaratPoint]), [
    [20, 7, '7', 7],
    [23, 10, '10', 0],
    null,
  ])
  assert.equal(snapshot.playerPoint, 1)
  assert.equal(snapshot.bankerPoint, 7)
  assert.equal(snapshot.pointDiff, 6)
  assert.equal(snapshot.playerDrew, true)
  assert.equal(snapshot.bankerDrew, false)
})

test('v019 tracks remaining A-K ranks and 0-9 baccarat points per table shoe', () => {
  const tracker = createShoeTracker({ deckCount: 8 })
  const first = tracker.recordRound({ tableId: 'BAG03', shoe: 912, round: 43, rawResult: [26, 20, 39, 23, 14, 0, -1, -1, 1, 7], winner: 2 })

  assert.equal(first.remainingRankCounts.K, 30)
  assert.equal(first.remainingRankCounts.A, 31)
  assert.equal(first.remainingRankCounts['7'], 31)
  assert.equal(first.remainingRankCounts['10'], 31)
  assert.equal(first.seenRankCounts.K, 2)
  assert.equal(first.remainingPointCounts['0'], 125)
  assert.equal(first.remainingPointCounts['1'], 31)
  assert.equal(first.cardsSeenTotal, 5)
  assert.equal(first.cardsRemainingTotal, 411)

  const second = tracker.recordRound({ tableId: 'BAG03', shoe: 913, round: 1, rawResult: [1, 4, 42, 52, 1, 0, -1, -1, 5, 4], winner: 1 })
  assert.equal(second.remainingRankCounts.A, 30)
  assert.equal(second.cardsSeenTotal, 5)
})

test('v019 scores card and shoe features for main and side prediction weighting', () => {
  const tracker = createShoeTracker({ deckCount: 8 })
  const shoeState = tracker.recordRound({ tableId: 'BAG03', shoe: 912, round: 43, rawResult: [26, 20, 39, 23, 14, 0, -1, -1, 1, 7], winner: 2 })
  const score = scoreCardShoeInfluence({
    lastRound: {
      playerPoint: 1,
      bankerPoint: 7,
      rawResult: [26, 20, 39, 23, 14, 0, -1, -1, 1, 7],
      winner: 2,
    },
    shoeState,
  })

  assert.ok(score.main.banker > score.main.player)
  assert.ok(score.side.superSix >= 0)
  assert.ok(score.side.bankerDragon > 0)
  assert.ok(score.side.bankerPair >= 0)
  assert.equal(typeof score.features.remainingPointCounts['0'], 'number')
})
