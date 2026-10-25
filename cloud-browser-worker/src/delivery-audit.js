import { fork } from 'node:child_process'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
export const AUDIT_POLICY = Object.freeze({ maxRecords:64, maxBytes:1048576, maxRecordBytes:16384, deadlineMs:2000, cooldownMs:30000, restartWindowMs:300000, maxRestarts:3 })
// No filesystem calls or awaited work in the owning capture process.
export function createDeliveryAudit({ queuePath, spawnChild = fork, now = Date.now } = {}) {
 const directory=path.resolve(`${queuePath}.delivery-audit-v1`)
 const queue=[]; let bytes=0, child=null, inflight=null, timer=null, wake=null, scheduled=false, closed=false, started=false, nextStart=0
 let saved=0,dropped=0,gap=false,lastError=null,lastSaved=null,terminating=false; const restarts=[]
 const auditRunId=randomUUID(); let attempted=0,admitted=0,producerAdmitted=0,producerSaved=0,lastSavedAuditSequence=0
 const gapReasons=new Set()
 function markGap(reason){gap=true;lastError=reason;if(gapReasons.size<32)gapReasons.add(reason)}
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
    c.on('message',m=>{if(child!==c)return;if(m?.gap){markGap(m.gap);return}if(!inflight)return;if(m?.id!==inflight.id)return;if(m.ok!==true){lose(m?.error==='ENOSPC'?'ENOSPC':m?.error==='disk_reserve'?'disk_reserve':'child_error');return}
     saved++;if(inflight.record.type==='producer_envelope')producerSaved++;lastSavedAuditSequence=inflight.record.auditSequence;lastSaved={sessionId:inflight.record.sessionId,sequence:inflight.record.sequence,ackReceivedAtMs:inflight.record.ackReceivedAtMs,receiverNormalizedPayloadHash:inflight.record.receiverNormalizedPayloadHash};bytes-=inflight.bytes;queue.shift();inflight=null;clearTimeout(timer);timer=null;schedule()})
    c.on('error',()=>{if(child!==c)return;if(closed){markGap('shutdown_child_unconfirmed');return}if(!terminating)lose('child_error')})
    c.on('close',()=>{if(child!==c)return;child=null;const expected=terminating;terminating=false;if(!closed){if(!expected)lose('child_exit');schedule()}})
   }catch{child=null;lose('spawn_error');schedule();return}
  }
  inflight=queue[0]
  const sendingChild=child,entry=inflight
  const ownsSend=()=>!closed&&!terminating&&child===sendingChild&&inflight===entry
  timer=setTimeout(()=>{if(ownsSend())lose('write_timeout')},AUDIT_POLICY.deadlineMs);timer.unref?.()
  try{if(sendingChild.send({id:entry.id,record:entry.record},e=>{if(e&&ownsSend())lose('ipc_error')})===false&&ownsSend())lose('ipc_backpressure')}catch{if(ownsSend())lose('ipc_error')}
 }
 let id=0
 function enqueue(r,producer=false){
  const auditSequence=++attempted
  if(closed){dropped++;markGap('closed');return false}
  const s=r?.source,keys=producer?r?.roundKeys:r?.acceptedRoundKeys
  if(typeof r?.sessionId!=='string'||!r.sessionId||!Number.isSafeInteger(r.sequence)||r.sequence<1||!Array.isArray(keys)||keys.some(k=>typeof k!=='string'||!k)||(!producer&&(typeof r.receiverNormalizedPayloadHash!=='string'||!/^[a-f0-9]{64}$/.test(r.receiverNormalizedPayloadHash)||!Number.isSafeInteger(r.ackReceivedAtMs)||r.ackReceivedAtMs<0))||!s||!['api','browser','replay'].includes(s.mode)||typeof s.ownerId!=='string'||!s.ownerId||!Number.isSafeInteger(s.epoch)||s.epoch<1||typeof s.fence!=='string'||!s.fence){dropped++;markGap('legacy_missing_metadata');return false}
  // Bound strings before allocation/serialization, including oversized Final key batches.
  if(keys.length>1024||r.sessionId.length+s.ownerId.length+s.fence.length+keys.reduce((n,k)=>n+k.length,0)>16384){dropped++;markGap('record_capacity');return false}
  const record={version:1,auditRunId,auditSequence,admittedTotal:admitted+1,type:producer?'producer_envelope':'delivery_ack',sessionId:r.sessionId,sequence:r.sequence,source:{mode:s.mode,ownerId:s.ownerId,epoch:s.epoch,fence:s.fence},...(producer?{roundKeys:[...keys]}:{acceptedRoundKeys:[...keys],receiverNormalizedPayloadHash:r.receiverNormalizedPayloadHash,ackReceivedAtMs:r.ackReceivedAtMs})}
  const size=Buffer.byteLength(JSON.stringify(record)+'\n')
  if(size>AUDIT_POLICY.maxRecordBytes||queue.length>=64||bytes+size>1048576){dropped++;markGap('capacity');return false}
  admitted++;if(producer)producerAdmitted++;queue.push({id:++id,record,bytes:size});bytes+=size;schedule();return true
 }
 let closePromise=null
 function close(){
  if(closePromise)return closePromise
  let resolveClose
  closePromise=new Promise(resolve=>{resolveClose=resolve})
  closed=true;clearTimeout(wake);clearTimeout(timer);wake=null;timer=null
  if(queue.length){dropped+=queue.length;markGap('shutdown_unsaved');queue.length=0;bytes=0;inflight=null}
  const c=child
  if(!c){resolveClose();return closePromise}
  terminating=true
  let settled=false,confirmationTimer=null
  const finish=confirmed=>{
   if(settled)return;settled=true;clearTimeout(confirmationTimer);c.removeListener('close',confirmedClose)
   if(!confirmed){
    markGap('shutdown_child_unconfirmed')
    // Retain child ownership until its actual close. Do not pin main shutdown
    // on an unconfirmed audit child or its IPC channel.
    try{c.channel?.unref?.()}catch{}
    try{c.unref?.()}catch{}
   }
   resolveClose()
  }
  const confirmedClose=()=>finish(true)
  c.once('close',confirmedClose)
  confirmationTimer=setTimeout(()=>finish(false),AUDIT_POLICY.deadlineMs)
  try{if(c.kill('SIGKILL')===false)finish(false)}catch{finish(false)}
  return closePromise
 }
 return {enqueue,enqueueProducer:r=>enqueue(r,true),markGap,close,snapshot:()=>({enabled:true,scope:'this_process_saved_events_only',auditComplete:false,powerLossWindow:'unknown',auditRunId,attempted,admitted,producerAdmitted,producerSaved,lastSavedAuditSequence,gap,gapReasons:[...gapReasons],saved,dropped,lastError,lastSaved,queuedRecords:queue.length,queuedBytes:bytes,inflight:inflight?1:0,restarts:restarts.length,childPid:child?.pid??null})}
}
export function createDeliveryAuditFromEnv({env=process.env,queuePath,...options}={}){
 return env.PUSH_DELIVERY_AUDIT_ENABLED==='true'?createDeliveryAudit({queuePath,...options}):null
}
