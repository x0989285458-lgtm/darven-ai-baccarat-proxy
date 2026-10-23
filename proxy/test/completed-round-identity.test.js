import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCloudCapturePayload } from '../src/cloud-capture.js'
import { createV105FormalRuntime } from '../src/v105-formal-runtime.js'

test('API worker completed zero survives receiver and issues first round, not second', async () => {
  const raw = { table_id:'BAV06', tableId:'BAV06', table_type:'BAC', shoe:2379, round:0,
    trend:{ current_shoe:2379, current_round:1, total_round:0 } }
  const [table] = parseCloudCapturePayload({tables:[raw],rounds:[]}).tables
  const runtime = createV105FormalRuntime({allowUnconfigured:true})
  const prediction = await runtime.buildPrediction(table)
  assert.equal(prediction.targetRound, 1)
  assert.equal(table.round, 0)
  assert.equal(table.roundBasis, 'completed')
})


test('real app publishes exact first-round prediction after a completed-zero shoe transition', async () => {
  const { createApp } = await import('../src/server.js')
  const issued = new Map()
  const at = new Date().toISOString()
  const key = p => `${p.targetTableId}:${p.targetShoe}:${p.targetRound}`
  const writer = { configured:true,
    async issuePrediction(candidate) {
      const p = {...candidate,predictionId:key(candidate),issuedAt:at}
      issued.set(key(p),p); return p
    },
    async readIssuedPrediction({tableId,shoe,round}) { return issued.get(`${tableId}:${shoe}:${round}`) ?? null },
  }
  const app=createApp({autoConnect:false,supabaseClient:writer})
  const raw=(shoe,completed,current)=>({table_id:'BAV06',table_type:'BAC',shoe,round:completed,
    trend:{current_shoe:shoe,current_round:current,total_round:completed}})
  try {
    app.state.setTables(parseCloudCapturePayload({tables:[raw(2378,55,56)]}).tables)
    await app.inject({url:'/api/tables'})
    app.state.setTables(parseCloudCapturePayload({tables:[raw(2379,0,1)]}).tables)
    const [visible]=JSON.parse((await app.inject({url:'/api/tables'})).body)
    assert.equal(visible.round,1,'public screen must be the next uncompleted round')
    assert.equal(visible.prediction?.targetRound,1)
    assert.equal(String(visible.prediction?.targetShoe),'2379')
    assert.ok(issued.has('BAV06:2379:1'))
    assert.equal(issued.has('BAV06:2379:2'),false,'never preissue round2 with no Final1 context')
    app.state.setTables(parseCloudCapturePayload({tables:[raw(2379,1,2)]}).tables)
    const [second]=JSON.parse((await app.inject({url:'/api/tables'})).body)
    assert.equal(second.round,2)
    assert.equal(second.prediction?.targetRound,2)
    assert.equal(issued.has('BAV06:2379:3'),false)

  } finally { await app.stop() }
})


test('completed identity survives durable replay and a Final ahead of catalog', async () => {
  const {applyCloudCapturePayload}=await import('../src/cloud-capture.js')
  const raw={table_id:'BAV06',table_type:'BAC',shoe:2379,round:0,trend:{current_shoe:2379,current_round:1,total_round:0}}
  const parsed=parseCloudCapturePayload({tables:[raw],rounds:[]})
  assert.equal(parseCloudCapturePayload({tables:parsed.tables}).tables[0].roundBasis,'completed','reparse preserves semantic identity')
  const result=await applyCloudCapturePayload({
    parsed:{...parsed,rounds:[{tableId:'BAV06',shoe:2379,round:1,winner:'banker',sourceAction:'summary',rawResult:[1,2,3,4,0,0,-1,-1,4,6]}]},
    state:{settleRoundEvent:async()=>({ok:true})},writer:{configured:false},persistAncillary:false,publishSnapshot:false,
  })
  assert.equal(result.tables[0].round,1)
  assert.equal(result.tables[0].roundBasis,'completed','Final mount preserves completed basis for public next-round projection')
})


