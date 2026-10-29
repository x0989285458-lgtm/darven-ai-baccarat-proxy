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


for (const restored of ids) test(`reappearing ${restored} settles after one expansion ACK`,async t=>{
 const h=await harness(t); const ack={action:'/api/v1/gametype/*/game/*/room/*/mulitple_join',err:0};
 const full=fixture.tables.map(x=>ids.includes(x.table_id)?{...x,shoe:88,round:47}:x);
 const count=()=>h.sockets.game.sent.filter(p=>p.action.name.endsWith('/mulitple_join')).length;
 await h.receive({msg:{tables:full}});await h.receive(ack);
 await h.receive({msg:{tables:full.filter(x=>x.table_id!==restored)}});await h.receive(ack);
 await h.receive({msg:{tables:full}}); const before=count(); await h.receive(ack);
 const counts=[before,count()];for(let i=0;i<5;i++){await h.receive(ack);counts.push(count())}
 console.log('REVIEW_JOIN_COUNTS',JSON.stringify(counts));
 assert.equal(counts[1],before,'successful expansion ACK must not issue another unchanged Join');
});
