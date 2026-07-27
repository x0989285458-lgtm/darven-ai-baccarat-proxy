import test from 'node:test'
import assert from 'node:assert/strict'
import { buildV105ShadowPrediction as buildV6 } from '../src/v105-shadow-contract.js'
import {
  V105_SHADOW_V7_VERSION,
  buildV105ShadowV7Prediction,
  buildV105ShadowV7Settlement,
} from '../src/v105-shadow-v7-contract.js'

const base = (overrides = {}) => ({
  tableId: 'BAG01', shoe: 105, round: 20,
  bankerCount: 12, playerCount: 8,
  beadPlateRaw: '020102010201', bigRoadRaw: 'B#P#B#P#B#P',
  bigEyeRaw: '1#2#1#2#1#2',
  smallRoadRaw: '2#1#2#1#2#1',
  cockroachRaw: '1#2#1#2#1#2',
  ...overrides,
})

const ask = (direction, { sameColorRoad = null, malformedRoad = null } = {}) => {
  const bankerWins = direction === 'banker'
  const nextBankerRaw = {
    big_eye: `1#2#1#2#1#2#${bankerWins ? '1' : '2'}`,
    small: `2#1#2#1#2#1#${bankerWins ? '2' : '1'}`,
    cockroach: `1#2#1#2#1#2#${bankerWins ? '1' : '2'}`,
  }
  const nextPlayerRaw = {
    big_eye: `1#2#1#2#1#2#${bankerWins ? '2' : '1'}`,
    small: `2#1#2#1#2#1#${bankerWins ? '1' : '2'}`,
    cockroach: `1#2#1#2#1#2#${bankerWins ? '2' : '1'}`,
  }
  if (sameColorRoad) nextPlayerRaw[sameColorRoad] = nextBankerRaw[sameColorRoad]
  if (malformedRoad) nextBankerRaw[malformedRoad] = '9#1#2#1#2#1#2#1'
  return { nextBankerRaw, nextPlayerRaw }
}

test('V7 uses a 2/3 ask-banker consensus when V6 road pattern is unclear', () => {
  const prediction = buildV105ShadowV7Prediction(base({ bigRoadRaw: 'B#P', ...ask('banker', { sameColorRoad: 'cockroach' }) }))
  assert.equal(prediction.strategyVersion, V105_SHADOW_V7_VERSION)
  assert.equal(prediction.predictedResult, 'banker')
  assert.deepEqual(prediction.askRoadSignal.votes, { banker: 2, player: 0, eligible: 2 })
  assert.equal(prediction.askRoadSignal.consensusDirection, 'banker')
  assert.equal(prediction.askRoadSignal.relationToV6, 'override_unclear_v6')
})

test('V7 uses a 2/3 ask-player consensus when V6 road pattern is unclear', () => {
  const prediction = buildV105ShadowV7Prediction(base({ bigRoadRaw: 'B#P', ...ask('player', { sameColorRoad: 'cockroach' }) }))
  assert.equal(prediction.predictedResult, 'player')
  assert.equal(prediction.askRoadSignal.consensusDirection, 'player')
  assert.equal(prediction.askRoadSignal.relationToV6, 'override_unclear_v6')
})

test('V7 gives no vote when banker and player candidates append the same color', () => {
  const prediction = buildV105ShadowV7Prediction(base({ bigRoadRaw: 'B#P', ...ask('banker', { sameColorRoad: 'big_eye' }) }))
  assert.equal(prediction.askRoadSignal.roads.bigEye.candidateDirection, null)
  assert.equal(prediction.askRoadSignal.roads.bigEye.reason, 'candidate_colors_same')
  assert.deepEqual(prediction.askRoadSignal.votes, { banker: 2, player: 0, eligible: 2 })
})

test('V7 rejects a candidate unless it is the exact current sequence plus one color', () => {
  const prediction = buildV105ShadowV7Prediction(base({ bigRoadRaw: 'B#P', ...ask('banker', { malformedRoad: 'big_eye', sameColorRoad: 'cockroach' }) }))
  assert.equal(prediction.askRoadSignal.roads.bigEye.bankerNextColor, null)
  assert.equal(prediction.askRoadSignal.roads.bigEye.candidateDirection, null)
  assert.equal(prediction.askRoadSignal.roads.bigEye.reason, 'candidate_not_exact_append')
  assert.equal(prediction.askRoadSignal.consensusDirection, null)
})

test('V7 falls back bit-for-bit to the V6 direction and six side heads when ask-road data is insufficient', () => {
  const table = base({ bigEyeRaw: '1#2', smallRoadRaw: '', cockroachRaw: '', nextBankerRaw: {}, nextPlayerRaw: {} })
  const v6 = buildV6(table)
  const v7 = buildV105ShadowV7Prediction(table)
  assert.equal(v7.predictedResult, v6.predictedResult)
  assert.equal(v7.askRoadSignal.consensusDirection, null)
  assert.equal(v7.askRoadSignal.relationToV6, 'fallback_v6')
  for (const head of ['tie','superSix','bankerDragon','playerDragon','bankerPair','playerPair']) {
    assert.deepEqual(v7.heads[head], v6.heads[head])
  }
  assert.deepEqual(v7.roadPatternWindows, v6.roadPatternWindows)
})

test('V7 does not reverse a clear V6 road pattern when ask-road conflicts', () => {
  const prediction = buildV105ShadowV7Prediction(base({
    bigRoadRaw: '0001,0001#0002#0001,0001',
    ...ask('player', { sameColorRoad: 'cockroach' }),
  }))
  assert.equal(prediction.roadPatternSignal.clear, true)
  assert.equal(prediction.roadPatternSignal.direction, 'banker')
  assert.equal(prediction.predictedResult, 'banker')
  assert.equal(prediction.askRoadSignal.relationToV6, 'conflict')
})

test('V7 records confirmation when a clear V6 road pattern agrees with ask-road', () => {
  const prediction = buildV105ShadowV7Prediction(base({
    bigRoadRaw: '0001,0001#0002#0001,0001',
    ...ask('banker', { sameColorRoad: 'cockroach' }),
  }))
  assert.equal(prediction.predictedResult, 'banker')
  assert.equal(prediction.askRoadSignal.relationToV6, 'confirmed')
  assert.equal(Object.isFrozen(prediction.askRoadSignal), true)
  assert.throws(() => { prediction.askRoadSignal.consensusDirection = 'player' }, TypeError)
})

test('V7 settlement accepts only verified Final and rejects every old identity', () => {
  const prediction = buildV105ShadowV7Prediction(base())
  const final = buildV105ShadowV7Settlement({
    ...base(), round: 21, sourceAction: '/summary', winner: 'banker', resolvedAt: '2026-07-27T12:00:00.000Z',
  }, { ...prediction, predictionId: 'v7-id', issuedAt: '2026-07-27T11:59:59.000Z' })
  assert.equal(final.strategyVersion, V105_SHADOW_V7_VERSION)
  assert.equal(final.settlementFinal, true)
  for (const strategyVersion of ['v104-seven-head-shadow-v5-best-stage-side-reweight', 'v105-shadow-v6-road-pattern']) {
    assert.throws(() => buildV105ShadowV7Settlement({ ...base(), round: 21, sourceAction: '/show_win', winner: 'banker' }, {
      ...prediction, strategyVersion,
    }), /v105-shadow-v7-ask-road identity/i)
  }
})
