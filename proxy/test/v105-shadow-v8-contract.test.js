import test from 'node:test'
import assert from 'node:assert/strict'
import { buildV105ShadowPrediction as buildV6 } from '../src/v105-shadow-contract.js'
import {
  V105_SHADOW_V8_VERSION,
  analyzeV105ShadowV8RoadRhythm,
  buildV105ShadowV8Prediction,
  buildV105ShadowV8Settlement,
  decodeV105ShadowV8DerivedRoad,
} from '../src/v105-shadow-v8-contract.js'

const base = (overrides = {}) => ({
  tableId: 'BAG01', shoe: 105, round: 20, bankerCount: 12, playerCount: 8,
  beadPlateRaw: '020102010201', bigRoadRaw: 'B#P',
  ...overrides,
})

const screenshotA = base({
  bigEyeRaw: '2#1,1,1#2,2,2,2,2,2#1,1,1,1#2',
  smallRoadRaw: '1,1#2#1,1#2#1,1,1#2',
  cockroachRaw: '2,2,2,2#1,1,1,1#2',
  nextBankerRaw: {
    big_eye: '2#1,1,1#2,2,2,2,2,2#1,1,1,1#2,2',
    small: '1,1#2#1,1#2#1,1,1#2#1',
    cockroach: '2,2,2,2#1,1,1,1#2,2',
  },
  nextPlayerRaw: {
    big_eye: '2#1,1,1#2,2,2,2,2,2#1,1,1,1#2#1',
    small: '1,1#2#1,1#2#1,1,1#2,2',
    cockroach: '2,2,2,2#1,1,1,1#2#1',
  },
})

const screenshotB = base({
  bigEyeRaw: '2#1,1,1#2,2,2,2,2,2#1,1,1,1#2#1,1#2,2#1,1#2,2#1',
  smallRoadRaw: '1,1#2#1,1#2#1,1,1#2,2#1#2,2,2#1#2,2,2',
  cockroachRaw: '2,2,2,2#1,1,1,1#2#1#2,2#1#2,2,2,2,2',
  nextBankerRaw: {
    big_eye: '2#1,1,1#2,2,2,2,2,2#1,1,1,1#2#1,1#2,2#1,1#2,2#1#2',
    small: '1,1#2#1,1#2#1,1,1#2,2#1#2,2,2#1#2,2,2#1',
    cockroach: '2,2,2,2#1,1,1,1#2#1#2,2#1#2,2,2,2,2#1',
  },
  nextPlayerRaw: {
    big_eye: '2#1,1,1#2,2,2,2,2,2#1,1,1,1#2#1,1#2,2#1,1#2,2#1,1',
    small: '1,1#2#1,1#2#1,1,1#2,2#1#2,2,2#1#2,2,2,2',
    cockroach: '2,2,2,2#1,1,1,1#2#1#2,2#1#2,2,2,2,2,2',
  },
})

test('V8 decoder rejects a same-color horizontal move before the sixth row', () => {
  assert.deepEqual(decodeV105ShadowV8DerivedRoad('2#2'), [])
  assert.deepEqual(decodeV105ShadowV8DerivedRoad('2,2,2#1'), ['2','2','2','1'])
})

test('V8 screenshot A decodes complete runs and produces three banker votes', () => {
  const prediction = buildV105ShadowV8Prediction(screenshotA)
  assert.equal(prediction.strategyVersion, V105_SHADOW_V8_VERSION)
  assert.deepEqual(prediction.askRoadSignal.roads.bigEye.decodedRuns.map(({ color, length }) => [color, length]), [['2',1],['1',3],['2',6],['1',4],['2',1]])
  assert.deepEqual(prediction.askRoadSignal.roads.smallRoad.decodedRuns.map(({ color, length }) => [color, length]), [['1',2],['2',1],['1',2],['2',1],['1',3],['2',1]])
  assert.deepEqual(prediction.askRoadSignal.roads.cockroach.decodedRuns.map(({ color, length }) => [color, length]), [['2',4],['1',4],['2',1]])
  assert.deepEqual(prediction.askRoadSignal.votes, { banker: 3, player: 0, eligible: 3 })
  assert.equal(prediction.askRoadSignal.consensusDirection, 'banker')
  assert.equal(prediction.predictedResult, 'banker')
})

test('V8 screenshot B produces the exact two-player one-banker split', () => {
  const prediction = buildV105ShadowV8Prediction(screenshotB)
  assert.equal(prediction.askRoadSignal.roads.bigEye.vote, 'player')
  assert.equal(prediction.askRoadSignal.roads.smallRoad.vote, 'banker')
  assert.equal(prediction.askRoadSignal.roads.cockroach.vote, 'player')
  assert.deepEqual(prediction.askRoadSignal.votes, { banker: 1, player: 2, eligible: 3 })
  assert.equal(prediction.askRoadSignal.consensusDirection, 'player')
  assert.equal(prediction.predictedResult, 'player')
})

