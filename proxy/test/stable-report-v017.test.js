import test from 'node:test'
import assert from 'node:assert/strict'
import { createStableReportSession, detectRoadTrends, evaluateFiveRoadPrediction } from '../src/stable-report.js'

function makeTable(overrides = {}) {
  return {
    tableId: 'BAG01',
    displayName: 'MT百家樂第1桌',
    bankerCount: 12,
    playerCount: 8,
    tieCount: 1,
    bankerPairCount: 1,
    playerPairCount: 1,
    beadPlateRaw: '02#01#02#02#02',
    bigRoadRaw: '0102,0202,0302,#0101,#0102,0202',
    nextBankerRaw: '111',
    nextPlayerRaw: '222',
    lastRound: { tableId: 'BAG01', shoe: 1, round: 1, winner: 2 },
    ...overrides,
  }
}

test('v019 detects roadmap trends for main prediction weighting', () => {
  assert.equal(detectRoadTrends(['莊', '閒', '莊', '閒', '莊']).singleJump, true)
  assert.equal(detectRoadTrends(['莊', '莊', '閒', '閒', '莊', '莊']).doubleJump, true)
  assert.deepEqual(detectRoadTrends(['閒', '莊', '莊', '莊', '莊']).longDragon, { side: '莊', length: 4 })
  assert.equal(detectRoadTrends(['莊', '莊', '莊', '閒', '閒', '閒']).doubleDragon, true)
})

test('v019 evaluates five-road weights plus global stats without producing a display-only source table', () => {
  const prediction = evaluateFiveRoadPrediction(makeTable(), { globalStats: { banker: 188, player: 164, tie: 30 } })
  assert.equal(prediction.main, '莊')
  assert.equal(prediction.weights.beadRoad, 0.14)
  assert.equal(prediction.weights.bigRoad, 0.18)
  assert.equal(prediction.weights.bigEyeRoad, 0.10)
  assert.equal(prediction.weights.smallRoad, 0.07)
  assert.equal(prediction.weights.cockroachRoad, 0.07)
  assert.equal(prediction.weights.cardPoints, undefined)
  assert.equal(prediction.weights.shoeRemaining, undefined)
  assert.equal(prediction.weights.roadTrend, 0.16)
  assert.equal(prediction.weights.tablePerformance, 0.10)
  assert.ok(prediction.cardShoeFeatures)
  assert.ok(prediction.sourceScores.roadTrend)
  assert.ok(prediction.sourceScores.bigRoad.banker > prediction.sourceScores.bigRoad.player)
  assert.ok(prediction.confidence >= 30 && prediction.confidence <= 80)
})

test('v019 stable report exposes only main/side hit rates in formatted report while retaining internal weights in JSON', () => {
  const session = createStableReportSession({ startedAt: '2026-01-01T00:00:00.000Z', globalStats: { banker: 188, player: 164, tie: 30 } })
  session.recordSnapshot({ status: { connected: true, authenticated: true, tableCount: 9 }, tables: [makeTable()] }, 't1')
  const report = session.getReport('2026-01-01T00:10:00.000Z')
  assert.equal(report.version, '037')
  assert.equal(report.total.hits, 1)
  assert.equal(report.tables[0].predictionWeights.beadRoad, 0.14)
  assert.equal(report.tables[0].patterns.longDragon.side, '莊')
  assert.equal(report.displayOnly.main, '主副預測命中率')
  assert.equal(report.displayOnly.hideSourceWeightHitRates, true)
})
