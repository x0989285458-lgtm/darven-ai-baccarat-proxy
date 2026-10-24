import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'
import { createSupabaseIngestionClient } from '../src/supabase-writer.js'
import { createSnapshotPusher } from '../../cloud-browser-worker/src/snapshot-pusher.js'
import { createDeliveryReceiptJournal } from '../../cloud-browser-worker/src/delivery-receipt-journal.js'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
const source = { mode: 'api', ownerId: 'fixture', epoch: 1, fence: 'fixture-fence' }
const hash = 'c'.repeat(64)
for (const reconcile of [false, true]) test(`HTTP ${reconcile ? 'reconcile' : 'normal'} preserves canonical receiver hash`, async () => {
  const writer = { configured: true, writeCloudCaptureStatus: async () => {}, writeCloudTableSnapshot: async () => {}, writeCloudRoundEvent: async () => {},
    persistCaptureEnvelope: async v => ({ duplicate: true, acceptedRoundKeys: v.roundKeys, payload_hash: hash }),
    reconcileCaptureEnvelope: async v => ({ duplicate: true, acceptedRoundKeys: v.roundKeys, payload_hash: hash }),
  }
  const app = createApp({ autoConnect: false, ingestKey: 'fixture', now: () => 1000000, requireFencedIngest: true, supabaseClient: writer })
  const response = await app.inject({ method: 'POST', url: '/api/cloud-ingest/snapshot' + (reconcile ? '/reconcile' : ''), headers: { 'x-worker-key': 'fixture' }, body: JSON.stringify({ protocolVersion: 'v105', timestamp: 1000000, captureTimestamp: 1000000, sessionId: 'fixture', sequence: 1, source, roundKeys: [], snapshot: { buildVersion: '105', sessionId: 'fixture', source, tables: [], rounds: [], connected: true, authenticated: true } }) })
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(JSON.parse(response.body).receiverNormalizedPayloadHash, hash)
})

for (const hasFinal of [false, true]) test(`offline real Worker -> HTTP -> Writer -> journal ${hasFinal ? 'Final' : 'heartbeat'}`, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'receipt-composition-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  let clock = 1000000
  let capture
  const writer = createSupabaseIngestionClient({ url: 'https://offline.invalid', serviceKey: 'fixture', requireVerifiedStrategy: false,
    fetchImpl: async (_url, request) => {
      capture = JSON.parse(request.body).p_capture
      const body = { persisted: true, duplicate: true, session_id: capture.session_id, sequence: capture.sequence, accepted_round_keys: capture.round_keys, payload_hash: hash }
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
    },
  })
  const app = createApp({ autoConnect: false, ingestKey: 'fixture', now: () => clock, requireFencedIngest: true, supabaseClient: writer })
  const filePath = path.join(dir, 'receipt-v1.jsonl')
  const journal = await createDeliveryReceiptJournal({ filePath })
  const pusher = createSnapshotPusher({ targetUrl: 'https://offline.invalid/api/cloud-ingest/snapshot', key: 'fixture', now: () => clock,
    queuePath: path.join(dir, 'queue.json'), deliveryReceiptJournal: journal,
    getSnapshot: async () => ({ buildVersion: '105', sessionId: 'fixture', source, connected: true, authenticated: true,
      tables: hasFinal ? [{ tableId: 'BAV01', shoe: 100, round: 4 }] : [],
      rounds: hasFinal ? [{ tableId: 'BAV01', shoe: 100, round: 4, winner: 'banker', final: true, sourceAction: 'summary', rawResult: [1,2,3,4,0,0,0,0,4,6], source: { ...source, sequence: 1 } }] : [],
    }),
    fetchImpl: async (url, request) => {
      const response = await app.inject({ url: new URL(url).pathname, method: request.method, headers: request.headers, body: request.body })
      clock = 1001000
      return { status: response.statusCode, json: async () => JSON.parse(response.body) }
    },
  })
  assert.equal(await pusher.tick(), true, JSON.stringify(pusher.snapshot()))
  await journal.close()
  const receipt = JSON.parse((await readFile(filePath, 'utf8')).trim())
  assert.deepEqual(receipt.acceptedRoundKeys, hasFinal ? ['BAV01:100:4'] : [])
  assert.deepEqual(receipt.acceptedRoundKeys, capture.round_keys)
  assert.equal(receipt.sessionId, capture.session_id)
  assert.equal(receipt.sequence, capture.sequence)
  assert.equal(receipt.ackReceivedAtMs, 1001000)
  assert.equal(receipt.receiverNormalizedPayloadHash, hash)
  assert.deepEqual(receipt.source, source)
})
