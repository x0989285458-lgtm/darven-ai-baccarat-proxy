import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createSnapshotPusher } from '../src/snapshot-pusher.js'
const source = { mode: 'api', ownerId: 'fixture', epoch: 1, fence: 'f' }
const receipt = { sessionId: 's', sequence: 1, source, acceptedRoundKeys: [], receiverNormalizedPayloadHash: 'a'.repeat(64), ackReceivedAtMs: 1234 }
const waitFor = async fn => { for(let i=0;i<300;i++){ if(await fn()) return; await new Promise(r=>setTimeout(r,10)) } assert.fail('condition timeout') }
test('live audit admission is synchronous, sees heartbeat, never changes legacy ACK callback', async () => {
 const dir=await mkdtemp(path.join(tmpdir(),'live-audit-')); const seen=[]; const callbacks=[]
 try {
 const p=createSnapshotPusher({queuePath:path.join(dir,'q.json'),targetUrl:'https://offline.invalid',key:'f',now:()=>1234,
 getSnapshot:async()=>({sessionId:'s',source,tables:[],rounds:[]}),
 deliveryAudit:{enqueue:r=>{seen.push(r);return false},snapshot:()=>({gap:true})},
 onAcknowledged:async r=>callbacks.push(r),fetchImpl:async(_u,o)=>{const e=JSON.parse(o.body);return {status:200,json:async()=>({accepted:true,sessionId:e.sessionId,sequence:e.sequence,source,acceptedRoundKeys:e.roundKeys,receiverNormalizedPayloadHash:receipt.receiverNormalizedPayloadHash})}}})
 assert.equal(await p.tick(),true); assert.equal(seen.length,1); assert.equal(seen[0].ackReceivedAtMs,1234)
 assert.equal(callbacks.length,1); assert.equal(p.snapshot().deliveryAudit.gap,true)
 } finally {await rm(dir,{recursive:true,force:true})}
})

test('real isolated child fsyncs receipts and restart retains exact saved scope', async () => {
 const { createDeliveryAudit } = await import('../src/delivery-audit.js')
 const dir=await mkdtemp(path.join(tmpdir(),'audit-child-')); let a
 try {
 a=createDeliveryAudit({queuePath:path.join(dir,'queue.json')}); assert.equal(a.enqueue(receipt),true)
 await waitFor(()=>a.snapshot().saved===1); assert.equal(a.snapshot().auditComplete,false)
 await a.close(); a=createDeliveryAudit({queuePath:path.join(dir,'queue.json')})
 assert.equal(a.enqueue({...receipt,sequence:2}),true); await waitFor(()=>a.snapshot().saved===1)
 await a.close()
 const folder=path.join(dir,'queue.json.delivery-audit-v1');const names=await readdir(folder)
 const rows=(await Promise.all(names.filter(n=>n.endsWith('.jsonl')).map(n=>readFile(path.join(folder,n),'utf8')))).join('').trim().split('\n').map(JSON.parse)
 assert.deepEqual(rows.map(r=>r.sequence).sort(),[1,2]); assert.equal(rows[0].ackReceivedAtMs,1234)
 } finally {await a?.close(); await rm(dir,{recursive:true,force:true})}
})

