import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFinalJournal, finalHash, markerHash } from '../src/final-journal.js'
import { createMtApiClient } from '../src/mt-api-client.js'
import { createSnapshotPusher } from '../src/snapshot-pusher.js'
const source={mode:'api',ownerId:'old',epoch:1,fence:'old',sequence:1}
const event={tableId:'BAG01',shoe:91,round:7,winner:'banker',sourceAction:'summary',final:true,rawResult:[1,2,3,4,0,0,0,0,4,6],source}
const lifecycle={tableId:'BAG01',activeShoe:91,retiredShoes:[],currentScreen:{shoe:91,round:7},origin:'final',source}
async function dir(t){const d=await mkdtemp(fileURLToPath(new URL('./six-live-temp-',import.meta.url))); t.after(()=>rm(d,{recursive:true,force:true}));return d}
test('legacy Final lifecycle, marker, rebind and cursor restore without new BAG admission or LIVE replay', async t=>{
 const d=await dir(t), journalPath=path.join(d,'finals.jsonl')
 const historical={...event,shoeLifecycle:lifecycle}, identity='BAG01:91:7',hash=finalHash(event)
 const marker={tableId:'BAG01',shoe:91,finalRound:7}
 const records=[{type:'final',identity,hash,event:historical},{type:'rebind',identity,hash,capturedSource:source,source:{...source,epoch:2,fence:'new'}},{type:'shoe_closed',...marker,hash:markerHash(marker)},{type:'cursor_bootstrap',origin:'snapshot-pusher-exact-ack-cursor',cursors:[{identity:'BAG02:91:7'}]}]
 const before=records.map(JSON.stringify).join('\n')+'\n';await writeFile(journalPath,before)
 const j=await createFinalJournal({journalPath})
 assert.deepEqual(j.pending(),[])
 assert.equal(j.status(identity).event.tableId,'BAG01')
 assert.equal(j.cursor('BAG02').identity,'BAG02:91:7')
 assert.deepEqual(j.shoeLifecycle('BAG01'),lifecycle)
 assert.deepEqual(await j.rebindPending(()=>{throw Error('legacy must not rebind')}),[])
 await assert.rejects(j.append(event),/final_event_invalid/)
 await assert.rejects(j.closeShoe(marker),/shoe_closed_marker_invalid/)
 await assert.rejects(j.transitionShoeLifecycle({...lifecycle,round:7}),/shoe_lifecycle_invalid/)
 assert.equal(await readFile(journalPath,'utf8'),before)
 const live=await j.append({...event,tableId:'BAV01'})
 assert.equal(j.pending()[0].identity,'BAV01:91:7')
 await j.ack(live.identity,live.hash)
 const restored=await createFinalJournal({journalPath})
 assert.equal(restored.cursor('BAV01').identity,live.identity)
 assert.equal(restored.status(identity).acknowledged,false)
 assert.deepEqual(restored.pending(),[])
})
test('API bootstrap ignores supported legacy lifecycle rather than importing it into LIVE chronology',()=>{
 const client=createMtApiClient({sourceOwner:{},sessionManager:{},createSocket:()=>{throw Error('no network')},initialShoeLifecycles:[lifecycle]})
 assert.ok(client)
 assert.throws(()=>createMtApiClient({sourceOwner:{},sessionManager:{},createSocket:()=>{},initialShoeLifecycles:[{...lifecycle,tableId:'UNKNOWN'}]}),/invalid/)
})
test('persisted legacy queue requires separate scope and remains byte-identical without network or ACK',async t=>{
 const d=await dir(t),queuePath=path.join(d,'queue.json')
 const envelope={protocolVersion:'v105',sessionId:'old',sequence:1,timestamp:1,captureTimestamp:1,roundKeys:['BAG01:91:7'],snapshot:{buildVersion:'105',tables:[],rounds:[event]}}
 const before=JSON.stringify({version:3,entries:[envelope]});await writeFile(queuePath,before)
 let sends=0,acks=0
 const p=createSnapshotPusher({targetUrl:'https://offline.invalid',key:'test',queuePath,getSnapshot:()=>({sessionId:'live',tables:[],rounds:[]}),fetchImpl:async()=>{sends++;throw Error('network forbidden')},onAcknowledged:()=>{acks++}})
 assert.equal(await p.tick(),false)
 assert.equal(sends,0);assert.equal(acks,0)
 assert.equal(await readFile(queuePath,'utf8'),before)
 assert.match(p.snapshot().lastError,/legacy_table_scope_requires_new_queue/)
})
