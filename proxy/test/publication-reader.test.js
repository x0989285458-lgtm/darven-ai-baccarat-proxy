import test from 'node:test'
import assert from 'node:assert/strict'
const mod = await import('../src/publication-reader.js').catch(e => { if (e.code === 'ERR_MODULE_NOT_FOUND') return {}; throw e })
const pending = [{ table: { tableId: 'BAV01' }, prediction: null, publication: { state: 'pending' } }]
const ready = [{ table: { tableId: 'BAV01' }, prediction: { predictionId: 'exact' }, publication: { state: 'ready' } }]
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
function make(options) { assert.equal(typeof mod.createPublicationReader, 'function', 'event-driven publication reader must exist'); return mod.createPublicationReader(options) }

for (const startMs of [976, 991]) test(`publication: refresh at ${startMs}ms preserves pending at the original deadline`, async t => {
 t.mock.timers.enable({apis:['Date','setTimeout'],now:0})
 let calls=0,release,settled=false
 const rows=[...structuredClone(pending),...structuredClone(ready)]
 rows[1].table.tableId='BAV02'
 const r=make({load:()=>++calls===1 ? rows : new Promise(resolve=>{release=resolve}),waitMs:1000})
 t.after(()=>r.stop())
 const result=r.read().then(value=>{settled=true;return value});result.catch(()=>{})
 await flush();t.mock.timers.tick(startMs);await flush()
 assert.equal(calls,2);assert.equal(settled,false)
 t.mock.timers.tick(1000-startMs);await flush()
 const actual=await result
 assert.equal(Date.now(),1000);assert.deepEqual(actual,rows)
 assert.notEqual(actual,rows);assert.equal(actual[0].prediction,null)
 release(ready);await flush()
 assert.deepEqual(actual,rows,'late IO must not mutate the returned snapshot')
})

for (const scenario of ['hint','stop','database','invalid','transport-timeout','absent']) test(`publication: deadline fallback retains ${scenario} contract`, async t => {
 t.mock.timers.enable({apis:['Date','setTimeout'],now:0})
 let calls=0,resolveRefresh,rejectRefresh
 const r=make({load:()=>++calls===1 ? (scenario==='absent' ? [] : pending) : new Promise((resolve,reject)=>{resolveRefresh=resolve;rejectRefresh=reject}),waitMs:1000})
 t.after(()=>r.stop())
 const result=r.read();result.catch(()=>{})
 await flush();t.mock.timers.tick(991);await flush();assert.equal(calls,2)
 const failure=Object.assign(new Error('fixture database failure'),{code:scenario==='transport-timeout' ? 'PUBLICATION_READ_TIMEOUT' : 'DATABASE_FAILED'})
 if (scenario==='hint') r.notify()
 if (scenario==='stop') r.stop()
 if (scenario==='database' || scenario==='transport-timeout') rejectRefresh(failure)
 if (scenario==='invalid') resolveRefresh(null)
 await flush();t.mock.timers.tick(9);await flush()
 if (scenario==='absent') assert.deepEqual(await result,[],'absent tables must not be synthesized')
 else if (scenario==='database' || scenario==='transport-timeout') await assert.rejects(result,e=>e===failure)
 else await assert.rejects(result,e=>e.code===({hint:'PUBLICATION_READ_TIMEOUT',stop:'PUBLICATION_READER_STOPPED',invalid:'PUBLICATION_INVALID_SNAPSHOT'}[scenario]))
 resolveRefresh(ready);await flush()
})