test('read-only SSE refresh finds late first issuance using completed-screen identity', async () => {
  const {createApp}=await import('../src/server.js')
  const {buildLivePrediction}=await import('../src/supabase-writer.js')
  const table={tableId:'BAV06',shoe:2380,round:0,roundBasis:'completed',sourceUpdatedAt:new Date().toISOString()}
  const exact={...buildLivePrediction(table),predictionId:'first-durable',issuedAt:new Date().toISOString()}
  let durable=false
  const app=createApp({autoConnect:false,port:0,captureOutboxConsumerEnabled:false,livePredictionReadWaitMs:50,streamHeartbeatMs:10000,
    supabaseClient:{configured:true,issuePrediction:async()=>assert.fail('read-only parent issued'),
      readIssuedPrediction:async({round})=>{assert.equal(round,1);return durable?exact:null}}})
  app.state.setTables([table]);await app.start()
  const controller=new AbortController()
  const reader=(await fetch(`http://127.0.0.1:${app.server.address().port}/api/tables/stream`,{signal:controller.signal})).body.getReader()
  let buffer=''
  async function next(){
    const until=Date.now()+3500
    while(!buffer.includes('\n\n')){
      let timer
      try {
        const item=await Promise.race([reader.read(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('bounded SSE refresh missing')),Math.max(1,until-Date.now()))})])
        buffer+=new TextDecoder().decode(item.value).replaceAll('\r\n','\n')
      }finally{clearTimeout(timer)}
    }
    const i=buffer.indexOf('\n\n');const event=buffer.slice(0,i);buffer=buffer.slice(i+2)
    return JSON.parse(event.split('\n').find(x=>x.startsWith('data:')).slice(5))
  }
  try {
    const initial=await next();assert.equal(initial.tables[0].round,1);assert.equal(initial.tables[0].prediction,null)
    durable=true
    const updated=await next();assert.equal(updated.tables[0].prediction?.predictionId,'first-durable')
    assert.equal(app.state.snapshot().tables[0].round,0,'projection must not mutate internal completed identity')
  }finally{controller.abort();await app.stop()}
})


for (const bad of [
  {round:true}, {shoe:true}, {round:-1}, {shoe:2380},
  {round:0,trend:{current_shoe:2379,current_round:2,total_round:1}},
  {trend:{current_shoe:2379,current_round:9,total_round:0}},
]) test(`reject inconsistent completed worker identity ${JSON.stringify(bad)}`,()=>{
  const raw={table_id:'BAV06',table_type:'BAC',shoe:2379,round:0,trend:{current_shoe:2379,current_round:1,total_round:0},...bad}
  assert.throws(()=>parseCloudCapturePayload({tables:[raw]}),/completed worker screen identity/)
})


test('completed-mode quarantines legacy visible snapshots until authoritative completed identity arrives', async () => {
  const {createApp}=await import('../src/server.js')
  const issued=new Map(); const reconciled=[]
  const app=createApp({autoConnect:false,captureRoundBasis:'completed',supabaseClient:{configured:true,
    reconcilePredictionLifecycle:async p=>{reconciled.push(p);return {ok:true}},
    issuePrediction:async p=>{const exact={...p,predictionId:`p${p.targetRound}`,issuedAt:new Date().toISOString()};issued.set(p.targetRound,exact);return exact},
    readIssuedPrediction:async({round})=>issued.get(round)??null}})
  try {
    app.state.setTables([{tableId:'BAV06',shoe:2380,round:1}])
    await app.inject({url:'/api/tables'})
    assert.deepEqual([...issued.keys()],[],'unmarked predecessor snapshot cannot create a premature issuance')
    app.state.setTables(parseCloudCapturePayload({tables:[{table_id:'BAV06',table_type:'BAC',shoe:2380,round:0,
      trend:{current_shoe:2380,current_round:1,total_round:0}}]}).tables)
    const [visible]=JSON.parse((await app.inject({url:'/api/tables'})).body)
    assert.equal(visible.round,1)
    assert.equal(visible.prediction?.targetRound,1)
    assert.equal(issued.has(1),true)
    app.state.setTables([{tableId:'BAV06',shoe:2380,round:1,roundBasis:'completed'}])
    const [second]=JSON.parse((await app.inject({url:'/api/tables'})).body)
    assert.equal(second.prediction?.targetRound,2)
    assert.equal(issued.has(3),false)
    assert.ok(reconciled.every(p=>p.currentVisibleRound>=1))
  } finally {await app.stop()}
})


for (const [scenario,previous] of [
  ['no catalog',[]],
  ['old shoe',[{table_id:'BAV06',table_type:'BAC',shoe:2379,round:55,trend:{current_shoe:2379,current_round:56,total_round:55}}]],
  ['legacy same round',[{tableId:'BAV06',shoe:2380,round:1}]],
]) {
  test(`Final screen owns completed identity without same-shoe catalog (${scenario})`,async()=>{
    const {applyCloudCapturePayload}=await import('../src/cloud-capture.js')
    const {createApp}=await import('../src/server.js')
    const parsed=parseCloudCapturePayload({tables:previous,rounds:[{tableId:'BAV06',shoe:2380,round:1,
      winner:'banker',sourceAction:'summary',rawResult:[1,2,3,4,0,0,-1,-1,4,6]}]})
    const result=await applyCloudCapturePayload({parsed,completedRoundIdentity:true,state:{settleRoundEvent:async()=>({ok:true})},
      writer:{configured:false},persistAncillary:false,publishSnapshot:false})
    const issued=new Map()
    const app=createApp({autoConnect:false,supabaseClient:{configured:true,
      issuePrediction:async p=>{const q={...p,predictionId:'p'+p.targetRound,issuedAt:new Date().toISOString()};issued.set(p.targetRound,q);return q},
      readIssuedPrediction:async({round})=>issued.get(round)??null}})
    try {
      app.state.setTables(result.tables)
      const [screen]=JSON.parse((await app.inject({url:'/api/tables'})).body)
      assert.equal(screen.shoe,2380)
      assert.equal(screen.round,2)
      assert.equal(screen.prediction?.targetRound,2)
      assert.equal(result.tables[0].roundBasis,'completed')
      assert.deepEqual([...issued.keys()],[2])
    }finally{await app.stop()}
  })
}