test('V8 road payload keeps full immutable sequence, runs, 6/12/24 windows and phase evidence', () => {
  const prediction = buildV105ShadowV8Prediction(screenshotB)
  const road = prediction.askRoadSignal.roads.bigEye
  assert.equal(road.sequence.length, 24)
  assert.equal(road.windows.near6.length, 6)
  assert.equal(road.windows.near12.length, 12)
  assert.equal(road.windows.background24.length, 24)
  assert.equal(typeof road.pattern.primary, 'string')
  assert.equal(typeof road.currentPhase, 'string')
  assert.equal(road.expectedColor, '1')
  assert.equal(road.bankerNextColor, '2')
  assert.equal(road.playerNextColor, '1')
  assert.equal(road.reason, 'unique_expected_color_match')
  assert.equal(Object.isFrozen(prediction.askRoadSignal), true)
  assert.equal(Object.isFrozen(road.decodedRuns), true)
  assert.throws(() => { road.vote = 'banker' }, TypeError)
})

test('V8 uses all available history when fewer than 24 colors exist', () => {
  const result = analyzeV105ShadowV8RoadRhythm(['1','1','2','1'])
  assert.deepEqual(result.windows.background24, ['1','1','2','1'])
})

test('V8 classifies single jump, double jump, long and short dragons, room rhythms, repeated lengths, and continuous turns', () => {
  const cases = [
    [['1','2','1','2','1'], 'single_jump'],
    [['1','1','2','2','1','1','2','2'], 'double_jump'],
    [['1','1','1','1','1'], 'red_long_dragon'],
    [['2','2','2'], 'blue_short_dragon'],
    [['1','2','2','1','2','2'], 'one_room_one_living'],
    [['1','1','2','2','2','1','1','2','2','2'], 'two_room_one_living'],
    [['1','1','2','1','1','2'], 'repeated_run_lengths'],
    [['1','2','2','1','1','1','2'], 'continuous_turns'],
  ]
  for (const [sequence, expected] of cases) {
    assert.ok(analyzeV105ShadowV8RoadRhythm(sequence).pattern.recognized.includes(expected), expected)
  }
})

test('V8 abstains for same-color, invalid, and ambiguous platform candidates', () => {
  const same = structuredClone(screenshotA)
  same.nextPlayerRaw.big_eye = same.nextBankerRaw.big_eye
  const sameRoad = buildV105ShadowV8Prediction(same).askRoadSignal.roads.bigEye
  assert.equal(sameRoad.vote, null)
  assert.equal(sameRoad.reason, 'candidate_colors_same')

  const invalid = structuredClone(screenshotA)
  invalid.nextBankerRaw.big_eye = '9#1'
  const invalidRoad = buildV105ShadowV8Prediction(invalid).askRoadSignal.roads.bigEye
  assert.equal(invalidRoad.vote, null)
  assert.equal(invalidRoad.reason, 'candidate_not_exact_append')

  const ambiguous = structuredClone(screenshotA)
  ambiguous.bigEyeRaw = '2,2,2,2#1,1,1,1#2#1#2,2'
  const ambiguousRoad = buildV105ShadowV8Prediction(ambiguous).askRoadSignal.roads.bigEye
  assert.equal(ambiguousRoad.expectedColor, null)
  assert.equal(ambiguousRoad.vote, null)
  assert.equal(ambiguousRoad.reason, 'transition_ambiguous')
})

test('V8 retains a clear V6 direction on conflict and records confirmation on agreement', () => {
  const clear = { bigRoadRaw: '0001,0001#0002#0001,0001' }
  const conflict = buildV105ShadowV8Prediction({ ...screenshotB, ...clear })
  assert.equal(conflict.roadPatternSignal.clear, true)
  assert.equal(conflict.roadPatternSignal.direction, 'banker')
  assert.equal(conflict.askRoadSignal.consensusDirection, 'player')
  assert.equal(conflict.askRoadSignal.relationToV6, 'conflict')
  assert.equal(conflict.predictedResult, 'banker')

  const confirmed = buildV105ShadowV8Prediction({ ...screenshotA, ...clear })
  assert.equal(confirmed.askRoadSignal.relationToV6, 'confirmed')
  assert.equal(confirmed.predictedResult, 'banker')
})

test('V8 preserves V6 big-road evidence and all six V5 side predictions', () => {
  const v6 = buildV6(screenshotA)
  const v8 = buildV105ShadowV8Prediction(screenshotA)
  assert.deepEqual(v8.roadPatternSignal, v6.roadPatternSignal)
  assert.deepEqual(v8.roadPatternWindows, v6.roadPatternWindows)
  for (const head of ['tie','superSix','bankerDragon','playerDragon','bankerPair','playerPair']) assert.deepEqual(v8.heads[head], v6.heads[head])
})

test('V8 settlement accepts verified summary/show_win Final and rejects every old identity', () => {
  const prediction = buildV105ShadowV8Prediction(screenshotA)
  for (const sourceAction of ['/summary', '/show_win']) {
    const final = buildV105ShadowV8Settlement({ ...screenshotA, round: 21, sourceAction, winner: 'banker', resolvedAt: '2026-07-27T12:00:00.000Z' }, {
      ...prediction, predictionId: `v8-${sourceAction}`, issuedAt: '2026-07-27T11:59:59.000Z',
    })
    assert.equal(final.strategyVersion, V105_SHADOW_V8_VERSION)
    assert.equal(final.settlementFinal, true)
  }
  for (const strategyVersion of ['v104-seven-head-shadow-v5-best-stage-side-reweight','v105-shadow-v6-road-pattern','v105-shadow-v7-ask-road']) {
    assert.throws(() => buildV105ShadowV8Settlement({ ...screenshotA, round: 21, sourceAction: '/summary', winner: 'banker' }, { ...prediction, strategyVersion }), /v105-shadow-v8-run-length-ask-road identity/i)
  }
})
