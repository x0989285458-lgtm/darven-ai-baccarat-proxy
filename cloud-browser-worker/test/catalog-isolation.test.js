import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createMtApiClient } from '../src/mt-api-client.js'
import { createWorkerSourceRuntime } from '../src/worker-source-runtime.js'
import { createWorkerSourceOwner, createMemoryLeaseStore } from '../src/worker-source-owner.js'
import { createFinalJournal } from '../src/final-journal.js'
import { createGapDetector } from '../src/gap-detector.js'
import { createSnapshotPusher } from '../src/snapshot-pusher.js'
import { parseCloudCapturePayload } from '../../proxy/src/cloud-capture.js'
import fixture from './fixtures/six-raw-catalog-20261023.json' with { type: 'json' }
const ids = ['BAV01','BAV02','BAV03','BAV03A','BAV05','BAV06']
const badId = 'BAV06'
const flush = async () => { for(let i=0;i<30;i++) await new Promise(r=>setTimeout(r,2)) }
function catalog(bad = false) {
  return fixture.tables.map(t => ids.includes(t.table_id) ? {...t, trend:{current_shoe:88,current_round:48,total_round:47},game_name:'20261029_88_48', ...(bad && t.table_id===badId ? {trend:{current_shoe:88,current_round:47,total_round:54},game_name:'20261029_88_47'} : {})} : t)
}
function summary(id, shoe=88, round=48) { return {action:'/api/v1/summary',body:{table_id:id,room_id:Number(fixture.tables.find(t=>t.table_id===id).room_id),shoe,round,result:[1,2,3,4,0,0,0,0,4,6]}} }
async function harness(t) {
  const dir=await mkdtemp(path.join(tmpdir(),'catalog-isolation-'))
  const owner=createWorkerSourceOwner({store:createMemoryLeaseStore(),ownerId:'offline-isolation',mode:'api'})
  const journal=await createFinalJournal({journalPath:path.join(dir,'journal.jsonl')})
  const sockets=[], errors=[], envelopes=[], diagnostics=[]
  let client
  // Execute the complete canonical server runtime-construction expression,
  // not a hand-copied factory: every lifecycle callback crosses real wiring.
  const server = await readFile(new URL('../src/server.js', import.meta.url), 'utf8')
  const start = server.indexOf('const runtime = createWorkerSourceRuntime({', server.indexOf('async function ensureSourceRuntime'))
  const end = server.indexOf('\n    })', start)
  assert.ok(start >= 0 && end > start)
  const expression = server.slice(start + 'const runtime = '.length, end + '\n    })'.length)
  class OfflineSocket extends EventEmitter {
    constructor(url) { super(); this.kind=url.includes('/chat/')?'chat':'game'; this.readyState=1; this.sent=[]; this.closes=0; sockets.push(this) }
    send(v) { this.sent.push(JSON.parse(v)) }
    close() { this.closes++ }
  }
  const runtime = new Function('createWorkerSourceRuntime','createMtApiClient','owner','journal','createGapDetector','replayProvider','sessionManager','WebSocket','snapshotPusher','process','redactUrlSecrets','captureDiagnostics',
    `let lastError = null; return (${expression});`)(
    createWorkerSourceRuntime, options => { client=createMtApiClient(options); return client }, owner, journal, createGapDetector,
    {replay:async()=>({ok:false,events:[]})}, {getSessionToken:async()=> 'offline'}, OfflineSocket,
    {trigger:()=>{}}, {env:{MT_FRESH_BASELINE_ONCE:'true',MT_ALLOW_GAP_DELIVERY:'false',MT_FRESH_BASELINE_WARMUP_MS:'0'}}, e=>{errors.push(e);return e}, {record:e=>diagnostics.push(e)})
  const pusher=createSnapshotPusher({targetUrl:'https://offline.invalid/capture',key:'offline',queuePath:path.join(dir,'queue.json'),getSnapshot:runtime.getDeliverySnapshot,
    onAcknowledged:runtime.acknowledge,fetchImpl:async(_url,request)=>{const e=JSON.parse(request.body);envelopes.push(e);return {status:200,json:async()=>({accepted:true,sessionId:e.sessionId,sequence:e.sequence,source:e.source,acceptedRoundKeys:e.roundKeys})}}})
  t.after(async()=>{await pusher.stopAndWait();await runtime.stop();await rm(dir,{recursive:true,force:true})})
  await runtime.start()
  const receive=async(kind,p)=>{sockets.find(s=>s.kind===kind).emit('message',JSON.stringify(p));await flush()}
  for(const s of sockets)s.emit('open')
  await receive('game',{action:'/api/v1/authenticate',err:0});await receive('chat',{action:'/api/v1/chat/authenticate',err:0})
  return {runtime,journal,client,sockets,errors,envelopes,pusher,receive,diagnostics,join:async()=>receive('game',{action:'/api/v1/gametype/*/game/*/room/*/mulitple_join',err:0})}
}
test('startup contradictory screen isolates one table through real client runtime journal pusher and self heals',async t=>{
  const h=await harness(t)
  await h.receive('game',{msg:{tables:catalog(true)}});await h.join()
  assert.equal(h.client.snapshot().joined,true,'screen inconsistency must not revoke validated membership/join')
  assert.equal(h.sockets.length,2);assert.deepEqual(h.sockets.map(s=>s.closes),[0,0])
  let snap=await h.runtime.getDeliverySnapshot();assert.deepEqual(snap.tables.map(t=>t.tableId),ids)
  const bad=snap.tables.find(t=>t.tableId===badId)
  assert.equal(bad.shoe,undefined);assert.equal(bad.round,undefined)
  await h.receive('game',summary(badId));assert.equal(h.journal.pending().length,0,'no reliable shoe: summary must not bootstrap quarantine')
  for(const id of ids.filter(id=>id!==badId)) await h.receive('game',summary(id))
  assert.equal(h.journal.pending().length,5)
  assert.ok(h.diagnostics.some(e=>e.event==='auth_ok'))
  assert.ok(h.diagnostics.some(e=>e.event==='final_delivered'))
  assert.ok(h.diagnostics.some(e=>e.event==='journal_append_ok'))
  assert.equal(await h.pusher.tick(),true)
  assert.equal(h.envelopes[0].snapshot.tables.length,6)
  const wire=h.envelopes[0].snapshot.tables.find(t=>t.tableId===badId)
  assert.equal(wire.shoe,undefined);assert.equal(wire.round,undefined)
  assert.ok(Date.parse(wire.sourceUpdatedAt)<Date.parse('2000-01-01'),'unknown screen cannot gain receipt freshness')
  const parsed=parseCloudCapturePayload(h.envelopes[0].snapshot,'2026-10-29T00:00:00.000Z')
  assert.equal(parsed.tables.length,6)
  assert.equal(parsed.tables.find(t=>t.tableId===badId).sourceUpdatedAt,'1970-01-01T00:00:00.000Z','raw parser must not replace quarantine freshness with receipt time')
  assert.equal(h.envelopes[0].roundKeys.length,5)
  await h.receive('chat',{msg:{tables:catalog(false)}})
  await h.receive('game',summary(badId));assert.equal(h.journal.pending().length,1)
  assert.equal((await h.runtime.getDeliverySnapshot()).tables.find(t=>t.tableId===badId).round,48)
  await h.runtime.stop();const before=h.journal.pending().length
  await h.receive('game',summary(badId,88,49));assert.equal(h.journal.pending().length,before)
  assert.deepEqual(h.sockets.map(s=>s.closes),[1,1]);assert.deepEqual(h.errors,[])
})

