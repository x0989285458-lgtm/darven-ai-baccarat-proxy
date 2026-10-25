import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'
const source = { mode: 'api', ownerId: 'fixture', epoch: 1, fence: 'fixture-fence' }
const hash = 'c'.repeat(64)
for (const reconcile of [false, true]) {
  for (const hasHash of [false, true]) test(`receiver ${reconcile ? 'reconcile' : 'ingest'} preserves ${hasHash ? 'DB hash' : 'missing-hash absence'}`, async t => {
    const acknowledgement = v => ({ duplicate: true, acceptedRoundKeys: v.roundKeys, ...(hasHash ? { payload_hash: hash } : {}) })
    const writer = { configured: true,
      writeCloudCaptureStatus: async () => assert.fail('duplicate must not write status'),
      writeCloudTableSnapshot: async () => assert.fail('duplicate must not write snapshot'),
      writeCloudRoundEvent: async () => assert.fail('duplicate must not write round'),
      persistCaptureEnvelope: async v => acknowledgement(v),
      reconcileCaptureEnvelope: async v => acknowledgement(v),
    }
    const app = createApp({ autoConnect: false, ingestKey: 'fixture', now: () => 1000000, requireFencedIngest: true, supabaseClient: writer })
    t.after(() => app.stop())
    const response = await app.inject({ method: 'POST', url: '/api/cloud-ingest/snapshot' + (reconcile ? '/reconcile' : ''), headers: { 'x-worker-key': 'fixture' }, body: JSON.stringify({ protocolVersion: 'v105', timestamp: 1000000, captureTimestamp: 1000000, sessionId: 'fixture', sequence: 1, source, roundKeys: [], snapshot: { buildVersion: '105', sessionId: 'fixture', source, tables: [], rounds: [], connected: true, authenticated: true } }) })
    assert.equal(response.statusCode, 200, response.body)
    const body = JSON.parse(response.body)
    assert.equal(body.receiverNormalizedPayloadHash, hasHash ? hash : undefined)
    assert.equal(Object.hasOwn(body, 'receiverNormalizedPayloadHash'), hasHash)
    assert.equal(body.sessionId, 'fixture')
    assert.equal(body.sequence, 1)
    assert.deepEqual(body.source, source)
    assert.deepEqual(body.acceptedRoundKeys, [])
  })
}