test('audit hang and full queue cannot hold multiple new Finals; real child always cleaned', async () => {
 const { createDeliveryAudit }=await import('../src/delivery-audit.js'); const {fork}=await import('node:child_process')
 const dir=await mkdtemp(path.join(tmpdir(),'audit-full-')); let child;let a;let callbacks=0;let round=0
 try {
 a=createDeliveryAudit({queuePath:path.join(dir,'q'),spawnChild:(...args)=>{child=fork(...args);child.send=()=>true;return child}})
 for(let i=0;i<64;i++)assert.equal(a.enqueue({...receipt,sequence:i+1}),true)
 assert.equal(a.enqueue({...receipt,sequence:65}),false);assert.equal(a.snapshot().queuedRecords,64)
 const p=createSnapshotPusher({queuePath:path.join(dir,'q'),targetUrl:'https://offline.invalid',key:'f',deliveryAudit:a,
 getSnapshot:async()=>({sessionId:'s',source,tables:[],rounds:[{tableId:'BAV01',shoe:1,round:++round,final:true,winner:'banker'}]}),
 onAcknowledged:async()=>callbacks++,fetchImpl:async(_u,o)=>{const e=JSON.parse(o.body);return {status:200,json:async()=>({accepted:true,sessionId:e.sessionId,sequence:e.sequence,source,acceptedRoundKeys:e.roundKeys,receiverNormalizedPayloadHash:receipt.receiverNormalizedPayloadHash})}}})
 for(let i=0;i<3;i++)assert.equal(await p.tick(),true)
 assert.equal(callbacks,3); assert.ok(a.snapshot().dropped>=4)
 await waitFor(()=>a.snapshot().childPid===null&&a.snapshot().dropped>=68)
 assert.equal(a.snapshot().lastError,'write_timeout')
 }finally{await a?.close();assert.ok(!child||child.exitCode!==null||child.signalCode!==null);await rm(dir,{recursive:true,force:true})}
})
test('legacy missing metadata and oversized records latch gap without invented receipt',async()=>{
 const {createDeliveryAudit}=await import('../src/delivery-audit.js');const a=createDeliveryAudit({queuePath:'unused'})
 try{assert.equal(a.enqueue({...receipt,ackReceivedAtMs:undefined}),false);assert.equal(a.enqueue({...receipt,sessionId:'x'.repeat(16385)}),false);assert.equal(a.snapshot().gap,true);assert.equal(a.snapshot().saved,0);assert.equal(a.snapshot().childPid,null)}finally{await a.close()}
})
test('production root enables only explicit env and owns audit shutdown',async()=>{
 const {createDeliveryAuditFromEnv}=await import('../src/delivery-audit.js')
 assert.equal(createDeliveryAuditFromEnv({env:{},queuePath:'unused'}),null)
 assert.equal(createDeliveryAuditFromEnv({env:{PUSH_DELIVERY_AUDIT_ENABLED:'1'},queuePath:'unused'}),null)
 const sourceText=await readFile(new URL('../src/server.js',import.meta.url),'utf8')
 assert.match(sourceText,/createDeliveryAuditFromEnv\(\{ queuePath: PUSH_QUEUE_PATH \}\)/)
 assert.match(sourceText,/deliveryAudit: deliveryAudit/);assert.match(sourceText,/await deliveryAudit\?\.close\(\)/)
 assert.doesNotMatch(sourceText,/deliveryReceiptJournal:/)
 const a=createDeliveryAuditFromEnv({env:{PUSH_DELIVERY_AUDIT_ENABLED:'true'},queuePath:'unused'});try{assert.equal(a.snapshot().enabled,true)}finally{await a.close()}
})
test('disk reserve, ENOSPC and retention only affect versioned audit files',async()=>{
 const {createAuditDiskWriter}=await import('../src/delivery-audit-child.js');const fs=await import('node:fs')
 const dir=await mkdtemp(path.join(tmpdir(),'audit-disk-'));const folder=path.join(dir,'q.delivery-audit-v1');let writer
 try{
 writer=createAuditDiskWriter(folder,{io:{...fs,statfsSync:()=>({bavail:1,bsize:4096})}})
 assert.throws(()=>writer.append(receipt),/disk_reserve/);writer.close()
 writer=createAuditDiskWriter(folder,{io:{...fs,writeSync:()=>{throw Object.assign(Error('full'),{code:'ENOSPC'})}}})
 assert.throws(()=>writer.append(receipt),{code:'ENOSPC'});writer.close()
 fs.writeFileSync(path.join(folder,'unrelated'),'keep');fs.writeFileSync(path.join(dir,'q'),'queue')
 for(let i=1;i<=5;i++)fs.writeFileSync(path.join(folder,`receipt-${i}-aaaa.jsonl`),'old')
 writer=createAuditDiskWriter(folder);writer.append(receipt);writer.close()
 assert.equal(fs.readFileSync(path.join(folder,'unrelated'),'utf8'),'keep');assert.equal(fs.readFileSync(path.join(dir,'q'),'utf8'),'queue')
 assert.ok((await readdir(folder)).filter(n=>n.endsWith('.jsonl')).length<=4)
 }finally{writer?.close();await rm(dir,{recursive:true,force:true})}
})