test('publication: post-commit hint wakes a pending HTTP reader without polling', async t => {
 t.mock.timers.enable({apis:['Date','setTimeout'],now:0})
 let rows=pending, calls=0
 const r=make({load:async()=>{calls++;return rows},waitMs:1000})
 const p=r.read();await flush();assert.equal(calls,1)
 t.mock.timers.tick(400);rows=ready;r.notify();await flush()
 assert.deepEqual(await p,ready);assert.equal(calls,2);r.stop()
})
test('publication: missing notification does not extend the original deadline or invent ready', async t => {
 t.mock.timers.enable({apis:['Date','setTimeout'],now:0})
 let calls=0;const r=make({load:async()=>{calls++;return pending},waitMs:1000})
 const p=r.read();await flush();t.mock.timers.tick(1000);await flush()
 assert.deepEqual(await p,pending);assert.equal(calls,1);r.stop()
})
test('publication: lost hint gets one cache-bypassing refresh inside the original deadline', async t => {
 t.mock.timers.enable({apis:['Date','setTimeout'],now:0})
 let rows=pending,calls=0
 const r=make({load:async()=>{calls++;return rows},waitMs:100,cacheMs:1000})
 t.after(()=>r.stop())
 const result=r.read();result.catch(()=>{});await flush();assert.equal(calls,1)
 t.mock.timers.tick(20);rows=ready;await flush()
 t.mock.timers.tick(30);await flush()
 assert.equal(calls,2,'lost hint must force a fresh serial snapshot, not cached pending')
 assert.deepEqual(await result,ready)
})
test('publication: fallback refresh still pending keeps the original deadline and read bound', async t => {
 t.mock.timers.enable({apis:['Date','setTimeout'],now:0})
 let calls=0,settled=false
 const r=make({load:async()=>{calls++;return pending},waitMs:100,cacheMs:1000})
 t.after(()=>r.stop())
 const result=r.read().then(rows=>{settled=true;return rows});result.catch(()=>{});await flush()
 t.mock.timers.tick(50);await flush();assert.equal(calls,2);assert.equal(settled,false)
 t.mock.timers.tick(50);await flush();assert.deepEqual(await result,pending);assert.equal(calls,2)
})
test('publication: concurrent callers share snapshot IO and a hint never starts parallel reads', async t => {
 t.mock.timers.enable({apis:['Date','setTimeout'],now:0})
 let calls=0, release;let rows=pending
 const r=make({load:()=>{calls++;return new Promise(resolve=>{release=()=>resolve(rows)})},waitMs:1000})
 const a=r.read(),b=r.read();await flush();assert.equal(calls,1)
 r.notify();r.notify();release();await flush();assert.equal(calls,2)
 rows=ready;release();await flush()
 assert.deepEqual(await a,ready);assert.deepEqual(await b,ready);assert.equal(calls,2);r.stop()
})
test('publication: hung underlying read survives waiter timeout without orphan amplification', async t => {
 t.mock.timers.enable({apis:['Date','setTimeout'],now:0})
 let calls=0,release;const r=make({load:()=>{calls++;return new Promise(resolve=>{release=resolve})},waitMs:1000})
 const a=r.read().then(()=>assert.fail('must reject'),e=>e.code);await flush();t.mock.timers.tick(1000);await flush();assert.equal(await a,'PUBLICATION_READ_TIMEOUT')
 const b=r.read().then(()=>assert.fail('must reject'),e=>e.code);await flush();t.mock.timers.tick(1000);await flush();assert.equal(await b,'PUBLICATION_READ_TIMEOUT');assert.equal(calls,1)
 release(ready);await flush();assert.deepEqual(await r.read(),ready);r.stop()
})
test('publication: stop releases waiters and late IO cannot restart activity', async t => {
 t.mock.timers.enable({apis:['Date','setTimeout'],now:0})
 let release,calls=0;const r=make({load:()=>{calls++;return new Promise(resolve=>{release=resolve})},waitMs:1000})
 const a=r.read().then(()=>assert.fail('must reject'),e=>e.code);await flush();r.stop();await flush();assert.equal(await a,'PUBLICATION_READER_STOPPED')
 release(ready);r.notify();await flush();assert.equal(calls,1)
 await assert.rejects(r.read(),e=>e.code==='PUBLICATION_READER_STOPPED')
})
test('publication: a hint invalidates an earlier ready snapshot if the fresh read times out', async t => {
 t.mock.timers.enable({apis:['Date','setTimeout'],now:0})
 let calls=0,release;const r=make({load:()=>{calls++;return new Promise(resolve=>{release=resolve})},waitMs:1000})
 const a=r.read().then(()=>assert.fail('stale ready must not survive a new publication hint'),e=>e.code)
 await flush();t.mock.timers.tick(900);r.notify();release(ready);await flush();assert.equal(calls,2)
 t.mock.timers.tick(100);await flush();assert.equal(await a,'PUBLICATION_READ_TIMEOUT');r.stop();release(ready);await flush()
})
test('publication: caller joining an old flight after a hint cannot accept its stale ready result', async t => {
 t.mock.timers.enable({apis:['Date','setTimeout'],now:0})
 let calls=0,release;const r=make({load:()=>{calls++;return new Promise(resolve=>{release=resolve})},waitMs:1000})
 t.after(()=>r.stop())
 let bSettled=false
 const a=r.read();a.catch(()=>{});await flush();r.notify()
 const b=r.read().then(rows=>{bSettled=true;return rows});await flush()
 release(ready);await flush()
 assert.equal(bSettled,false,'post-hint caller must not accept pre-hint read')
 assert.equal(calls,2)
 const fresh=structuredClone(ready);fresh[0].prediction.predictionId='fresh'
 release(fresh);await flush()
 assert.deepEqual(await a,fresh);assert.deepEqual(await b,fresh)
})
test('publication: lost hint after the first refresh still converges within the same deadline', async t => {
 t.mock.timers.enable({apis:['Date','setTimeout'],now:0})
 let rows=pending,calls=0
 const r=make({load:async()=>{calls++;return rows},waitMs:100,cacheMs:1000})
 t.after(()=>r.stop())
 let settled=false
 const readers=Array.from({length:8},()=>r.read().then(value=>{settled=true;return value}))
 for (const result of readers) result.catch(()=>{})
 await flush();assert.equal(calls,1)
 t.mock.timers.tick(50);await flush();assert.equal(calls,2);assert.equal(settled,false)
 t.mock.timers.tick(20);rows=ready;await flush()
 t.mock.timers.tick(5);await flush()
 assert.equal(settled,true,'a lost hint after the first fallback must not strand committed ready data')
 assert.equal(calls,3,'concurrent waiters must share the later refresh')
 for (const result of await Promise.all(readers)) assert.deepEqual(result,ready)
})

test('publication: failed snapshot propagates, it is not an empty successful table list', async () => {
 const error=new Error('synthetic database failure');const r=make({load:async()=>{throw error},waitMs:1000})
 await assert.rejects(r.read(),e=>e===error);r.stop()
})