test('production refresh upgrades legacy snapshots and issues completed-zero for every table without HTTP reads',async()=>{
  const {createApp}=await import('../src/server.js')
  const ids=['BAV01','BAV02','BAV03','BAV03A','BAV05','BAV06']
  const at=new Date().toISOString();const issued=new Map();let upgraded=false
  const runtime=createV105FormalRuntime({allowUnconfigured:true});await runtime.start()
  const app=createApp({autoConnect:false,production:true,memberAuthRequired:false,captureRoundBasis:'completed',
    v104FormalRuntime:runtime,v100FormalRuntime:{enabled:true,processSnapshot:async({tables})=>({tables})},
    supabaseClient:{configured:true,getRuntimeStatus:()=>({ready:true,degraded:false}),
      getLatestCloudTableSnapshot:async()=>({snapshot_at:at,capture_source:'cloud_browser',tables:ids.map(tableId=>({
        tableId,shoe:2380,round:upgraded?0:1,...(upgraded?{roundBasis:'completed'}:{}),sourceUpdatedAt:at}))}),
      reconcilePredictionLifecycle:async()=>{},
      issuePrediction:async p=>{const q={...p,predictionId:`${p.targetTableId}:${p.targetRound}`,issuedAt:at};issued.set(q.predictionId,q);return q},
      readIssuedPrediction:async({tableId,round})=>issued.get(`${tableId}:${round}`)??null}})
  try{
    await assert.rejects(app.refreshLatestDurablePredictions(),/completed round identity/)
    assert.equal(issued.size,0)
    app.state.setTables(ids.map(tableId=>({tableId,shoe:2380,round:1,sourceUpdatedAt:at})))
    upgraded=true
    await app.refreshLatestDurablePredictions()
    assert.deepEqual([...issued.keys()].sort(),ids.map(id=>`${id}:1`).sort())
    assert.ok(app.state.snapshot().tables.every(t=>t.round===0&&t.roundBasis==='completed'))
  }finally{await app.stop()}
})


test('existing future issuance blocks backward writes then reuses exact issuance when genuine context catches up',async()=>{
  const {createApp}=await import('../src/server.js')
  const runtime=createV105FormalRuntime({allowUnconfigured:true});await runtime.start()
  const prior={...await runtime.buildPrediction({tableId:'BAV06',shoe:2380,round:1}),
    predictionId:'immutable-existing-2',issuedAt:new Date().toISOString()}
  runtime.recordIssuance(prior)
  const before=runtime.latestIssuance('BAV06');const writes=[]
  const app=createApp({autoConnect:false,captureRoundBasis:'completed',v104FormalRuntime:runtime,
    supabaseClient:{configured:true,
      issuePrediction:async p=>{writes.push(p.targetRound);return {...p,predictionId:'unexpected',issuedAt:new Date().toISOString()}},
      readIssuedPrediction:async({round})=>round===2?structuredClone(prior):null}})
  try{
    app.state.setTables([{tableId:'BAV06',shoe:2380,round:0,roundBasis:'completed'}])
    const [first]=JSON.parse((await app.inject({url:'/api/tables'})).body)
    assert.equal(first.prediction,null)
    assert.deepEqual(writes,[],'monotonic fence must act before the durable writer, not after it')
    assert.deepEqual(runtime.latestIssuance('BAV06'),before)
    app.state.setTables([{tableId:'BAV06',shoe:2380,round:1,roundBasis:'completed'}])
    const [second]=JSON.parse((await app.inject({url:'/api/tables'})).body)
    assert.equal(second.prediction?.predictionId,prior.predictionId)
    assert.equal(second.prediction?.targetRound,2)
    assert.deepEqual(writes,[],'existing exact issuance must be read, never rebuilt or reissued')
    assert.deepEqual(runtime.latestIssuance('BAV06'),before)
  }finally{await app.stop()}
})
