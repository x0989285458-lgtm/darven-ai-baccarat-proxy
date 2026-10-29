import test from 'node:test'
import assert from 'node:assert/strict'
import {createApp} from '../src/server.js'

const ids=['BAV01','BAV02','BAV03','BAV03A','BAV05','BAV06']
const headers={'x-forwarded-proto':'https'}
function harness(change=()=>{}) {
 const at=new Date(Date.now()-50).toISOString()
 const state={status:{capture_source:'cloud_browser',connected:true,authenticated:true,table_count:6,last_message_at:at,last_round_at:at},snapshot:{snapshot_at:at,tables:ids.map(tableId=>({tableId,shoe:88,round:7,roundBasis:'completed',sourceUpdatedAt:at}))},readError:false}
 change(state)
 let writes=0
 const forbidden=()=>{writes++;throw Error('read-only public cannot write')}
 const app=createApp({autoConnect:false,port:0,deployMode:'cloud',production:true,memberAuthRequired:false,requireVerifiedStrategy:true,ingestKey:'offline-only',captureOutboxConsumerEnabled:false,liveAtomicPublicationsEnabled:true,livePredictionReadWaitMs:25,
  supabaseClient:{configured:true,getRuntimeStatus(){return {ready:true,degraded:false,activeStrategyVersion:'v105'}},async readV105TablePublications(){return ids.map(tableId=>({table:{tableId,shoe:88,round:7,roundBasis:'completed',sourceUpdatedAt:at},prediction:null,publication:{state:'pending',observation:{epoch:'a'.repeat(64),snapshot:'30:30:'},observedAtMicros:'1790000000000001',revision:null,sourceCapturedAt:at,rawIdentity:{tableId,shoe:'88',round:8},readyIdentity:null}}))},async getLatestCloudCaptureStatus(){if(state.readError)throw Error('unavailable');return structuredClone(state.status)},async getLatestCloudTableSnapshot(){return structuredClone(state.snapshot)},issuePrediction:forbidden,publishV105TablePublication:forbidden,reconcilePredictionLifecycle:forbidden},
  v104FormalRuntime:{buildPrediction:forbidden,snapshot(){return {status:'ready'}}}})
 return {app,writes:()=>writes}
}

test('cold atomic read-only Public health hydrates authoritative capture status without ingest or issuance',async()=>{
 const {app,writes}=harness()
 try{
  const health=await app.inject({url:'/health',headers})
  assert.equal(health.statusCode,200,health.body)
  assert.equal(JSON.parse(health.body).ok,true)
  const status=JSON.parse((await app.inject({url:'/api/status',headers})).body)
  assert.equal(status.connected,true)
  assert.equal(status.authenticated,true)
  assert.equal(status.tableCount,6)
  assert.equal(status.publicationReadyCount,0)
  const tables=JSON.parse((await app.inject({url:'/api/tables',headers})).body)
  assert.equal(tables.length,6)
  assert.ok(tables.every(t=>t.screenUnavailable===true && t.prediction===undefined))
  assert.equal(writes(),0)
 }finally{await app.stop()}
})

for(const [name,change] of [
 ['disconnected',s=>{s.status.connected=false;s.status.table_count=0}],
 ['unauthenticated',s=>{s.status.authenticated=false}],
 ['stale final',s=>{s.status.last_round_at=new Date(Date.now()-600000).toISOString()}],
 ['missing progress',s=>{s.status.last_round_at=null}],
 ['stale status',s=>{s.status.last_message_at=new Date(Date.now()-600000).toISOString()}],
 ['stale snapshot',s=>{s.snapshot.snapshot_at=new Date(Date.now()-600000).toISOString()}],
 ['missing snapshot',s=>{s.snapshot=null}],
 ['partial inventory',s=>{s.snapshot.tables.pop()}],
 ['duplicate inventory',s=>{s.snapshot.tables[5]={...s.snapshot.tables[0]}}],
 ['unknown inventory',s=>{s.snapshot.tables[5].tableId='BAV99'}],
 ['status read error',s=>{s.readError=true}],
]) test(`atomic Public rejects ${name} even with publication inventory`,async()=>{
 const {app,writes}=harness(change)
 try{const result=await app.inject({url:'/health',headers});assert.equal(result.statusCode,503);assert.equal(JSON.parse(result.body).ok,false);assert.equal(writes(),0)}finally{await app.stop()}
})
