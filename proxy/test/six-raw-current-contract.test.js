import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCloudCapturePayload, PRODUCTION_TABLE_IDS } from '../src/cloud-capture.js'

const SIX_RAW = ['BAV01', 'BAV02', 'BAV03', 'BAV03A', 'BAV05', 'BAV06']
const RETIRED_OR_UNKNOWN = ['BAG01', 'BAG02', 'BAG03', 'BAG03A', 'BAG05', 'BAG06', 'BAG07', 'BAG08', 'BAG09', 'BAG10', 'BAG3A', 'BAV04', 'BAV07', 'BAV3A', 'UNKNOWN']

test('current six-raw capture accepts the exact raw identities without legacy aliases', () => {
  assert.deepEqual(PRODUCTION_TABLE_IDS, SIX_RAW)
  const ids = [...SIX_RAW].reverse().concat(RETIRED_OR_UNKNOWN, 'BAV03A')
  const input = {
    connected: true, authenticated: true,
    tables: ids.map((tableId) => ({ tableId, shoe: 91, round: 7 })),
    rounds: ids.map((tableId) => ({ tableId, shoe: 91, round: 7, winner: 'banker' })),
  }
  const before = structuredClone(input)
  const parsed = parseCloudCapturePayload(input)
  assert.deepEqual(parsed.tables.map(({ tableId }) => tableId), SIX_RAW)
  assert.deepEqual(parsed.rounds.map(({ tableId }) => tableId), [...SIX_RAW].reverse())
  assert.equal(parsed.status.tableCount, 6)
  assert.deepEqual(input, before, 'retired raw evidence must not be rewritten')
})

test('retired BAG and unknown identities cannot enter current capture or alias into BAV', () => {
  for (const tableId of RETIRED_OR_UNKNOWN) {
    const parsed = parseCloudCapturePayload({
      tables: [{ tableId, shoe: 91, round: 7 }],
      rounds: [{ tableId, shoe: 91, round: 7, winner: 'banker' }],
    })
    assert.deepEqual(parsed.tables, [], tableId)
    assert.deepEqual(parsed.rounds, [], tableId)
  }
})
