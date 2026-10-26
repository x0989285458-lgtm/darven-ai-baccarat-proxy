import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCloudCapturePayload, applyCloudCapturePayload } from '../src/cloud-capture.js'
import { createApp } from '../src/server.js'
import { buildCloudTableSnapshotRow } from '../src/supabase-writer.js'

const bundle = (patch = {}) => ({schemaVersion:1, tableId:'BAV06', shoe:'2379', completedRound:2, status:'available', reason:'complete', ...patch})
const raw = (metadata, round = 2) => ({table_id:'BAV06',table_type:'BAC',shoe:2379,round,
  trend:{current_shoe:2379,current_round:3,total_round:2,total_round_banker:2,total_round_player:0,total_round_tie:0,bead_plate2:'0202',big2:'0202',big_eye2:'',small2:'',cockroach2:'',next_banker2:{},next_player2:{}},
  ...(metadata === undefined ? {} : {trendBundle:metadata})})
const cases = [
  ['complete',bundle(),'available',2],
  ['missing',undefined,'pending',null],
  ['unknown schema',bundle({schemaVersion:2}),'pending',null],
  ['foreign table',bundle({tableId:'BAV05'}),'pending',null],
  ['fake available null',bundle({completedRound:null}),'pending',null],
  ['malformed round',bundle({completedRound:'2'}),'pending',null],
  ['different shoe',bundle({shoe:'2378'}),'pending',null],
  ['gap',bundle(), 'pending',2,4],
  ['source pending aligned',bundle({status:'pending',reason:'coverage-mismatch'}),'pending',2],
]
for (const [name,metadata,status,completedRound,round=2] of cases) test(`real parser -> state -> API/Writer: ${name}`,async()=>{
  const app=createApp({autoConnect:false,production:false,memberAuthRequired:false,captureOutboxConsumerEnabled:false,supabaseClient:{configured:false}})
  try {
    const parsed=parseCloudCapturePayload({tables:[raw(metadata,round)]})
    app.state.setTables(parsed.tables)
    const response=await app.inject({url:'/api/tables'})
    assert.equal(response.statusCode,200)
    const [screen]=JSON.parse(response.body)
    assert.equal(screen.round,round+1)
    assert.equal(screen.trendBundle?.status,status)
    assert.equal(screen.trendBundle?.completedRound,completedRound)
    assert.deepEqual(buildCloudTableSnapshotRow({tables:parsed.tables}).tables[0].trendBundle,screen.trendBundle)
    assert.deepEqual(parseCloudCapturePayload({tables:parsed.tables}).tables[0].trendBundle,screen.trendBundle)
  } finally {await app.stop()}
})

test('materialized Final with no bundle reaches ancillary Writer as explicit pending',async()=>{
  const app=createApp({autoConnect:false,production:false,memberAuthRequired:false,captureOutboxConsumerEnabled:false,supabaseClient:{configured:false}})
  let saved
  try {
    const parsed=parseCloudCapturePayload({tables:[raw(bundle())],rounds:[{tableId:'BAV06',shoe:2379,round:4,winner:'banker',sourceAction:'summary',rawResult:[1,2,3,4,0,0,-1,-1,4,6]}]})
    const result=await applyCloudCapturePayload({parsed,state:app.state,completedRoundIdentity:true,writer:{configured:true,writeCloudTableSnapshot:async input=>{saved=buildCloudTableSnapshotRow(input)}}})
    assert.equal(saved.tables[0].round,4)
    assert.equal(saved.tables[0].trendBundle?.status,'pending')
    assert.equal(saved.tables[0].trendBundle?.completedRound,null)
    assert.deepEqual(result.tables[0].trendBundle,saved.tables[0].trendBundle)
    assert.equal(JSON.parse((await app.inject({url:'/api/tables'})).body)[0].trendBundle.status,'pending')
  }finally{await app.stop()}
})

test('Final before tables invalidates available; same identity recovery reaches real HTTP SSE',async()=>{
  const app=createApp({autoConnect:false,production:false,memberAuthRequired:false,port:0,host:'127.0.0.1',captureOutboxConsumerEnabled:false,supabaseClient:{configured:false},streamHeartbeatMs:10000})
  const controller=new AbortController()
  try {
    app.state.setTables(parseCloudCapturePayload({tables:[raw(bundle())]}).tables)
    await app.state.upsertRoundEvent({tableId:'BAV06',shoe:2379,round:4,winner:'banker',sourceAction:'summary',rawResult:[1,2,3,4,0,0,-1,-1,4,6]})
    assert.equal(app.state.snapshot().tables[0].trendBundle.status,'pending')
    assert.equal(app.state.snapshot().tables[0].trendBundle.completedRound,2)
    await app.start()
    const response=await fetch(`http://127.0.0.1:${app.server.address().port}/api/tables/stream`,{signal:controller.signal})
    assert.equal(response.status,200)
    const reader=response.body.getReader();let buffer=''
    async function next(){
      while(!buffer.includes('\n\n')) {
        let timer
        try {const chunk=await Promise.race([reader.read(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('SSE timeout')),2500)})]);buffer+=new TextDecoder().decode(chunk.value).replaceAll('\r\n','\n')}
        finally {clearTimeout(timer)}
      }
      const i=buffer.indexOf('\n\n'),frame=buffer.slice(0,i);buffer=buffer.slice(i+2)
      return JSON.parse(frame.split('\n').find(line=>line.startsWith('data:')).slice(5))
    }
    assert.equal((await next()).tables[0].trendBundle.status,'pending')
    const recovered=raw(bundle({completedRound:4}),4);recovered.trend.total_round=4;recovered.trend.current_round=5
    app.state.setTables(parseCloudCapturePayload({tables:[recovered]}).tables)
    let latest
    for(let i=0;i<5;i++){latest=await next();if(latest.tables[0].trendBundle.status==='available')break}
    assert.equal(latest.tables[0].trendBundle.status,'available')
    assert.equal(latest.tables[0].round,5)
    assert.equal(latest.tables[0].trendBundle.completedRound,4)
  }finally{controller.abort();await app.stop()}
})