test('running quarantine retains shoe authority for real summaries but never hydrates a stale screen',async t=>{
  const h=await harness(t)
  await h.receive('game',{msg:{tables:catalog()}});await h.join()
  await h.receive('chat',{msg:{tables:catalog(true)}})
  assert.equal(h.client.snapshot().joined,true)
  await h.receive('chat',summary(badId));assert.equal(h.journal.pending().length,0)
  await h.receive('game',summary(badId,87));assert.equal(h.journal.pending().length,0)
  const malformed=summary(badId);malformed.body.result=[1,2]
  await h.receive('game',malformed);assert.equal(h.journal.pending().length,0)
  await h.receive('game',summary(badId));assert.equal(h.journal.pending().length,1)
  await h.receive('game',summary('BAV01'))
  assert.equal(await h.pusher.tick(),true)
  const wire=h.envelopes.at(-1).snapshot.tables.find(t=>t.tableId===badId)
  assert.equal(wire.shoe,undefined);assert.equal(wire.round,undefined)
  assert.equal(wire.trend,undefined);assert.equal(wire.catalogScreenInvalid,undefined)
  assert.equal(wire.sourceUpdatedAt,'1970-01-01T00:00:00.000Z')
  assert.deepEqual(h.envelopes.at(-1).roundKeys.sort(),['BAV01:88:48','BAV06:88:48'])
  await h.receive('game',{msg:{tables:catalog()}})
  assert.equal((await h.runtime.getDeliverySnapshot()).tables.find(t=>t.tableId===badId).round,48)
  assert.deepEqual(h.sockets.map(s=>s.closes),[0,0]);assert.deepEqual(h.errors,[])
})

test('quarantine recovery cannot regress the last valid provider screen without a Final',async t=>{
  const h=await harness(t)
  await h.receive('game',{msg:{tables:catalog()}});await h.join()
  await h.receive('game',{msg:{tables:catalog(true)}})
  const older=catalog();const row=older.find(t=>t.table_id===badId)
  row.trend.current_round=40;row.trend.total_round=39;row.game_name='20261029_88_40'
  await h.receive('game',{msg:{tables:older}})
  const table=(await h.runtime.getDeliverySnapshot()).tables.find(t=>t.tableId===badId)
  assert.ok(table.round===undefined || table.round>=47,'older recovery must not roll back the provider high-water')
})
