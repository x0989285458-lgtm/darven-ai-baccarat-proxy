import test from 'node:test'
import assert from 'node:assert/strict'
const mod=await import('../src/publication-notifier.js').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e})
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve()}
function make(options={}){assert.equal(typeof mod.createPublicationNotifier,'function','bounded commit notifier must exist');return mod.createPublicationNotifier({url:'http://127.0.0.1:8792/internal/publication-ready',token:'synthetic-control',tableIds:['BAV01','BAV02'],...options})}
const receipt=(table='BAV01',revision=1)=>({disposition:'published',table_id:table,publication_revision:revision})
test('publication hint: coalesces a burst and authenticates a loopback-only wake',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const calls=[];const n=make({fetchImpl:async(...a)=>{calls.push(a);return {ok:true}}})
 n.notify(receipt());n.notify(receipt('BAV02'));n.notify(receipt());t.mock.timers.tick(10);await flush()
 assert.equal(calls.length,1);assert.equal(calls[0][1].headers['x-control-token'],'synthetic-control');assert.equal(calls[0][1].body,'{}');n.stop()
})
test('publication hint: one active request and only one pending replacement',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let release,calls=0;const n=make({fetchImpl:()=>{calls++;return new Promise(r=>{release=r})}})
 n.notify(receipt());t.mock.timers.tick(10);await flush();for(let i=2;i<100;i++)n.notify(receipt('BAV01',i));t.mock.timers.tick(10);await flush();assert.equal(calls,1)
 release({ok:true});await flush();t.mock.timers.tick(10);await flush();assert.equal(calls,2);release({ok:true});await flush();n.stop()
})
test('publication hint: rejected request does not retry forever',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let calls=0;const n=make({fetchImpl:async()=>{calls++;throw Error('synthetic transport')}})
 n.notify(receipt());t.mock.timers.tick(10);await flush();t.mock.timers.tick(10000);await flush();assert.equal(calls,1);assert.equal(n.status().failed,1);n.stop()
})
test('publication hint: stop cancels scheduled send and rejects foreign endpoint',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let calls=0;const n=make({fetchImpl:async()=>{calls++;return {ok:true}}});n.notify(receipt());n.stop();t.mock.timers.tick(1000);await flush();assert.equal(calls,0)
 assert.throws(()=>make({url:'https://example.com/internal/publication-ready'}),/loopback/)
 assert.throws(()=>make({url:'http://127.0.0.1:8792/other'}),/loopback/)
})
