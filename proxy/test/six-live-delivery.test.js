import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createFinalJournal } from '../../cloud-browser-worker/src/final-journal.js'
import { createSnapshotPusher } from '../../cloud-browser-worker/src/snapshot-pusher.js'
import { parseCloudCapturePayload, PRODUCTION_TABLE_IDS } from '../src/cloud-capture.js'
test('six LIVE durable Finals preserve FIFO raw keys through pusher, proxy and exact ACK restart',async t=>{
 const d=await mkdtemp(fileURLToPath(new URL('../../cloud-browser-worker/test/six-live-delivery-',import.meta.url)))
 t.after(()=>rm(d,{recursive:true,force:true}))
 const journalPath=path.join(d,'finals.jsonl'),j=await createFinalJournal({journalPath})
 assert.deepEqual(PRODUCTION_TABLE_IDS,['BAV01','BAV02','BAV03','BAV03A','BAV05','BAV06'])
 const expected=[]
 for(const [index,tableId] of PRODUCTION_TABLE_IDS.entries()){
  const event={tableId,shoe:91,round:7,winner:'banker',sourceAction:'summary',final:true,rawResult:[1,2,3,4,0,0,0,0,4,6],source:{mode:'api',ownerId:'test',epoch:1,fence:'test',sequence:index+1}}
  expected.push((await j.append(event)).identity)
 }
 const delivered=[]
 const p=createSnapshotPusher({targetUrl:'https://offline.invalid',key:'fixture',queuePath:path.join(d,'queue.json'),maxDrainPerTick:10,getSnapshot:()=>({sessionId:'live',tables:[],rounds:j.pending().map(e=>e.event)}),fetchImpl:async(_url,request)=>{
  const envelope=JSON.parse(request.body),parsed=parseCloudCapturePayload(envelope.snapshot)
  const keys=parsed.rounds.map(r=>`${r.tableId}:${r.shoe}:${r.round}`)
  assert.deepEqual(keys,envelope.roundKeys)
  delivered.push(...keys)
  return {status:200,json:async()=>({accepted:true,sessionId:envelope.sessionId,sequence:envelope.sequence,acceptedRoundKeys:keys})}
 },onAcknowledged:async({acceptedRoundKeys:roundKeys})=>{
  for(const key of roundKeys){const e=j.status(key);await j.ack(key,e.hash)}
 }})
 assert.equal(await p.tick(),true, JSON.stringify(p.snapshot()))
 assert.deepEqual(delivered,expected)
 assert.deepEqual(j.pending(),[])
 const restored=await createFinalJournal({journalPath})
 assert.deepEqual(restored.pending(),[])
 for(const id of PRODUCTION_TABLE_IDS) assert.equal(restored.cursor(id).identity,`${id}:91:7`)
 assert.equal(restored.cursor('BAG01'),null)
})
