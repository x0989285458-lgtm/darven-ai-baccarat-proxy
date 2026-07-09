import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ALL_MT_EQUAL_STRATEGY_VERSION,
  ALL_MT_EQUAL_MAIN_WEIGHTS,
  buildPredictionResultRow,
} from '../src/supabase-writer.js'

const sum = (weights) => Object.values(weights).reduce((acc, value) => acc + Number(value), 0)

test('v077 main weights add requested roadmap and remaining-card aggregate features', () => {
  assert.equal(ALL_MT_EQUAL_STRATEGY_VERSION, 'v088_信心值30到70一致性校正版')
  assert.ok(Math.abs(sum(ALL_MT_EQUAL_MAIN_WEIGHTS) - 1) < 1e-9)
  assert.ok(ALL_MT_EQUAL_MAIN_WEIGHTS.roadmap_trend_signals > 0)
  assert.equal(ALL_MT_EQUAL_MAIN_WEIGHTS.road_structure_signals, 0)
  assert.equal(ALL_MT_EQUAL_MAIN_WEIGHTS.derived_road_structure_signals, 0)
  assert.equal(ALL_MT_EQUAL_MAIN_WEIGHTS.ask_road_signals, 0.05)
  assert.equal(Object.hasOwn(ALL_MT_EQUAL_MAIN_WEIGHTS, 'remaining_zero_to_k_total'), false)
  assert.equal(Object.hasOwn(ALL_MT_EQUAL_MAIN_WEIGHTS, 'pattern_tags'), false)
})

test('v077 prediction features expose Chinese-requested roadmap details and 0-K total aggregate', () => {
  const row = buildPredictionResultRow(
    {
      tableId: 'BAG77', shoe: 77, round: 18, winner: 'banker', rawResult: [1, 14, 2, 15, 0, 0, -1, -1, 3, 6],
      cardShoe: {
        remainingPointCounts: { '0': 128, '1': 31, '2': 30, '3': 29, '4': 28, '5': 27, '6': 40, '7': 32, '8': 33, '9': 34 },
        remainingRankCounts: { A: 31, '2': 30, '3': 29, '4': 28, '5': 27, '6': 40, '7': 32, '8': 33, '9': 34, '10': 35, J: 36, Q: 37, K: 38 },
        cardsSeenTotal: 24,
        cardsRemainingTotal: 392,
        shoeProgressRatio: 0.0577,
      },
    },
    {
      tableId: 'BAG77', shoe: 77, round: 18,
      bankerCount: 9, playerCount: 7, tieCount: 1,
      beadPlateRaw: '020102010201#020102010202#020202',
      bigRoadRaw: '0201010201020201020202',
      bigEyeRaw: '11112222', smallRoadRaw: '111111', cockroachRaw: '222211',
      nextBankerRaw: { big_eye: '111', small: '111', cockroach: '111' },
      nextPlayerRaw: { big_eye: '222', small: '222', cockroach: '222' },
    },
  )
  assert.equal(row.strategy_version, 'v088_信心值30到70一致性校正版')
  const features = row.prediction_features.derived_main_features
  assert.ok(features.roadmapTrendSignals)
  assert.ok(Object.hasOwn(features.roadmapTrendSignals, 'singleJump'))
  assert.ok(Object.hasOwn(features.roadmapTrendSignals, 'doubleJump'))
  assert.ok(Object.hasOwn(features.roadmapTrendSignals, 'longDragon'))
  assert.ok(Object.hasOwn(features.roadmapTrendSignals, 'brokenDragon'))
  assert.ok(Object.hasOwn(features.roadmapTrendSignals, 'shortDragon'))
  assert.ok(Object.hasOwn(features.roadmapTrendSignals, 'turnDragon'))
  assert.ok(Object.hasOwn(features.roadmapTrendSignals, 'slopeRoad'))
  assert.ok(Object.hasOwn(features.roadmapTrendSignals, 'threeRunRoad'))
  assert.ok(Object.hasOwn(features.roadmapTrendSignals, 'fourRunRoad'))
  assert.ok(features.roadStructureSignals)
  assert.ok(features.derivedRoadStructureSignals)
  assert.ok(features.askRoadSignals)
  assert.equal(Object.hasOwn(features, 'remainingZeroToKTotal'), false)
})
