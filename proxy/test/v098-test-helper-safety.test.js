import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPredictionResultRow } from './helpers/prediction-result.js'

const completed = { tableId: 'BAG01', shoe: 8, round: 21, winner: 'banker' }

test('v098 historical prediction helper requires an explicit matching pre-result table identity', () => {
  assert.throws(() => buildPredictionResultRow(completed, { tableId: 'BAG01' }), /explicit pre-result table/)
  assert.throws(() => buildPredictionResultRow(completed, { tableId: 'BAG01', shoe: 8, round: 21 }), /explicit pre-result table/)

  const row = buildPredictionResultRow(completed, { tableId: 'BAG01', shoe: 8, round: 20, bankerCount: 10, playerCount: 9 })
  assert.deepEqual([row.table_id, row.shoe_no, row.round_no], ['BAG01', '8', 21])
})
