import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createSnapshotPusher} from '../src/snapshot-pusher.js';
import {createDeliveryAudit} from '../src/delivery-audit.js';
import {createAuditDiskWriter} from '../src/delivery-audit-child.js';
const source={mode:'api',ownerId:'fixture',epoch:1,fence:'f'};
const hash='a'.repeat(64),receipt={sessionId:'s',sequence:1,source,acceptedRoundKeys:[],receiverNormalizedPayloadHash:hash,ackReceivedAtMs:1234};
const wait=async f=>{for(let i=0;i<300;i++){if(f())return;await new Promise(r=>setTimeout(r,10))}assert.fail('wait timeout')};
const readRows=dir=>fs.readdirSync(dir).filter(n=>n.endsWith('.jsonl')).flatMap(n=>fs.readFileSync(path.join(dir,n),'utf8').trim().split('\n').map(JSON.parse));
for(const field of ['sequence','source','acceptedRoundKeys'])test('live audit must not certify coercible malformed ACK '+field,async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'keria-coercion-'));const q=path.join(dir,'q');const a=createDeliveryAudit({queuePath:q});let callback=0;
 try{
 const p=createSnapshotPusher({queuePath:q,targetUrl:'https://offline.invalid',key:'fixture',now:()=>1234,deliveryAudit:a,onAcknowledged:async()=>callback++,getSnapshot:async()=>({sessionId:'s',source,tables:[],rounds:[{tableId:'BAV01',shoe:1,round:1,final:true,winner:'banker'}]}),fetchImpl:async(_u,o)=>{const e=JSON.parse(o.body);const b={accepted:true,sessionId:e.sessionId,sequence:e.sequence,source,acceptedRoundKeys:e.roundKeys,receiverNormalizedPayloadHash:hash};if(field==='sequence')b.sequence=String(e.sequence);if(field==='source')b.source={...source,ownerId:['fixture']};if(field==='acceptedRoundKeys')b.acceptedRoundKeys=e.roundKeys.map(k=>[k]);return {status:200,json:async()=>b}}});
 const progressed=await p.tick();await wait(()=>a.snapshot().saved===1||a.snapshot().gap);console.log(JSON.stringify({field,progressed,callback,audit:a.snapshot(),rows:a.snapshot().saved?readRows(q+'.delivery-audit-v1'):[]}));
 assert.equal(a.snapshot().saved-a.snapshot().producerSaved,0,'malformed wire ACK must not become a certified canonical saved receipt');assert.equal(a.snapshot().gap,true);
 }finally{await a.close();fs.rmSync(dir,{recursive:true,force:true})}
});

for(const field of ['sequence','source','acceptedRoundKeys'])test('hashed checkpoint rejects raw coercion '+field,async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'receipt-restore-'));const q=path.join(dir,'q');const a=createDeliveryAudit({queuePath:q});let callback=0;
 const opts={queuePath:q,targetUrl:'https://offline.invalid',key:'fixture',now:()=>1234,deliveryAudit:a,onAcknowledged:async()=>callback++,getSnapshot:async()=>({sessionId:'s',source,tables:[],rounds:[{tableId:'BAV01',shoe:1,round:1,final:true,winner:'banker'}]}),fetchImpl:async(_u,o)=>{const e=JSON.parse(o.body);return {status:200,json:async()=>({accepted:true,sessionId:e.sessionId,sequence:e.sequence,source,acceptedRoundKeys:e.roundKeys,receiverNormalizedPayloadHash:hash})}}};
 try {
  const first=createSnapshotPusher({...opts,faultInjector:async name=>{if(name==='after_remote_ack_checkpoint')throw Error('crash')}});assert.equal(await first.tick(),false);
  const data=JSON.parse(fs.readFileSync(q,'utf8'));let mutated=0;
  function visit(v){if(!v||typeof v!=='object')return; if(v.remoteAckReceipt){const r=v.remoteAckReceipt;assert.equal(r.receiverNormalizedPayloadHash,hash);if(field==='sequence')r.sequence=String(r.sequence);if(field==='source')r.source.ownerId=[r.source.ownerId];if(field==='acceptedRoundKeys')r.acceptedRoundKeys=r.acceptedRoundKeys.map(k=>[k]);mutated++}for(const x of Object.values(v))visit(x)}visit(data);assert.equal(mutated,1);fs.writeFileSync(q,JSON.stringify(data));
  const restored=createSnapshotPusher({...opts,fetchImpl:async()=>assert.fail('no resend')});
  await assert.rejects(restored.tick(),/corrupt queue state quarantined/);assert.equal(callback,0);assert.equal(a.snapshot().saved-a.snapshot().producerSaved,0);
 }finally{await a.close();fs.rmSync(dir,{recursive:true,force:true})}
});
