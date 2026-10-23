import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { createMtApiClient } from '../src/mt-api-client.js'
const fixture=JSON.parse(readFileSync(new URL('./fixtures/six-raw-catalog-20261023.json',import.meta.url)))
const ids=['BAV01','BAV02','BAV03','BAV03A','BAV05','BAV06']
const flush=()=>new Promise(resolve=>setImmediate(resolve))
function packet(e){return {action:e.action,body:{table_id:e.tableId,room_id:e.roomId,shoe:e.shoe,round:e.round,result:e.rawResult}}}
async function harness(t){
 const sockets={},finals=[],tables=[],errors=[]; const lease={mode:'api',ownerId:'offline',epoch:1,fence:'fixture'}
 const client=createMtApiClient({sourceOwner:{lease:()=>lease,assertCurrent:()=>{},eventSource:sequence=>({...lease,sequence})},sessionManager:{getSessionToken:async()=> 'offline-fixture'},createSocket:(_url,{kind})=>{const s=new EventEmitter();s.readyState=1;s.sent=[];s.send=x=>s.sent.push(JSON.parse(x));s.close=()=>{};sockets[kind]=s;return s},onFinal:async e=>finals.push(e),onTables:async v=>tables.push(v),onError:e=>errors.push(e)})
 t.after(()=>client.stop());await client.start();for(const kind of ['game','chat']){sockets[kind].emit('open');sockets[kind].emit('message',JSON.stringify({action:kind==='game'?'/api/v1/authenticate':'/api/v1/chat/authenticate',err:0}))}await flush()
 const receive=async p=>{sockets.game.emit('message',JSON.stringify(p));await flush()}
 return {client,sockets,finals,tables,errors,receive,join:()=>sockets.game.sent.find(p=>p.action.name.endsWith('/mulitple_join'))}
}

test('current three-LIVE catalog admits exact six raw sources and delivers all recorded summaries',async t=>{
 const h=await harness(t)
 await h.receive({msg:{tables:fixture.tables}})
 assert.equal(h.join()?.action.data.table_id,ids.join(','))
 assert.deepEqual(h.finals,[])
 await h.receive({action:'/api/v1/gametype/*/game/*/room/*/mulitple_join',err:0})
 for(const e of fixture.events) await h.receive(packet(e))
 assert.equal(h.finals.length,fixture.events.length)
 assert.deepEqual([...new Set(h.finals.map(e=>e.tableId))].sort(),[...ids].sort())
 assert.deepEqual(h.tables.at(-1).map(e=>e.table_id),ids)
 assert.deepEqual(h.finals.map(e=>e.rawResult),fixture.events.map(e=>e.rawResult))
 assert.deepEqual(h.errors,[])
})

for(const [name,mutate] of [
 ['no LIVE aliases',a=>a.filter(x=>!x.table_id.endsWith('_LIVE'))],
 ['one LIVE alias removed',a=>a.filter(x=>x.table_id!=='BAV01_LIVE')],
])test(`optional aliases: ${name} retains six raw identities`,async t=>{
 const h=await harness(t);await h.receive({msg:{tables:mutate(structuredClone(fixture.tables))}})
 assert.equal(h.join()?.action.data.table_id,ids.join(','))
 await h.receive({action:'/api/v1/gametype/*/game/*/room/*/mulitple_join',err:0})
 for(const e of fixture.events)await h.receive(packet(e))
 assert.equal(h.finals.length,fixture.events.length);assert.deepEqual(h.errors,[])
})
for(const [name,mutate] of [
 ...ids.map(id=>[`missing raw ${id}`,a=>a.filter(x=>x.table_id!==id)]),
 ['duplicate raw',a=>[...a,a.find(x=>x.table_id==='BAV01')]],
 ['raw room changed',a=>a.map(x=>x.table_id==='BAV01'?{...x,room_id:'999'}:x)],
 ['raw hall changed',a=>a.map(x=>x.table_id==='BAV01'?{...x,hall:9}:x)],
 ['raw type changed',a=>a.map(x=>x.table_id==='BAV01'?{...x,table_type:'DT'}:x)],
 ['alias unknown source',a=>a.map(x=>x.table_id==='BAV01_LIVE'?{...x,table_id_t:'BAV99'}:x)],
 ['alias swapped source',a=>a.map(x=>x.table_id==='BAV01_LIVE'?{...x,table_id_t:'BAV02'}:x)],
 ['alias room changed',a=>a.map(x=>x.table_id==='BAV01_LIVE'?{...x,room_id:'999'}:x)],
 ['alias hall changed',a=>a.map(x=>x.table_id==='BAV01_LIVE'?{...x,hall:3}:x)],
 ['alias type changed',a=>a.map(x=>x.table_id==='BAV01_LIVE'?{...x,table_type:'DT'}:x)],
 ['duplicate alias',a=>[...a,a.find(x=>x.table_id==='BAV01_LIVE')]],
 ['third-party competing mapping',a=>[...a,{table_id:'UNKNOWN',table_id_t:'BAV01',room_id:'48',hall:9,table_type:'BAC'}]],
 ['third-party mapping with alias absent',a=>[...a.filter(x=>x.table_id!=='BAV01_LIVE'),{table_id:'UNKNOWN',table_id_t:'BAV01',room_id:'48',hall:9,table_type:'BAC'}]],
 ['other raw mapped to selected source',a=>a.map(x=>x.table_id==='BAV07'?{...x,table_id_t:'BAV01'}:x)],
])test(`raw contract rejects ${name} before join, tables or Final`,async t=>{
 const h=await harness(t);await h.receive({msg:{tables:mutate(structuredClone(fixture.tables))}})
 assert.equal(h.join(),undefined)
 await h.receive({action:'/api/v1/gametype/*/game/*/room/*/mulitple_join',err:0})
 await h.receive(packet(fixture.events[0]));assert.deepEqual(h.finals,[]);assert.deepEqual(h.tables,[])
 assert.equal(h.client.snapshot().joined,false)
})
test('alias disappearance does not revoke raw admission; raw disappearance blocks late ACK',async t=>{
 const h=await harness(t);await h.receive({msg:{tables:fixture.tables}})
 await h.receive({msg:{tables:fixture.tables.filter(x=>!x.table_id.endsWith('_LIVE'))}})
 await h.receive({action:'/api/v1/gametype/*/game/*/room/*/mulitple_join',err:0})
 await h.receive(packet(fixture.events[0]));assert.equal(h.finals.length,1)
 const oldTables=h.tables.length
 await h.receive({msg:{tables:fixture.tables.filter(x=>x.table_id!=='BAV06')}})
 await h.receive({action:'/api/v1/gametype/*/game/*/room/*/mulitple_join',err:0})
 await h.receive(packet(fixture.events[1]));assert.equal(h.finals.length,1);assert.equal(h.tables.length,oldTables)
 assert.equal(h.client.snapshot().joined,false)
})
