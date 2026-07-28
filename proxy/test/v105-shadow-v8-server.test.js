import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'

const TABLE_IDS=['BAG01','BAG02','BAG03','BAG03A','BAG05','BAG06','BAG07','BAG08','BAG09','BAG10']
const table=(tableId='BAG01')=>({tableId,shoe:105,round:20,bankerCount:12,playerCount:8})

test('the same ten-table snapshot and Final fan out non-blockingly to V8 alongside V6 and V7', async () => {
  const seen={v6:[],v7:[],v8:[]}; const finals={v6:0,v7:0,v8:0}
  const runtime=(key)=>({enabled:true,async observeTable(value){seen[key].push(value.tableId)},async settleRound(){finals[key]+=1},snapshot:()=>({status:'ready'})})
  const app=createApp({autoConnect:false,supabaseClient:{configured:true},v105ShadowRuntime:runtime('v6'),v105ShadowV7Runtime:runtime('v7'),v105ShadowV8Runtime:runtime('v8')})
  app.state.setTables(TABLE_IDS.map(table)); await new Promise((resolve)=>setImmediate(resolve))
  app.state.upsertRoundEvent({...table(),round:21,sourceAction:'/summary',winner:'banker',rawResult:[1,9,2,10,0,0,-1,-1,3,9]}); await new Promise((resolve)=>setImmediate(resolve))
  assert.deepEqual(seen.v8,TABLE_IDS); assert.deepEqual(seen.v6,TABLE_IDS); assert.deepEqual(seen.v7,TABLE_IDS)
  assert.deepEqual(finals,{v6:1,v7:1,v8:1})
})

test('V8 issuance and Final errors do not block V6 or V7 fanout', async () => {
  let v6=0; let v7=0
  const ok={enabled:true,async observeTable(){},async settleRound(){},snapshot:()=>({status:'ready'})}
  const app=createApp({autoConnect:false,supabaseClient:{configured:true},v105ShadowRuntime:{...ok,async settleRound(){v6+=1}},v105ShadowV7Runtime:{...ok,async settleRound(){v7+=1}},v105ShadowV8Runtime:{enabled:true,observeTable(){throw new Error('v8 issue')},settleRound(){throw new Error('v8 final')},snapshot:()=>({status:'error'})}})
  app.state.setTables([table()]); await new Promise((resolve)=>setImmediate(resolve))
  app.state.upsertRoundEvent({...table(),round:21,sourceAction:'/show_win',winner:'banker',rawResult:[1,9,2,10,0,0,-1,-1,3,9]}); await new Promise((resolve)=>setImmediate(resolve))
  assert.equal(v6,1); assert.equal(v7,1)
})