test('public health keeps audit incomplete independently from source readiness',async()=>{
 const {buildWorkerHealth}=await import('../src/worker-health.js')
 const audit={enabled:true,gap:true,auditComplete:false,scope:'this_process_saved_receipts_only',powerLossWindow:'unknown',saved:1,dropped:1}
 const h=buildWorkerHealth({configured:true,expectedTableCount:1,nowMs:1000,source:{connected:true,authenticated:true,tableCount:1,sourceProgressAt:new Date(1000).toISOString()},push:{deliveryAudit:audit}})
 assert.equal(h.ok,true);assert.deepEqual(h.push.deliveryAudit,audit)
})
test('real child restart enforces cooldown and rolling three restart ceiling',async()=>{
 const {createDeliveryAudit}=await import('../src/delivery-audit.js');const {fork}=await import('node:child_process')
 const dir=await mkdtemp(path.join(tmpdir(),'audit-restarts-'));let clock=1000000;const children=[];let a
 try{
 a=createDeliveryAudit({queuePath:path.join(dir,'q'),now:()=>clock,spawnChild:(...args)=>{const c=fork(...args);children.push(c);return c}})
 a.enqueue(receipt);await waitFor(()=>a.snapshot().saved===1)
 for(let i=0;i<3;i++){
 children.at(-1).kill('SIGKILL');await waitFor(()=>a.snapshot().childPid===null)
 a.enqueue({...receipt,sequence:i+2});await new Promise(r=>setImmediate(r));assert.equal(children.length,i+1)
 clock+=30001;a.enqueue({...receipt,sequence:10+i});await waitFor(()=>children.length===i+2&&a.snapshot().queuedRecords===0)
 }
 children.at(-1).kill('SIGKILL');await waitFor(()=>a.snapshot().childPid===null)
 clock+=30001;a.enqueue({...receipt,sequence:99});await new Promise(r=>setImmediate(r));assert.equal(children.length,4)
 assert.equal(a.snapshot().restarts,3);assert.equal(a.snapshot().gap,true)
 }finally{await a?.close();assert.ok(children.every(c=>c.exitCode!==null||c.signalCode!==null));await rm(dir,{recursive:true,force:true})}
})
test('actual production construction block runs real child and Final callback',async()=>{
 const {createDeliveryAuditFromEnv}=await import('../src/delivery-audit.js');const vm=await import('node:vm')
 const src=await readFile(new URL('../src/server.js',import.meta.url),'utf8')
 const block=src.slice(src.indexOf('const deliveryAudit ='),src.indexOf('const server ='))
 const dir=await mkdtemp(path.join(tmpdir(),'audit-root-'));let a;let acknowledged=0
 try{
 const context={createDeliveryAuditFromEnv:options=>{a=createDeliveryAuditFromEnv({...options,env:{PUSH_DELIVERY_AUDIT_ENABLED:'true'}});return a},
 createSnapshotPusher:options=>createSnapshotPusher({...options,fetchImpl:async(_u,o)=>{const e=JSON.parse(o.body);return {status:200,json:async()=>({accepted:true,sessionId:e.sessionId,sequence:e.sequence,source,acceptedRoundKeys:e.roundKeys,receiverNormalizedPayloadHash:receipt.receiverNormalizedPayloadHash})}}}),
 process:{env:{PUSH_TARGET_URL:'https://offline.invalid',INGEST_KEY:'f'}},PUSH_QUEUE_PATH:path.join(dir,'q'),PUSH_CURSOR_PATH:path.join(dir,'cursor'),
 getOwnedSnapshot:async()=>({sessionId:'s',source,tables:[],rounds:[]}),isFinalRealCardRound:()=>true,acknowledgeOwnedSnapshot:async()=>acknowledged++,archiveOwnedSnapshot:async()=>{},rebindOwnedQueue:async()=>{}}
 const p=vm.runInNewContext(block+';snapshotPusher',context)
 assert.equal(await p.tick(),true);await waitFor(()=>a.snapshot().saved===2);assert.equal(a.snapshot().producerSaved,1);assert.equal(acknowledged,1)
 }finally{await a?.close();await rm(dir,{recursive:true,force:true})}
})
test('capacity rotation is four bounded segments and 24h expiry never touches Queue',async()=>{
 const {createAuditDiskWriter}=await import('../src/delivery-audit-child.js');const fs=await import('node:fs')
 const dir=await mkdtemp(path.join(tmpdir(),'audit-rotate-'));const folder=path.join(dir,'q.delivery-audit-v1');let writer;let clock=100000000
 try{
 fs.mkdirSync(folder);for(let i=0;i<4;i++)fs.writeFileSync(path.join(folder,`receipt-${clock-i}-aaaa.jsonl`),'old')
 writer=createAuditDiskWriter(folder,{now:()=>clock,io:{...fs,lstatSync:p=>{const s=fs.lstatSync(p);if(p.endsWith('.jsonl'))s.size=8388608;return s}}})
 writer.append(receipt);writer.append({...receipt,sequence:2});assert.equal((await readdir(folder)).length,4)
 clock+=86400001;writer.append({...receipt,sequence:3});assert.equal((await readdir(folder)).length,1)
 }finally{writer?.close();await rm(dir,{recursive:true,force:true})}
})

test('spawn error close without exit releases child ownership and shutdown',async()=>{
 const {createDeliveryAudit}=await import('../src/delivery-audit.js');const {EventEmitter}=await import('node:events')
 let c;const a=createDeliveryAudit({queuePath:'unused',spawnChild:()=>{c=new EventEmitter();c.pid=123;c.send=()=>true;c.kill=()=>false;return c}})
 try{a.enqueue(receipt);await new Promise(r=>setImmediate(r));c.emit('error',Error('spawn failed'));c.emit('close',-1,null);assert.equal(a.snapshot().childPid,null);assert.equal(a.snapshot().gap,true)}finally{if(a.snapshot().childPid!==null)c.emit('exit',-1,null);await a.close()}
})

test('production shutdown closes audit even if producer quiesce rejects',async()=>{
 const vm=await import('node:vm');const src=await readFile(new URL('../src/server.js',import.meta.url),'utf8');let closes=0
 const context={apiStartupController:null,sourceRuntime:null,backupJournalRuntime:null,browserSourceRuntime:null,snapshotPusher:null,process:{env:{}},quiesceWorkerProducers:async()=>{throw Error('quiesce failure')},deliveryAudit:{close:async()=>closes++},server:{close:()=>{}},browserPromise:null}
 const stop=vm.runInNewContext(src.slice(src.indexOf('let shutdownPromise ='))+';shutdown',context)
 await assert.rejects(stop(),/quiesce failure/);assert.equal(closes,1)
})
