import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'
import { buildLivePrediction, buildPredictionResultRow } from '../src/supabase-writer.js'

const table = { tableId: 'BAG01', shoe: 88, round: 20, bankerCount: 18, playerCount: 2, tieCount: 1, beadPlateRaw: '0202', bigRoadRaw: '0202' }
const result = { tableId: 'BAG01', shoe: 88, round: 21, winner: 'banker', rawResult: [1, 9, 2, 10, -1, -1, -1, -1, 1, 9] }

test('v098 immutable pre-result snapshot survives settlement byte-for-byte', () => {
  const pending = buildLivePrediction(table)
  const frozen = structuredClone(pending)
  const row = buildPredictionResultRow(result, { ...table, round: 21, bankerCount: 0 }, pending)
  assert.deepEqual(pending, frozen)
  assert.equal(row.predicted_result, frozen.predictedResult)
  assert.equal(row.confidence, frozen.confidence)
  assert.deepEqual(row.prediction_features.side_predictions, frozen.sidePredictions)
  assert.deepEqual(row.prediction_features.side_actions, frozen.sideActions)
})

test('v098 settlement persist failure retains the same pending snapshot for retry', async () => {
  const seen = []
  const app = createApp({ autoConnect: false, supabaseClient: {
    configured: true, ensureInitialStrategy: async () => {},
    persistRound: async (_round, _table, pending) => { seen.push(structuredClone(pending)); if (seen.length === 1) throw new Error('temporary') },
  } })
  app.state.setTables([table])
  app.state.upsertRoundEvent(result)
  await new Promise((resolve) => setImmediate(resolve))
  app.state.upsertRoundEvent(result)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(seen.length, 2)
  assert.deepEqual(seen[1], seen[0])
})
