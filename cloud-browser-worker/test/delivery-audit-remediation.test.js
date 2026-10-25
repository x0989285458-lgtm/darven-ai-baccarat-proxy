import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { createDeliveryAudit, AUDIT_POLICY } from '../src/delivery-audit.js'
const source={mode:'api',ownerId:'fixture',epoch:1,fence:'f'}
const receipt={sessionId:'s',sequence:1,source,acceptedRoundKeys:[],receiverNormalizedPayloadHash:'a'.repeat(64),ackReceivedAtMs:1234}
const next=()=>new Promise(r=>setImmediate(r))
for(const fault of ['IPC','timeout'])for(const replacement of ['new-child','next-entry'])test(`stale ${fault} callbacks do not own ${replacement}`,async t=>{
 let clock=100000;const children=[],callbacks=[],timeouts=[]
 const realTimeout=globalThis.setTimeout
 t.mock.method(globalThis,'setTimeout',(fn,ms,...args)=>{timeouts.push(fn);return realTimeout(fn,ms,...args)})
 const a=createDeliveryAudit({queuePath:'unused',now:()=>clock,spawnChild:()=>{
  const c=new EventEmitter();c.pid=10+children.length;c.kills=0;c.messages=[]
  c.send=(m,cb)=>{c.messages.push(m);callbacks.push(cb);return true}
  c.kill=()=>{c.kills++;setImmediate(()=>c.emit('close'));return true}
  children.push(c);return c
 }})
 try{
  a.enqueue(receipt);await next();const old=children[0]
  if(replacement==='new-child'){old.emit('close');clock+=30001}
  else old.emit('message',{id:old.messages[0].id,ok:true})
  a.enqueue({...receipt,sequence:2});await next();const current=children.at(-1)
  if(fault==='IPC')callbacks[0](Error('late send failure'));else timeouts[0]()
  if(replacement==='new-child'){old.emit('close');old.emit('error',Error('late child failure'))}
  assert.equal(current.kills,0,'stale callback must not kill current child/entry')
  assert.equal(a.snapshot().childPid,current.pid);assert.equal(a.snapshot().inflight,1)
  current.emit('message',{id:current.messages.at(-1).id,ok:true})
  assert.equal(a.snapshot().lastSaved.sequence,2)
 }finally{await a.close()}
})
test('late owned child error after bounded close never repeats kill',async()=>{
 let c,kills=0
 const a=createDeliveryAudit({queuePath:'unused',spawnChild:()=>{
  c=new EventEmitter();c.pid=42;c.send=()=>true;c.kill=()=>{kills++;return false};return c
 }})
 a.enqueue(receipt);await next();await a.close()
 try{c.emit('error',Error('late error'));assert.equal(kills,1);assert.equal(a.snapshot().childPid,42)}finally{c.emit('close')}
})

for(const mode of ['false','throw','never-close']) test(`bounded close ${mode} retains unconfirmed ownership and releases main shutdown`,async t=>{
 t.mock.timers.enable({apis:['setTimeout']})
 let child,kills=0,unrefs=0,channelUnrefs=0,serverClosed=false
 const audit=createDeliveryAudit({queuePath:'unused',spawnChild:()=>{
  child=new EventEmitter();child.pid=321;child.send=()=>true
  child.unref=()=>unrefs++;child.channel={unref:()=>channelUnrefs++}
  child.kill=()=>{kills++;if(mode==='throw')throw Error('kill failed');return mode!=='false'}
  return child
 }})
 audit.enqueue(receipt);await next()
 const text=await readFile(new URL('../src/server.js',import.meta.url),'utf8')
 const context={apiStartupController:null,sourceRuntime:null,backupJournalRuntime:null,browserSourceRuntime:null,snapshotPusher:null,process:{env:{},exit:()=>{}},quiesceWorkerProducers:async()=>{},deliveryAudit:audit,server:{close:()=>{serverClosed=true}},browserPromise:null}
 const shutdown=vm.runInNewContext(text.slice(text.indexOf('let shutdownPromise ='))+';shutdown',context)
 const closing=audit.close();let settled=false,rejected=null
 closing.then(()=>{settled=true},e=>{rejected=e})
 const main=shutdown();main.catch(()=>{})
 const concurrent=audit.close();concurrent.catch(()=>{})
 t.mock.timers.tick(AUDIT_POLICY.deadlineMs+1);await next()
 try{
  assert.equal(rejected,null,'audit kill failure must not reject shutdown')
  assert.equal(settled,true,'close must settle by explicit deadline without child close')
  assert.equal(closing,concurrent,'all close callers share the same promise')
  assert.equal(serverClosed,true,'actual main shutdown reaches server.close')
  assert.equal(kills,1,'one termination attempt')
  assert.equal(unrefs,1);assert.equal(channelUnrefs,1)
  const state=audit.snapshot();assert.equal(state.childPid,321);assert.equal(state.gap,true)
  assert.ok(state.gapReasons.includes('shutdown_child_unconfirmed'));assert.equal(state.auditComplete,false)
  assert.equal(state.queuedRecords,0);assert.equal(audit.enqueue(receipt),false)
  child.emit('close');assert.equal(audit.snapshot().childPid,null)
  assert.ok(audit.snapshot().gapReasons.includes('shutdown_child_unconfirmed'))
  assert.equal(audit.close(),closing);await main
 }finally{child.emit('close');await Promise.allSettled([closing,concurrent,main])}
})
