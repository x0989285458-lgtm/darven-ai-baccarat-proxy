import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'

test('ingest ACK follows durable writes and exactly echoes validated round keys', async () => {
  const order = []
  const app = createApp({ autoConnect: false, ingestKey: 'worker-key', now: () => 1_000_000, supabaseClient: {
    configured: true,
    writeCloudCaptureStatus: async () => { order.push('status') },
    writeCloudTableSnapshot: async () => { order.push('snapshot') },
    writeCloudRoundEvent: async () => { order.push('round') },
  } })
  const envelope = { protocolVersion: 'v102', timestamp: 1_000_000, sequence: 7, roundKeys: ['BAG01:88:21'], snapshot: {
    buildVersion: '102', sessionId: 'worker-session', connected: true, authenticated: true,
    tables: [{ tableId: 'BAG01', shoe: 88, round: 21 }],
    rounds: [{ tableId: 'BAG01', shoe: 88, round: 21, winner: 'banker', rawResult: [1, 9, 2, 10, -1, -1, -1, -1, 1, 9], sourceAction: '/api/v1/gametype/*/game/*/room/*/table/*/summary' }],
  } }
  const response = await app.inject({ method: 'POST', url: '/api/cloud-ingest/snapshot', headers: { 'x-worker-key': 'worker-key', 'x-forwarded-proto': 'https' }, body: JSON.stringify(envelope) })
  order.push('ack')
  assert.equal(response.statusCode, 200)
  assert.deepEqual(order, ['status', 'snapshot', 'round', 'ack'])
  assert.deepEqual(JSON.parse(response.body).acceptedRoundKeys, envelope.roundKeys)
})
