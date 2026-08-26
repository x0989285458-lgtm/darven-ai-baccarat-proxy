import test from 'node:test'
import assert from 'node:assert/strict'
import { createInMemoryIngestSourceFence } from '../src/ingest-source-fence.js'
import { createApp } from '../src/server.js'

test('ingest source fence accepts current owner, advances epoch, and rejects old or split-brain owner', async () => {
  const fence = createInMemoryIngestSourceFence()
  const first = { mode: 'api', ownerId: 'api-primary', epoch: 4, fence: 'fence-4' }
  assert.equal((await fence.validateAndAdvance(first)).status, 'advanced')
  assert.equal((await fence.validateAndAdvance(first)).status, 'current')
  await assert.rejects(fence.validateAndAdvance({ ...first, fence: 'other-fence' }), /source_epoch_fence_conflict/)

  const browser = { mode: 'browser', ownerId: 'browser-cold', epoch: 5, fence: 'fence-5' }
  assert.equal((await fence.validateAndAdvance(browser)).status, 'advanced')
  await assert.rejects(fence.validateAndAdvance(first), /stale_source_epoch/)
})

test('source fence validates every event source against envelope owner and positive sequence', () => {
  const fence = createInMemoryIngestSourceFence()
  const source = { mode: 'api', ownerId: 'api-primary', epoch: 4, fence: 'fence-4' }
  assert.doesNotThrow(() => fence.validateEvents(source, [{ source: { ...source, sequence: 1 } }, { source: { ...source, sequence: 2 } }]))
  assert.throws(() => fence.validateEvents(source, [{ source: { ...source, epoch: 3, sequence: 1 } }]), /event_source_mismatch/)
  assert.throws(() => fence.validateEvents(source, [{ source: { ...source, sequence: 0 } }]), /event_source_sequence_invalid/)
})

test('cloud ingest exact-ACKs current fence and rejects a stale epoch from another session before writes', async () => {
  const now = 1_000_000
  let writes = 0
  const app = createApp({
    autoConnect: false, ingestKey: 'worker-key', now: () => now, requireFencedIngest: true,
    supabaseClient: {
      configured: true,
      readIssuedPrediction: async () => null,
      writeCloudCaptureStatus: async () => { writes += 1 },
      writeCloudTableSnapshot: async () => { writes += 1 },
      writeCloudRoundEvent: async () => { writes += 1 },
    },
  })
  const current = { mode: 'api', ownerId: 'api-primary', epoch: 5, fence: 'fence-5' }
  const request = (source, sessionId, sequence) => ({
    method: 'POST', url: '/api/cloud-ingest/snapshot', headers: { 'x-worker-key': 'worker-key' },
    body: JSON.stringify({
      protocolVersion: 'v105', timestamp: now, captureTimestamp: now, sessionId, sequence, source,
      roundKeys: ['BAG01:100:4'],
      snapshot: {
        buildVersion: '105', sessionId, connected: true, authenticated: true, source,
        tables: [{ tableId: 'BAG01', shoe: 100, round: 5 }],
        rounds: [{
          tableId: 'BAG01', shoe: 100, round: 4, winner: 'banker', sourceAction: 'summary',
          rawResult: [1, 2, 3, 4, 0, 0, 0, 0, 4, 6], source: { ...source, sequence: 9 },
        }],
      },
    }),
  })

  const accepted = await app.inject(request(current, 'api-session', 10))
  assert.equal(accepted.statusCode, 200)
  assert.deepEqual(JSON.parse(accepted.body).source, current)
  const writesAfterCurrent = writes

  const stale = await app.inject(request({ ...current, epoch: 4, fence: 'fence-4' }, 'stale-session', 11))
  assert.equal(stale.statusCode, 409)
  assert.equal(JSON.parse(stale.body).error, 'stale_source_epoch')
  assert.equal(writes, writesAfterCurrent)
})
