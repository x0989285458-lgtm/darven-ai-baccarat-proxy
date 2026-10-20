import test from 'node:test'
import assert from 'node:assert/strict'
import { PRODUCTION_TABLE_IDS, sanitizeProductionSnapshot } from '../src/table-policy.js'
import { multipleJoinPacket } from '../src/mt-api-client.js'
import { extractSnapshotFromPayloads } from '../src/snapshot.js'
import { parseCloudCapturePayload, PRODUCTION_TABLE_IDS as proxyIds } from '../../proxy/src/cloud-capture.js'
const ids = ['BAV01','BAV02','BAV03','BAV03A','BAV05','BAV06']
test('six LIVE exact policy, join, browser extraction and proxy preserve raw identities', () => {
  assert.deepEqual(PRODUCTION_TABLE_IDS, ids)
  assert.deepEqual(proxyIds, ids)
  assert.equal(multipleJoinPacket().action.data.table_id, ids.join(','))
  for (const bad of [ids.slice(1), [...ids.slice(0,5),ids[0]], [...ids.slice(0,5),'BAG01']]) assert.throws(() => multipleJoinPacket(bad))
  const tables = [...ids].reverse().concat('BAG01','BAV04_LIVE').map(tableId => ({tableId, tableType:'BAC', shoe:91, round:1}))
  const rounds = tables.map(t => ({...t, winner:'banker'}))
  assert.deepEqual(sanitizeProductionSnapshot({tables,rounds}).tables.map(t=>t.tableId), ids)
  assert.deepEqual(parseCloudCapturePayload({tables,rounds}).tables.map(t=>t.tableId), ids)
  assert.equal(parseCloudCapturePayload({tables,rounds}).rounds.length, 6)
  assert.deepEqual(extractSnapshotFromPayloads([JSON.stringify({tables})]).tables.map(t=>t.tableId), ids)
})
