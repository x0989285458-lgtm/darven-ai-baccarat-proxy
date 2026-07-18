import test from 'node:test'
import assert from 'node:assert/strict'
import { buildLivePrediction, buildPredictionResultRow } from '../src/supabase-writer.js'

const table = { tableId: 'BAG01', shoe: 88, round: 20, bankerCount: 10, playerCount: 9 }
const completed = { tableId: 'BAG01', shoe: 88, round: 21, winner: 'banker', rawResult: [1, 9, 2, 10, -1, -1, -1, -1, 1, 9] }
const pending = buildLivePrediction(table)

test('prediction row uses the validated target identity when all three completed-round columns match', () => {
  const row = buildPredictionResultRow(completed, { ...table, tableId: 'BAG99', shoe: 999, round: 999 }, pending)
  assert.deepEqual([row.table_id, row.shoe_no, row.round_no], ['BAG01', '88', 21])
})

for (const [name, changedPending] of [
  ['missing table', { ...pending, targetTableId: '' }],
  ['missing shoe', { ...pending, targetShoe: null }],
  ['missing round', { ...pending, targetRound: null }],
  ['wrong table', { ...pending, targetTableId: 'BAG02' }],
  ['wrong shoe', { ...pending, targetShoe: '87' }],
  ['wrong round', { ...pending, targetRound: 22 }],
]) {
  test(`v098 prediction row fails closed for ${name}`, () => {
    assert.equal(buildPredictionResultRow(completed, table, changedPending), null)
  })
}

for (const [name, changedRound] of [
  ['missing completed table', { ...completed, tableId: '' }],
  ['missing completed shoe', { ...completed, shoe: null }],
  ['missing completed round', { ...completed, round: null }],
]) {
  test(`v098 prediction row fails closed for ${name}`, () => {
    assert.equal(buildPredictionResultRow(changedRound, table, pending), null)
  })
}

