import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {EventEmitter} from 'node:events'
import {createSnapshotPusher} from '../src/snapshot-pusher.js'
import {createDeliveryAudit} from '../src/delivery-audit.js'
const source={mode:'api',ownerId:'fixture',epoch:1,fence:'f'}
async function fixture(t,enabled,edit){
 const dir=await mkdtemp(path.join(tmpdir(),'audit-hash-remediation-'));let a;const callbacks=[],saved=[]
 if(enabled)a=createDeliveryAudit({queuePath:path.join(dir,'q'),spawnChild:()=>{
  const c=new EventEmitter();c.pid=50;c.send=m=>{saved.push(m.record);setImmediate(()=>c.emit('message',{id:m.id,ok:true}));return true};c.kill=()=>{setImmediate(()=>c.emit('close'));return true};return c
 }})
 const p=createSnapshotPusher({targetUrl:'https://offline.invalid',key:'fixture',queuePath:path.join(dir,'q'),now:()=>1234,deliveryAudit:a,
 getSnapshot:async()=>({sessionId:'s',source,tables:[],rounds:[{tableId:'BAV01',shoe:1,round:1,final:true,winner:'banker'}]}),
 onAcknowledged:async r=>callbacks.push(r),fetchImpl:async(_u,o)=>{const e=JSON.parse(o.body);const b={accepted:true,sessionId:e.sessionId,sequence:e.sequence,source:{...source},acceptedRoundKeys:e.roundKeys};edit(b);return {status:200,json:async()=>b}}
 })
 t.after(async()=>{await p.stop();await a?.close();await rm(dir,{recursive:true,force:true})});return {p,a,callbacks,saved}
}
for(const enabled of [false,true])for(const hash of ['invalid-audit-only-hash','A'.repeat(64),'',null,123,{}])test(`optional malformed hash stays live audit=${enabled} hash=${JSON.stringify(hash)}`,async t=>{
 const {p,a,callbacks,saved}=await fixture(t,enabled,b=>{b.receiverNormalizedPayloadHash=hash})
 assert.equal(await p.tick(),true,'optional audit metadata must not change predecessor Live ACK acceptance')
 assert.equal(callbacks.length,1);assert.equal(p.snapshot().queueEntryCount,0)
 assert.equal(callbacks[0].receiverNormalizedPayloadHash,undefined,'invalid evidence hash must be omitted from receipt')
 if(a){assert.equal(a.snapshot().gap,true);assert.ok(a.snapshot().gapReasons.includes('legacy_missing_metadata'));assert.equal(a.snapshot().auditComplete,false);assert.equal(saved.filter(r=>r.type==='delivery_ack').length,0)}
})
for(const field of ['accepted','sessionId','sequence','source','roundKeys'])test(`optional hash does not loosen Live ACK ${field}`,async t=>{
 const {p,callbacks}=await fixture(t,true,b=>{
  b.receiverNormalizedPayloadHash='invalid-audit-only-hash'
  if(field==='accepted')b.accepted=false
  if(field==='sessionId')b.sessionId='other'
  if(field==='sequence')b.sequence++
  if(field==='source')b.source.fence='other'
  if(field==='roundKeys')b.acceptedRoundKeys=['wrong:1:1']
 })
 assert.equal(await p.tick(),false);assert.equal(callbacks.length,0);assert.equal(p.snapshot().queueEntryCount,1)
})
