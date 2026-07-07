import test from 'node:test'
import assert from 'node:assert/strict'
import { SIDE_PREDICTION_THRESHOLDS, SIDE_PREDICTION_ACTION_RATE_TARGETS, buildPredictionResultRow } from '../src/supabase-writer.js'

test('v071 enables banker/player dragon predictions with action-rate targets', () => {
  assert.equal(SIDE_PREDICTION_THRESHOLDS.bankerDragon, 20)
  assert.equal(SIDE_PREDICTION_THRESHOLDS.playerDragon, 20)
  assert.equal(SIDE_PREDICTION_ACTION_RATE_TARGETS.bankerDragon, 0.08)
  assert.equal(SIDE_PREDICTION_ACTION_RATE_TARGETS.playerDragon, 0.08)
})

test('v071 prediction row records and can action dragon predictions', () => {
  const row = buildPredictionResultRow(
    { tableId: 'BAG69', shoe: 1, round: 1, rawResult: [1, 10, 2, 11, -1, -1, -1, -1, 3, 0], winner: 'banker' },
    { tableId: 'BAG69', bankerCount: 80, playerCount: 1, tieCount: 0, bankerPairCount: 0, playerPairCount: 0, beadPlateRaw: '02#02#02#02#02', bigRoadRaw: 'B#B#B#B#B' },
  )
  assert.equal(row.strategy_version, 'v081_五路問路路單走勢主副預測版')
  assert.equal(typeof row.prediction_features.side_predictions.bankerDragon, 'number')
  assert.equal(row.prediction_features.side_tuning.bankerDragon.targetActionRate, 0.08)
  assert.equal(row.prediction_features.side_tuning.playerDragon.targetActionRate, 0.08)
}
)
