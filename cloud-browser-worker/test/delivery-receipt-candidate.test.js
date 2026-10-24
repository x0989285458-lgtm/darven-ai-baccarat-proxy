import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createSnapshotPusher } from '../src/snapshot-pusher.js'

const hash = 'a'.repeat(64)
const source = { mode: 'api', ownerId: 'fixture', epoch: 1, fence: 'fixture-fence' }
async function fixture(t, extra = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'receipt-candidate-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  let clock = 1000
  const receipts = []
  const options = {
    targetUrl: 'https://offline.invalid/ingest', key: 'fixture', queuePath: path.join(dir, 'queue.json'),
    now: () => clock,
    getSnapshot: async () => ({ sessionId: 'fixture-session', source, tables: [], rounds: [], buildVersion: '105' }),
    fetchImpl: async (_url, request) => {
      const envelope = JSON.parse(request.body)
      return { status: 200, json: async () => {
        clock = 2000
        return { accepted: true, sessionId: envelope.sessionId, sequence: envelope.sequence,
          acceptedRoundKeys: envelope.roundKeys, source, receiverNormalizedPayloadHash: hash }
      } }
    },
    onAcknowledged: async receipt => receipts.push(receipt),
    ...extra,
  }
  return { dir, options, receipts, pusher: createSnapshotPusher(options) }
}

test('opt-in receipt sink runs before Final callback and replay is idempotent', async t => {
  const writes = []
  const sink = { append: async receipt => writes.push(structuredClone(receipt)) }
  const f = await fixture(t, {
    deliveryReceiptJournal: sink,
    onAcknowledged: async () => assert.equal(writes.length, 1),
    faultInjector: async point => { if (point === 'after_remote_ack_checkpoint') throw new Error('simulated crash') },
  })
  assert.equal(await f.pusher.tick(), false)
  assert.equal(writes.length, 0)
  const recovered = createSnapshotPusher({ ...f.options, faultInjector: async () => {}, fetchImpl: async () => assert.fail('must not resend') })
  assert.equal(await recovered.tick(), true)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].ackReceivedAtMs, 2000)
})

test('candidate rejects missing hash before checkpoint and never acknowledges Final', async t => {
  const f = await fixture(t, { deliveryReceiptJournal: { append: async () => assert.fail('invalid receipt') },
    fetchImpl: async (_url, request) => {
      const e = JSON.parse(request.body)
      return { status: 200, json: async () => ({ accepted: true, sessionId: e.sessionId, sequence: e.sequence, acceptedRoundKeys: e.roundKeys, source }) }
    },
  })
  assert.equal(await f.pusher.tick(), false)
  assert.equal(f.receipts.length, 0)
  assert.doesNotMatch(await readFile(f.options.queuePath, 'utf8'), /remote_ack_pending/)
})

test('real receipt journal replays crash after Final callback without resend or extra fsync', async t => {
  const { createDeliveryReceiptJournal } = await import('../src/delivery-receipt-journal.js')
  const f = await fixture(t)
  const filePath = path.join(f.dir, 'delivery-v1.jsonl')
  let syncs = 0
  let journal = await createDeliveryReceiptJournal({ filePath, afterSync: () => { syncs++ } })
  const first = createSnapshotPusher({ ...f.options, deliveryReceiptJournal: journal,
    faultInjector: async point => { if (point === 'after_journal_ack') throw new Error('simulated crash') },
  })
  assert.equal(await first.tick(), false)
  await journal.close()
  journal = await createDeliveryReceiptJournal({ filePath, afterSync: () => { syncs++ } })
  const restarted = createSnapshotPusher({ ...f.options, deliveryReceiptJournal: journal, fetchImpl: async () => assert.fail('must not resend') })
  assert.equal(await restarted.tick(), true)
  await journal.close()
  assert.equal(syncs, 1)
  assert.equal((await readFile(filePath, 'utf8')).trim().split('\n').length, 1)
})

test('heartbeat callback preserves receiver hash and actual validated response time', async t => {
  const f = await fixture(t)
  assert.equal(await f.pusher.tick(), true)
  assert.equal(f.receipts[0].receiverNormalizedPayloadHash, hash)
  assert.equal(f.receipts[0].ackReceivedAtMs, 2000)
  assert.deepEqual(f.receipts[0].acceptedRoundKeys, [])
  assert.deepEqual(f.receipts[0].source, source)
})

test('legacy remoteAck checkpoint remains readable without inventing receive time or hash', async t => {
  const f = await fixture(t, { faultInjector: async point => { if (point === 'after_remote_ack_checkpoint') throw new Error('crash') } })
  await f.pusher.tick()
  const text = await readFile(f.options.queuePath, 'utf8')
  const legacy = text.replace(/,"ackReceivedAtMs":2000/, '').replace(/,"receiverNormalizedPayloadHash":"a{64}"/, '')
  assert.notEqual(legacy, text)
  await writeFile(f.options.queuePath, legacy)
  const restored = createSnapshotPusher({ ...f.options, faultInjector: async () => {}, fetchImpl: async () => assert.fail('legacy must not resend') })
  assert.equal(await restored.tick(), true)
  assert.equal(f.receipts[0].ackReceivedAtMs, undefined)
  assert.equal(f.receipts[0].receiverNormalizedPayloadHash, undefined)
})

test('legacy compatibility never accepts an explicitly malformed receiver hash', async t => {
  const f = await fixture(t, { fetchImpl: async (_url, request) => {
    const e = JSON.parse(request.body)
    return { status: 200, json: async () => ({ accepted: true, sessionId: e.sessionId, sequence: e.sequence, acceptedRoundKeys: e.roundKeys, source, receiverNormalizedPayloadHash: 'business-or-wire-hash' }) }
  } })
  assert.equal(await f.pusher.tick(), false)
  assert.equal(f.receipts.length, 0)
})

test('receiver hash array coercion is rejected in legacy and strict mode', async t => {
 for (const strict of [false,true]) {
  const f=await fixture(t,{...(strict?{deliveryReceiptJournal:{append:async()=>assert.fail('invalid receipt')}}:{}),fetchImpl:async(_u,request)=>{const e=JSON.parse(request.body);return {status:200,json:async()=>({accepted:true,sessionId:e.sessionId,sequence:e.sequence,acceptedRoundKeys:e.roundKeys,source,receiverNormalizedPayloadHash:[hash]})}}});
  assert.equal(await f.pusher.tick(),false);assert.equal(f.receipts.length,0);
 }
});
test('restored checkpoint rejects explicitly malformed new metadata',async t=>{
 for(const replacement of ['"receiverNormalizedPayloadHash":["'+hash+'"]','"receiverNormalizedPayloadHash":null']){
  const f=await fixture(t,{faultInjector:async point=>{if(point==='after_remote_ack_checkpoint')throw Error('crash')}});await f.pusher.tick();
  const text=await readFile(f.options.queuePath,'utf8');await writeFile(f.options.queuePath,text.replace('"receiverNormalizedPayloadHash":"'+hash+'"',replacement));
  const restored=createSnapshotPusher({...f.options,faultInjector:async()=>{},fetchImpl:async()=>assert.fail('must not resend')});
  await assert.rejects(restored.tick(),/corrupt queue state quarantined/);assert.equal(f.receipts.length,0);
  assert.equal(await readFile(f.options.queuePath+'.corrupt-2000','utf8'),text.replace('"receiverNormalizedPayloadHash":"'+hash+'"',replacement));
 }
});
