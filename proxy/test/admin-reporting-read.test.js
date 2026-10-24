import test from 'node:test'
import assert from 'node:assert/strict'
import {createLicenseAdminClient} from '../src/license-admin.js'
import {createApp} from '../src/server.js'
const ids=['BAV01','BAV02','BAV03','BAV03A','BAV05','BAV06']
const row={table_id:'BAV01',rounds:1501,main_total:1000,main_hits:500,banker_total:600,banker_hits:300,player_total:400,player_hits:200,side_actions:4,side_hits:1,tie_total:1,tie_hits:0,dragon_total:1,dragon_hits:1,pair_total:2,pair_hits:0,six_total:0,six_hits:0,side_actions_available:true}
test('admin report uses one narrow materialized repeatable six-table snapshot above REST cap',async()=>{
 const calls=[];const client=createLicenseAdminClient({pool:snapshotPool({async query(sql,params){calls.push({sql,params});return {rows:[row]}}})})
 const value=await client.getDailyAnalytics()
 assert.equal(calls.length,6)
 assert.match(calls[0].sql,/scoped as materialized/i)
 assert.match(calls[0].sql,/jsonb_build_object\('side_actions',\s*prediction_features->'side_actions'/i)
 assert.match(calls[0].sql,/table_id\s*=\s*any\(\$2::text\[\]\)/i)
 assert.deepEqual(calls[0].params.slice(0,2),['v105',[ids[0]]])
 assert.equal(value.todayRoundCount,1501)
 assert.equal(value.dailyReports[0].rounds,1501)
 assert.deepEqual(value.tableStats.map(x=>x.tableId),ids)
 assert.equal(value.tableStats[0].mainHitRate,'50.0%')
 assert.equal(value.tableStats[0].sideHitRate,'25.0%')
 assert.equal(value.tableStats[0].tableName,'1桌')
})
test('expired analytics cache cannot conceal a fresh load failure',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-24T01:00:00Z')})
 let fail=false;const c=createLicenseAdminClient({pool:snapshotPool({async query(){if(fail)throw Error('injected timeout');return {rows:[row]}}})})
 await c.getDailyAnalytics();fail=true;t.mock.timers.tick(61000)
 await assert.rejects(c.getDailyAnalytics(),/injected timeout/)
})
test('Taipei midnight invalidates prior day cache before TTL',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-24T15:59:50Z')})
 const calls=[];const c=createLicenseAdminClient({pool:snapshotPool({async query(sql,params){calls.push(params);return {rows:[row]}}})})
 const first=await c.getDailyAnalytics();t.mock.timers.tick(20000);const second=await c.getDailyAnalytics()
 assert.equal(first.dailyReports[0].date,'2026-10-24');assert.equal(second.dailyReports[0].date,'2026-10-25')
 assert.equal(calls.length,12);assert.equal(calls[0][2],'2026-10-24');assert.equal(calls[6][2],'2026-10-25')
})
test('cloud status does not advertise healthy empty analytics on query failure',async()=>{
 const app=createApp({autoConnect:false,licenseAdminClient:{configured:true,getCloudDataStatus:async()=>({}),getDailyAnalytics:async()=>{throw Error('injected analytics failure')}},supabaseClient:{configured:true,countTodayPredictionRounds:async()=>1000}})
 try{const r=await app.inject({url:'/api/cloud-data/status'});const d=JSON.parse(r.body);assert.equal(r.statusCode,503);assert.equal(d.ok,false);assert.equal(d.todayRoundCount,undefined);assert.equal(d.error,'analytics_unavailable')}finally{await app.stop()}
})

test('cloud count failure is unavailable, not a successful zero',async()=>{
 const app=createApp({autoConnect:false,licenseAdminClient:{configured:false,getCloudDataStatus:async()=>({})},supabaseClient:{configured:true,countTodayPredictionRounds:async()=>{throw Error('missing exact count')}}})
 try{const r=await app.inject({url:'/api/cloud-data/status'});assert.equal(r.statusCode,503);assert.equal(JSON.parse(r.body).todayRoundCount,undefined)}finally{await app.stop()}
})

function snapshotPool(pool) {
  return {async connect(){return {async query(sql,params){
    if(!params)return {rows:[]}
    const value=await pool.query(sql,params)
    return {rows:value.rows.filter(row=>params[1].includes(row.table_id))}
  },release(){}}}}
}
