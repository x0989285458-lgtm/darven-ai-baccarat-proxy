import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { createMtApiClient } from '../src/mt-api-client.js'
const fixture=JSON.parse(readFileSync(new URL('./fixtures/six-live-recorded.json',import.meta.url)))
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
test('recorded six raw summaries share catalog-verified join/table identities',async t=>{
 const h=await harness(t);assert.equal(h.join(),undefined,'no join before catalog verification')
 await h.receive({msg:{tables:fixture.tables}});assert.equal(h.join()?.action.data.table_id,ids.join(','))
 await h.receive({action:'/api/v1/gametype/*/game/*/room/*/mulitple_join',err:0})
 for(const e of fixture.events) await h.receive(packet(e))
 assert.equal(h.finals.length,fixture.events.length);assert.deepEqual([...new Set(h.finals.map(e=>e.tableId))].sort(),[...ids].sort())
 assert.deepEqual(h.tables.at(-1).map(e=>e.table_id),ids)
 assert.deepEqual(h.finals.map(e=>e.rawResult),fixture.events.map(e=>e.rawResult))
 const count=h.finals.length
 for(const changed of [{tableId:'BAG01'},{tableId:'BAV01_LIVE'},{tableId:'BAV07'},{roomId:999}])await h.receive(packet({...fixture.events[0],...changed}))
 assert.equal(h.finals.length,count)
})
for(const [name,mutate] of [
 ['missing LIVE',a=>a.filter(x=>x.table_id!=='BAV01_LIVE')],
 ['unknown mapping',a=>a.map(x=>x.table_id==='BAV01_LIVE'?{...x,table_id_t:'BAV99'}:x)],
 ['wrong room',a=>a.map(x=>x.table_id==='BAV01_LIVE'?{...x,room_id:'999'}:x)],
 ['duplicate mapping',a=>[...a,a.find(x=>x.table_id==='BAV01_LIVE')]],
 ['wrong hall',a=>a.map(x=>x.table_id==='BAV01_LIVE'?{...x,hall:3}:x)],
 ['duplicate raw',a=>[...a,a.find(x=>x.table_id==='BAV01')]],
 ['swapped mapping',a=>a.map(x=>x.table_id==='BAV01_LIVE'?{...x,table_id_t:'BAV02'}:x)],
])test(`catalog rejects ${name} without join or Final`,async t=>{const h=await harness(t);await h.receive({msg:{tables:mutate(structuredClone(fixture.tables))}});assert.equal(h.join(),undefined);await h.receive(packet(fixture.events[0]));assert.deepEqual(h.finals,[]);assert.deepEqual(h.tables,[])})

test('catalog revocation blocks pending tables and Finals even after a late ACK',async t=>{
 const h=await harness(t)
 await h.receive({msg:{tables:fixture.tables}})
 await h.receive(packet(fixture.events[0]));assert.equal(h.finals.length,0)
 await h.receive({msg:{tables:fixture.tables.filter(x=>x.table_id!=='BAV01_LIVE')}})
 await h.receive({action:'/api/v1/gametype/*/game/*/room/*/mulitple_join',err:0})
 await h.receive(packet(fixture.events[0]))
 assert.equal(h.client.snapshot().joined,false)
 assert.deepEqual(h.finals,[]);assert.deepEqual(h.tables,[])
})
