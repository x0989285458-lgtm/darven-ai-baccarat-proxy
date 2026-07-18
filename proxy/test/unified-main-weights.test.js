import test from 'node:test'
import assert from 'node:assert/strict'
import { MAIN_PREDICTION_WEIGHTS, evaluateFiveRoadPrediction } from '../src/stable-report.js'

test('backend formal prediction uses the same high-hit main weights as frontend', () => {
  assert.deepEqual(MAIN_PREDICTION_WEIGHTS, {
    shoeRoad: 0.30,
    askRoad: 0.18,
    recentTrend: 0.17,
    bankerPlayerStats: 0.13,
    auxiliaryRoads: 0.12,
    beadRoad: 0.10,
  })
})

test('backend prediction exposes unified weight sources for diagnostics', () => {
  const prediction = evaluateFiveRoadPrediction({
    beadPlateRaw: '02#01#02#02',
    bigRoadRaw: '0102,0202,0302,#0101,#0102,0202',
    bankerCount: 31,
    playerCount: 22,
    nextBankerRaw: '111',
    nextPlayerRaw: '222',
  }, { globalStats: { banker: 188, player: 164 } })

  assert.equal(prediction.weights.shoeRoad, 0.30)
  assert.equal(prediction.weights.askRoad, 0.18)
  assert.equal(prediction.weights.recentTrend, 0.17)
  assert.equal(prediction.weights.bankerPlayerStats, 0.13)
  assert.equal(prediction.weights.auxiliaryRoads, 0.12)
  assert.equal(prediction.weights.beadRoad, 0.10)
  assert.ok(prediction.sourceScores.shoeRoad)
  assert.ok(prediction.sourceScores.auxiliaryRoads)
})
