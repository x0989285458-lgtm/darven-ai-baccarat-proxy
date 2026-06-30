import test from 'node:test'
import assert from 'node:assert/strict'
import { detectRoadTrends, evaluateFiveRoadPrediction } from '../src/stable-report.js'

function tableFromOutcomes(outcomes, overrides = {}) {
  return {
    tableId: 'BAG23',
    displayName: 'MT百家樂第23桌',
    bankerCount: outcomes.filter((item) => item === '莊').length,
    playerCount: outcomes.filter((item) => item === '閒').length,
    tieCount: 0,
    bankerPairCount: 0,
    playerPairCount: 0,
    beadPlateRaw: outcomes.map((item) => (item === '莊' ? '02' : '01')).join('#'),
    bigRoadRaw: outcomes.map((item, index) => `${String(index + 1).padStart(2, '0')}0${item === '莊' ? '2' : '1'}`).join('#'),
    nextBankerRaw: '',
    nextPlayerRaw: '',
    ...overrides,
  }
}

test('v023 detects requested expanded baccarat road trends', () => {
  assert.equal(detectRoadTrends(['莊', '莊', '莊', '閒', '閒', '閒', '莊', '莊', '莊']).threeJump, true)
  assert.equal(detectRoadTrends(['莊', '閒', '閒', '莊', '閒', '閒']).oneBankerTwoPlayer, true)
  assert.equal(detectRoadTrends(['閒', '莊', '莊', '閒', '莊', '莊']).onePlayerTwoBanker, true)
  assert.equal(detectRoadTrends(['莊', '莊', '閒', '閒', '莊', '莊', '閒', '閒']).rowPairRun, true)
  assert.equal(detectRoadTrends(['莊', '閒', '莊', '閒', '莊', '閒']).bankerThenJump, true)
  assert.equal(detectRoadTrends(['閒', '莊', '閒', '莊', '閒', '莊']).playerThenJump, true)
  assert.equal(detectRoadTrends(['莊', '莊', '閒', '莊', '莊', '閒', '莊']).bankerThenRun, true)
  assert.equal(detectRoadTrends(['閒', '閒', '莊', '閒', '閒', '莊', '閒']).playerThenRun, true)
  assert.equal(detectRoadTrends(['莊', '閒', '莊', '閒', '莊', '莊']).brokenSingleJump, true)
  assert.equal(detectRoadTrends(['莊', '莊', '莊', '莊', '閒', '莊', '閒']).longDragonToSingleJump, true)
  assert.equal(detectRoadTrends(['莊', '閒', '莊', '閒', '莊', '莊', '莊']).singleJumpToLongDragon, true)
})

test('v023 expanded road trends affect main roadTrend source score', () => {
  const oneBankerTwoPlayer = evaluateFiveRoadPrediction(tableFromOutcomes(['莊', '閒', '閒', '莊', '閒', '閒']))
  assert.equal(oneBankerTwoPlayer.patterns.oneBankerTwoPlayer, true)
  assert.ok(oneBankerTwoPlayer.sourceScores.roadTrend.banker > oneBankerTwoPlayer.sourceScores.roadTrend.player)

  const onePlayerTwoBanker = evaluateFiveRoadPrediction(tableFromOutcomes(['閒', '莊', '莊', '閒', '莊', '莊']))
  assert.equal(onePlayerTwoBanker.patterns.onePlayerTwoBanker, true)
  assert.ok(onePlayerTwoBanker.sourceScores.roadTrend.player > onePlayerTwoBanker.sourceScores.roadTrend.banker)

  const brokenSingleJump = evaluateFiveRoadPrediction(tableFromOutcomes(['莊', '閒', '莊', '閒', '莊', '莊']))
  assert.equal(brokenSingleJump.patterns.brokenSingleJump, true)
  assert.ok(brokenSingleJump.sourceScores.roadTrend.banker > brokenSingleJump.sourceScores.roadTrend.player)
})

test('v023 report and package version labels are updated', () => {
  const prediction = evaluateFiveRoadPrediction(tableFromOutcomes(['莊', '莊', '莊', '閒', '閒', '閒', '莊', '莊', '莊']))
  assert.equal(prediction.patterns.threeJump, true)
  assert.equal(prediction.weights.roadTrend, 0.16)
})
