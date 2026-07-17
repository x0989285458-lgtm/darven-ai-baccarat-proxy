import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SIDE_WEIGHT_KEYS,
  SIDE_PREDICTION_WEIGHT_PROFILES,
  SIDE_PREDICTION_ACTION_RATE_TARGETS,
} from '../src/supabase-writer.js'
import { buildPredictionResultRow } from './helpers/prediction-result.js'

const sideKeys = ['tie', 'superSix', 'bankerPair', 'playerPair', 'bankerDragon', 'playerDragon']

test('v068 side predictions use independent 31-key weight profiles per target, not one merged side profile', () => {
  assert.equal(SIDE_WEIGHT_KEYS.length, 28)
  assert.deepEqual(Object.keys(SIDE_PREDICTION_WEIGHT_PROFILES).sort(), sideKeys.sort())
  for (const key of sideKeys) {
    assert.equal(Object.keys(SIDE_PREDICTION_WEIGHT_PROFILES[key]).length, 28)
    assert.deepEqual(Object.keys(SIDE_PREDICTION_WEIGHT_PROFILES[key]).sort(), [...SIDE_WEIGHT_KEYS].sort())
    assert.equal(Number(Object.values(SIDE_PREDICTION_WEIGHT_PROFILES[key]).reduce((a, b) => a + b, 0).toFixed(10)), 1)
  }
  assert.notDeepEqual(SIDE_PREDICTION_WEIGHT_PROFILES.tie, SIDE_PREDICTION_WEIGHT_PROFILES.superSix)
  assert.notDeepEqual(SIDE_PREDICTION_WEIGHT_PROFILES.bankerPair, SIDE_PREDICTION_WEIGHT_PROFILES.bankerDragon)
})

test('v068 side action-rate targets are independent and match requested per-100 rates', () => {
  assert.deepEqual(SIDE_PREDICTION_ACTION_RATE_TARGETS, {
    tie: 0.15,
    superSix: 0.10,
    bankerPair: 0.20,
    playerPair: 0.20,
    bankerDragon: 0.08,
    playerDragon: 0.08,
  })
})

test('v068 prediction row persists per-target side weights and tuning metadata', () => {
  const row = buildPredictionResultRow(
    { tableId: 'BAG68', shoe: 1, round: 1, rawResult: [1, 9, 2, 10, 0, 0, -1, -1, 1, 9], winner: 'banker' },
    { tableId: 'BAG68', shoe: 1, round: 0, bankerCount: 40, playerCount: 35, tieCount: 5, bankerPairCount: 3, playerPairCount: 2, beadPlateRaw: '02#01#02#02#01', bigRoadRaw: 'B#P#B#B#P' },
  )
  assert.equal(row.strategy_version, 'v100')
  assert.deepEqual(Object.keys(row.prediction_features.side_weights).sort(), sideKeys.sort())
  assert.equal(Object.keys(row.prediction_features.side_weights.tie).length, 28)
  assert.equal(row.prediction_features.side_tuning.tie.targetActionRate, 0.15)
  assert.equal(row.prediction_features.side_tuning.bankerDragon.targetHitRate, 0.5)
})
