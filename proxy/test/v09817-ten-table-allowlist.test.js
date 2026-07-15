import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCloudCapturePayload } from '../src/cloud-capture.js'

const EXPECTED_TABLE_IDS = ['BAG01', 'BAG02', 'BAG03', 'BAG03A', 'BAG05', 'BAG06', 'BAG07', 'BAG08', 'BAG09', 'BAG10']

test('v098.17 canonicalizes proxy table and round aliases before filtering and dedupe', () => {
  const parsed = parseCloudCapturePayload({
    tables: [
      { tableId: ' bag01 ', displayName: '1' },
      { tableId: 'BAG3A', displayName: '3A' },
    ],
    rounds: [
      { tableId: 'bag01', shoe: 1, round: 1, winner: 'banker' },
      { table_id: ' BAG3A ', shoe: 1, round: 1, winner: 'player' },
      { tableId: 'BAG03A', shoe: 1, round: 1, winner: 'player' },
    ],
  })

  assert.deepEqual(parsed.tables.map((table) => table.tableId), ['BAG01', 'BAG03A'])
  assert.deepEqual(parsed.rounds.map((round) => round.tableId), ['BAG01', 'BAG03A'])
})

test('v098.17 proxy keeps only the approved ten tables and rounds in the approved order', () => {
  const allTableIds = ['BAG15', 'BAG03A', 'BAG11', 'BAG02', 'BAG13A', 'BAG01', 'BAG12', 'BAG10', 'BAG09', 'BAG08', 'BAG07', 'BAG06', 'BAG05', 'BAG13', 'BAG03', 'BAG03A']
  const parsed = parseCloudCapturePayload({
    connected: true,
    authenticated: true,
    tables: allTableIds.map((tableId) => ({ tableId, tableType: 'BAC', shoe: 1, round: 1 })),
    rounds: allTableIds.map((tableId) => ({ tableId, shoe: 1, round: 1, winner: 'banker' })),
  })

  assert.deepEqual(parsed.tables.map((table) => table.tableId), EXPECTED_TABLE_IDS)
  assert.deepEqual(parsed.rounds.map((round) => round.tableId), [...new Set(allTableIds.filter((tableId) => EXPECTED_TABLE_IDS.includes(tableId)))])
  assert.equal(parsed.status.tableCount, 10)
})
