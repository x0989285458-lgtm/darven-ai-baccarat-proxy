import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { buildV105FormalPrediction } from '../src/v105-formal-strategy.js'

const VERSION = 'v105-shadow-v9-weighted-v7-v8'
const SIDE_HEADS = ['tie', 'superSix', 'bankerDragon', 'playerDragon', 'bankerPair', 'playerPair']

const table = {
  tableId: 'BAG01', shoe: 105, round: 20,
  bankerCount: 18, playerCount: 6, tieCount: 1,
  beadPlateRaw: '020102010201', bigRoadRaw: 'B#P',
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
  settledDirectionalPredictionStats: {
    banker: { settledPredictionCount: 20, hitRate: 0.8 },
    player: { settledPredictionCount: 20, hitRate: 0.3 },
  },
}

const predictionHash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

test('V9 has exactly four 35/35/20/10 weights and no neutral reserve', async () => {
  const { V105_SHADOW_V9_WEIGHTS } = await import('../src/v105-shadow-v9-contract.js')
  assert.deepEqual(V105_SHADOW_V9_WEIGHTS, {
    v7RoadCycle: 0.35,
    v8AskRoad: 0.35,
    recentPracticalCalibration: 0.20,
    shoeBankerPlayerBias: 0.10,
  })
  assert.equal(Object.hasOwn(V105_SHADOW_V9_WEIGHTS, 'neutralReserve'), false)
  assert.equal(Object.hasOwn(V105_SHADOW_V9_WEIGHTS, 'neutral_reserve'), false)
  assert.equal(Object.values(V105_SHADOW_V9_WEIGHTS).reduce((sum, weight) => sum + weight, 0), 1)
})

test('V9 signal baseline remains bit-for-bit compatible after retiring predecessor modules', async () => {
  const { buildV105ShadowV9Prediction } = await import('../src/v105-shadow-v9-contract.js')
  const cases = [
    [
      table,
      { priorShoe: 105, priorDirection: 'banker', priorSameSideStreak: 4 },
      '68cfbba66e30895b9533e263f123ce43670f4d494697431e1732fb889a7e7146',
    ],
    [
      { tableId: 'BAG02', shoe: 'S-9', round: 7, bankerCount: 3, playerCount: 4, tieCount: 0, beadPlateRaw: '0102', bigRoadRaw: 'B#P' },
      {},
      'fde3f6b334fbf3b585310edd2d8e0d17fdf5fe30c5792e5cff30794b883b5582',
    ],
    [
      { tableId: 'BAG03', shoe: 3, round: 18, bankerCount: 9, playerCount: 9, tieCount: 1, beadPlateRaw: '0102010201', bigRoadRaw: 'B,B#P,P#B' },
      {},
      'f956ead43f5f7e95acc21ef5efcd9500c94c2311ab02c91d7083fd16d6fdfc78',
    ],
  ]
  for (const [input, context, expected] of cases) {
    assert.equal(predictionHash(buildV105ShadowV9Prediction(input, [], context)), expected)
  }
})

test('V9 carries the formal recent-practical and deduplicated shoe-bias scores unchanged', async () => {
  const { buildV105ShadowV9Prediction } = await import('../src/v105-shadow-v9-contract.js')
  const prediction = buildV105ShadowV9Prediction(table)
  const formal = buildV105FormalPrediction(table)
  assert.deepEqual(prediction.signals.recentPracticalCalibration, formal.scoreSources.recent_practical_calibration)
  assert.deepEqual(prediction.signals.shoeBankerPlayerBias, formal.scoreSources.shoe_banker_player_bias)
})

test('V9 is shadow-only with a unique identity and leaves all six side heads unchanged', async () => {
  const { V105_SHADOW_V9_VERSION, buildV105ShadowV9Prediction } = await import('../src/v105-shadow-v9-contract.js')
  const prediction = buildV105ShadowV9Prediction(table)
  assert.equal(V105_SHADOW_V9_VERSION, VERSION)
  assert.equal(prediction.strategyVersion, VERSION)
  assert.equal(prediction.releaseCandidate, VERSION)
  assert.equal(prediction.shadowOnly, true)
  assert.equal(prediction.activationEligible, false)
  assert.equal(prediction.memberVisible, false)
  assert.equal(prediction.writesSideActions, false)
  for (const head of SIDE_HEADS) {
    assert.equal(prediction.heads[head].key, head)
    assert.equal(prediction.heads[head].action, false)
  }
})

test('V9 exact score tie follows formal v105 direction instead of forcing banker', async () => {
  const { resolveV105ShadowV9Direction } = await import('../src/v105-shadow-v9-contract.js')
  assert.equal(resolveV105ShadowV9Direction({ banker: 0.5, player: 0.5 }, 'player'), 'player')
  assert.equal(resolveV105ShadowV9Direction({ banker: 0.5, player: 0.5 }, 'banker'), 'banker')
  assert.equal(resolveV105ShadowV9Direction({ banker: 0.5001, player: 0.4999 }, 'player'), 'banker')
  assert.equal(resolveV105ShadowV9Direction({ banker: 0.4999, player: 0.5001 }, 'banker'), 'player')
})

test('V9 settlement accepts verified Final only for the V9 identity', async () => {
  const { buildV105ShadowV9Prediction, buildV105ShadowV9Settlement } = await import('../src/v105-shadow-v9-contract.js')
  const prediction = buildV105ShadowV9Prediction(table)
  const issued = { ...prediction, predictionId: 'v9-id', issuedAt: '2026-07-29T01:00:00.000Z' }
  const round = { ...table, round: 21, sourceAction: '/summary', winner: 'banker', rawResult: [1, 9, 2, 10, 0, 0, -1, -1, 3, 9] }
  const settlement = buildV105ShadowV9Settlement(round, issued)
  assert.equal(settlement.strategyVersion, VERSION)
  assert.equal(predictionHash(settlement), '6f38c22001575c4624e9448985e3c80c97b9972611982fbf5c22c80f70fee58c')
  for (const strategyVersion of ['v105-shadow-v6-road-pattern', 'v105-shadow-v7-ask-road', 'v105-shadow-v8-run-length-ask-road']) {
    assert.throws(() => buildV105ShadowV9Settlement(round, { ...issued, strategyVersion }), /V9|identity/i)
  }
})
