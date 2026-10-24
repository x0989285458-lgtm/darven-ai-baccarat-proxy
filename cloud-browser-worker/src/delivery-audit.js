import { fork } from 'node:child_process'
import path from 'node:path'
export const AUDIT_POLICY = Object.freeze({ maxRecords:64, maxBytes:1048576, maxRecordBytes:16384, deadlineMs:2000, cooldownMs:30000, restartWindowMs:300000, maxRestarts:3 })
// No filesystem calls or awaited work in the owning capture process.
export function createDeliveryAudit({ queuePath, spawnChild = fork, now = Date.now } = {}) {
 const directory=path.resolve(`${queuePath}.delivery-audit-v1`)
 const queue=[]; let bytes=0, child=null, inflight=null, timer=null, wake=null, scheduled=false, closed=false, started=false, nextStart=0
 let saved=0,dropped=0,gap=false,lastError=null,lastSaved=null,terminating=false; const restarts=[]
 function markGap(reason){gap=true;lastError=reason}
 function schedule(){if(!scheduled&&!closed){scheduled=true;setImmediate(()=>{scheduled=false;pump()})}}
 function lose(reason){markGap(reason); dropped+=queue.length;queue.length=0;bytes=0;inflight=null;clearTimeout(timer);timer=null;nextStart=now()+AUDIT_POLICY.cooldownMs;if(child){terminating=true;child.kill('SIGKILL')}}
 function pump(){
  if(closed||terminating||inflight||!queue.length)return
  if(!child){
   const ts=now();while(restarts.length&&restarts[0]<=ts-AUDIT_POLICY.restartWindowMs)restarts.shift()
   const allowed=Math.max(nextStart,started&&restarts.length>=3?restarts[0]+AUDIT_POLICY.restartWindowMs:0)
   if(ts<allowed){clearTimeout(wake);wake=setTimeout(schedule,Math.max(1,allowed-ts));wake.unref?.();return}
   if(started)restarts.push(ts);started=true
   try {
    const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>/^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|HOME)$/i.test(k)))
    const c=spawnChild(new URL('./delivery-audit-child.js',import.meta.url),[directory],{stdio:['ignore','ignore','ignore','ipc'],env,execArgv:[],windowsHide:true}); child=c
    c.on('message',m=>{if(child!==c||!inflight)return;if(m?.id!==inflight.id)return;if(m.ok!==true){lose(m?.error==='ENOSPC'?'ENOSPC':m?.error==='disk_reserve'?'disk_reserve':'child_error');return}
     saved++;lastSaved={sessionId:inflight.record.sessionId,sequence:inflight.record.sequence,ackReceivedAtMs:inflight.record.ackReceivedAtMs,receiverNormalizedPayloadHash:inflight.record.receiverNormalizedPayloadHash};bytes-=inflight.bytes;queue.shift();inflight=null;clearTimeout(timer);timer=null;schedule()})
    c.on('error',()=>{if(child===c)lose('child_error')})
    c.on('close',()=>{if(child!==c)return;child=null;const expected=terminating;terminating=false;if(!closed){if(!expected)lose('child_exit');schedule()}})
   }catch{child=null;lose('spawn_error');schedule();return}
  }
  inflight=queue[0];timer=setTimeout(()=>lose('write_timeout'),AUDIT_POLICY.deadlineMs);timer.unref?.()
  try{child.send({id:inflight.id,record:inflight.record},e=>{if(e&&inflight)lose('ipc_error')})}catch{lose('ipc_error')}
 }
 let id=0
 function enqueue(r){
  if(closed){dropped++;markGap('closed');return false}
  const s=r?.source
  if(typeof r?.sessionId!=='string'||!r.sessionId||!Number.isSafeInteger(r.sequence)||r.sequence<1||!Array.isArray(r.acceptedRoundKeys)||r.acceptedRoundKeys.some(k=>typeof k!=='string'||!k)||typeof r.receiverNormalizedPayloadHash!=='string'||!/^[a-f0-9]{64}$/.test(r.receiverNormalizedPayloadHash)||!Number.isSafeInteger(r.ackReceivedAtMs)||r.ackReceivedAtMs<0||!s||!['api','browser','replay'].includes(s.mode)||typeof s.ownerId!=='string'||!s.ownerId||!Number.isSafeInteger(s.epoch)||s.epoch<1||typeof s.fence!=='string'||!s.fence){dropped++;markGap('legacy_missing_metadata');return false}
  // Bound strings before allocation/serialization, including oversized Final key batches.
  if(r.sessionId.length+s.ownerId.length+s.fence.length+r.acceptedRoundKeys.reduce((n,k)=>n+k.length,0)>16384||r.acceptedRoundKeys.length>1024){dropped++;markGap('record_capacity');return false}
  const record={version:1,type:'delivery_ack',sessionId:r.sessionId,sequence:r.sequence,source:{mode:s.mode,ownerId:s.ownerId,epoch:s.epoch,fence:s.fence},acceptedRoundKeys:[...r.acceptedRoundKeys],receiverNormalizedPayloadHash:r.receiverNormalizedPayloadHash,ackReceivedAtMs:r.ackReceivedAtMs}
  const size=Buffer.byteLength(JSON.stringify(record)+'\n')
  if(size>AUDIT_POLICY.maxRecordBytes||queue.length>=64||bytes+size>1048576){dropped++;markGap('capacity');return false}
  queue.push({id:++id,record,bytes:size});bytes+=size;schedule();return true
 }
 async function close(){
  if(closed&&!child)return;closed=true;clearTimeout(wake);clearTimeout(timer)
  if(queue.length){dropped+=queue.length;markGap('shutdown_unsaved');queue.length=0;bytes=0;inflight=null}
  const c=child;if(!c)return
  await new Promise(resolve=>{c.once('close',resolve);c.kill('SIGKILL')})
 }
 return {enqueue,markGap,close,snapshot:()=>({enabled:true,scope:'this_process_saved_receipts_only',auditComplete:false,powerLossWindow:'unknown',gap,saved,dropped,lastError,lastSaved,queuedRecords:queue.length,queuedBytes:bytes,inflight:inflight?1:0,restarts:restarts.length,childPid:child?.pid??null})}
}
export function createDeliveryAuditFromEnv({env=process.env,queuePath,...options}={}){
 return env.PUSH_DELIVERY_AUDIT_ENABLED==='true'?createDeliveryAudit({queuePath,...options}):null
}
