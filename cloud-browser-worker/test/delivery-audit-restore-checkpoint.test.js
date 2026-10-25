import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { createSnapshotPusher } from '../src/snapshot-pusher.js'
import { createDeliveryAudit } from '../src/delivery-audit.js'

const source = { mode: 'api', ownerId: 'fixture', epoch: 1, fence: 'f' }
const snapshot = { sessionId: 's', source, tables: [], rounds: [] }
const envelope = { protocolVersion: 'v105', sessionId: 's', source, sequence: 7, timestamp: 7, captureTimestamp: 7, roundKeys: [], snapshot }
function fixture(t, checkpoint, journal) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-audit-'))
  const q = path.join(dir, 'queue')
  if (checkpoint !== undefined) fs.writeFileSync(q, Buffer.isBuffer(checkpoint) ? checkpoint : JSON.stringify(checkpoint))
  if (journal !== undefined) fs.writeFileSync(q + '.journal', journal)
  const audit = createDeliveryAudit({ queuePath: q })
  t.after(async () => { await audit.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  return { q, audit, options: { queuePath: q, targetUrl: 'https://offline.invalid', key: 'fixture', deliveryAudit: audit, now: () => 1000, getSnapshot: async () => { throw Error('observation boundary') }, fetchImpl: async () => assert.fail('unexpected transport') } }
}

for (const compressed of [false, true]) test('exact empty v3 checkpoint permits only new producer evidence: ' + compressed, async t => {
  const checkpoint = { version: 3, entries: [] }
  const f = fixture(t, compressed ? gzipSync(JSON.stringify(checkpoint)) : checkpoint, '')
  const cursor = { version: 3, initialized: true, lastSequence: 9000, observedRoundKeys: ['BAV01:1:1'], acknowledgedRoundKeys: ['BAV01:1:1'] }
  fs.writeFileSync(f.q + '.cursor.json', JSON.stringify(cursor))
  const before = fs.readFileSync(f.q)
  const p = createSnapshotPusher(f.options)
  await assert.rejects(p.tick(), /observation boundary/)
  assert.equal(f.audit.snapshot().gap, false)
  assert.equal(f.audit.snapshot().attempted, 0, 'restore must not synthesize producer or ACK')
  assert.deepEqual(fs.readFileSync(f.q), before, 'restore must not remove the checkpoint')
  assert.deepEqual(JSON.parse(fs.readFileSync(f.q + '.cursor.json')), cursor)
  const sent = []
  const fresh = createSnapshotPusher({ ...f.options, getSnapshot: async () => snapshot, fetchImpl: async (_url, options) => {
    const e = JSON.parse(options.body); sent.push(e)
    return { status: 200, json: async () => ({ accepted: true, sessionId: e.sessionId, sequence: e.sequence, source, acceptedRoundKeys: e.roundKeys, receiverNormalizedPayloadHash: 'b'.repeat(64) }) }
  } })
  assert.equal(await fresh.tick(), true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].sequence, 9001)
  for (let i = 0; i < 300 && f.audit.snapshot().queuedRecords; i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(f.audit.snapshot().saved, 2)
  assert.equal(f.audit.snapshot().producerSaved, 1)
  assert.equal(f.audit.snapshot().gap, false)
  const rows = fs.readdirSync(f.q + '.delivery-audit-v1').filter(n => n.endsWith('.jsonl')).flatMap(n => fs.readFileSync(path.join(f.q + '.delivery-audit-v1', n), 'utf8').trim().split('\n').map(JSON.parse))
  assert.deepEqual(rows.map(r => r.type), ['producer_envelope', 'delivery_ack'])
  assert.deepEqual(rows.map(r => r.sequence), [9001, 9001])
  const savedCursor = JSON.parse(fs.readFileSync(f.q + '.cursor.json'))
  assert.equal(savedCursor.lastSequence, 9001)
  assert.deepEqual(savedCursor.observedRoundKeys, cursor.observedRoundKeys)
  assert.deepEqual(savedCursor.acknowledgedRoundKeys, cursor.acknowledgedRoundKeys)
})

const negatives = [
  ['nonempty heartbeat', { version: 3, entries: [envelope] }],
  ['attempted envelope', { version: 3, entries: [{ ...envelope, deliveryState: 'attempted' }] }],
  ['invalid remote ACK checkpoint', { version: 3, entries: [{ ...envelope, deliveryState: 'remote_ack_pending' }] }],
  ['legacy empty', { version: 2, entries: [] }],
  ['unversioned empty', { entries: [] }],
  ['coerced version', { version: '3', entries: [] }],
  ['future version', { version: 4, entries: [] }],
  ['unknown field', { version: 3, entries: [], snapshot }],
  ['missing entries', { version: 3 }],
  ['invalid entries', { version: 3, entries: null }],
  ['malformed entry', { version: 3, entries: [null] }],
  ['corrupt JSON', Buffer.from('{')],
  ['corrupt compressed', Buffer.from([0x1f, 0x8b, 0])],
  ['journal envelope', { version: 3, entries: [] }, JSON.stringify(envelope) + '\n'],
  ['journal-only envelope', undefined, JSON.stringify(envelope) + '\n'],
  ['corrupt journal', { version: 3, entries: [] }, '{'],
  ['blank nonempty journal', { version: 3, entries: [] }, '\n'],
]
for (const [name, checkpoint, journal] of negatives) test('restore remains audit fail-closed: ' + name, async t => {
  const f = fixture(t, checkpoint, journal)
  const p = createSnapshotPusher(f.options)
  try { await p.tick() } catch { /* Restore rejection or deliberate observation boundary. */ }
  assert.equal(f.audit.snapshot().gap, true)
  assert.equal(f.audit.snapshot().attempted, 0, 'never fabricate recovered producer evidence')
})

test('valid empty restore cannot reset a sticky audit gap', async t => {
  const f = fixture(t, { version: 3, entries: [] })
  f.audit.markGap('preexisting_gap')
  await assert.rejects(createSnapshotPusher(f.options).tick(), /observation boundary/)
  assert.equal(f.audit.snapshot().gap, true)
  assert.equal(f.audit.snapshot().attempted, 0)
})
