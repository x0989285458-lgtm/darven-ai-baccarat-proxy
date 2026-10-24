import test from 'node:test'
import assert from 'node:assert/strict'
import {createLicenseAdminClient} from '../src/license-admin.js'
const ids=['BAV01','BAV02','BAV03','BAV03A','BAV05','BAV06']
function fixture({failAt=null}={}) {
 const calls=[];let released;let connected=0
 const session={async query(sql,params){calls.push({sql,params});if(params){if(params[1][0]===failAt)throw Error('injected read failure');return {rows:[{table_id:params[1][0],rounds:1001,side_actions_available:true}]}}return {rows:[]}},release(destroy){released=destroy}}
 const pool={async connect(){connected++;return session},async query(){throw Error('aggregate bypassed dedicated snapshot')}}
 return {calls,pool,get released(){return released},get connected(){return connected}}
}
test('six bounded reads share one repeatable-read read-only transaction and single-flight',async()=>{
 const f=fixture();const c=createLicenseAdminClient({pool:f.pool});const [a,b]=await Promise.all([c.getDailyAnalytics(),c.getDailyAnalytics()]);assert.equal(f.connected,1);assert.deepEqual(a,b)
 assert.equal(a.todayRoundCount,6006);assert.equal(a.dailyReports[0].rounds,6006)
 assert.match(f.calls[0].sql,/BEGIN.*REPEATABLE READ.*READ ONLY/i)
 const reads=f.calls.filter(x=>x.params);assert.deepEqual(reads.map(x=>x.params[1]),ids.map(id=>[id]));assert.equal(reads.length,6)
 assert.equal(f.calls.at(-1).sql,'ROLLBACK');assert.equal(f.released,false)
 assert.ok(f.calls.some(x=>/statement_timeout.*8500/.test(x.sql)));assert.ok(f.calls.some(x=>/lock_timeout.*500/.test(x.sql)))
 await c.getDailyAnalytics();assert.equal(f.connected,1)
})
test('mid-snapshot failure rolls back, destroys connection and never publishes a partial report',async()=>{
 const f=fixture({failAt:'BAV03'});const c=createLicenseAdminClient({pool:f.pool});await assert.rejects(c.getDailyAnalytics(),/injected read failure/)
 assert.equal(f.calls.at(-1).sql,'ROLLBACK');assert.equal(f.released,true);assert.equal(f.calls.filter(x=>x.params).length,3)
 await assert.rejects(c.getDailyAnalytics(),/injected read failure/);assert.equal(f.connected,2)
})
test('snapshot crossing Taipei midnight is not cached as a new-day report',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-24T15:59:59Z')})
 const f=fixture();const connect=f.pool.connect;f.pool.connect=async()=>{const s=await connect();const q=s.query;s.query=async(...a)=>{const r=await q(...a);if(a[1])t.mock.timers.tick(1000);return r};return s}
 const c=createLicenseAdminClient({pool:f.pool});const results=await Promise.allSettled([c.getDailyAnalytics(),c.getDailyAnalytics()]);assert.deepEqual(results.map(r=>r.status),['rejected','rejected']);for(const r of results)assert.match(r.reason.message,/analytics_day_changed/);assert.equal(f.released,false)
})
