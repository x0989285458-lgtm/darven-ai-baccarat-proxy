import test from 'node:test'
import assert from 'node:assert/strict'
import { SIDE_PREDICTION_THRESHOLDS, SIDE_PREDICTION_ACTION_RATE_TARGETS, buildPredictionResultRow } from '../src/supabase-writer.js'

test('v069 disables banker/player dragon predictions from side actions and action-rate targets', () => {
  assert.equal(SIDE_PREDICTION_THRESHOLDS.bankerDragon, 101)
  assert.equal(SIDE_PREDICTION_THRESHOLDS.playerDragon, 101)
  assert.equal(SIDE_PREDICTION_ACTION_RATE_TARGETS.bankerDragon, 0)
  assert.equal(SIDE_PREDICTION_ACTION_RATE_TARGETS.playerDragon, 0)
})

test('v069 prediction row still records dragon scores for learning but never actions them', () => {
  const row = buildPredictionResultRow(
    { tableId: 'BAG69', shoe: 1, round: 1, rawResult: [1, 10, 2, 11, -1, -1, -1, -1, 3, 0], winner: 'banker' },
    { tableId: 'BAG69', bankerCount: 80, playerCount: 1, tieCount: 0, bankerPairCount: 0, playerPairCount: 0, beadPlateRaw: '02#02#02#02#02', bigRoadRaw: 'B#B#B#B#B' },
  )
  assert.equal(row.strategy_version, 'v070_side_thresholds_snapshot_guard')
  assert.equal(typeof row.prediction_features.side_predictions.bankerDragon, 'number')
  assert.equal(row.prediction_features.side_actions.bankerDragon, false)
  assert.equal(row.prediction_features.side_actions.playerDragon, false)
  assert.equal(row.prediction_features.side_tuning.bankerDragon.targetActionRate, 0)
  assert.equal(row.prediction_features.side_tuning.playerDragon.targetActionRate, 0)
})
