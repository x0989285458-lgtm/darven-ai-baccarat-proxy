import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'
import { buildLivePrediction } from '../src/supabase-writer.js'

const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve() }
test('late HTTP caller keeps its own deadline while sharing the unresolved read', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1793166533000 })
  const table = { tableId: 'BAV03', shoe: 1709, round: 42, roundBasis: 'completed' }
  const exact = { ...buildLivePrediction(table), predictionId: 'late-43', issuedAt: new Date().toISOString() }
  let reads = 0, release
  const held = new Promise(resolve => { release = resolve })
  const app = createApp({ autoConnect: false, captureRoundBasis: 'completed', captureOutboxConsumerEnabled: false,
    livePredictionReadWaitMs: 1000, supabaseClient: { configured: true,
      issuePrediction: async () => assert.fail('no write'), readIssuedPrediction: () => { reads++; return held },
    },
  })
  t.after(async () => { release(null); await app.stop() })
  app.state.setTables([table])
  const early = app.inject({ url: '/api/tables' }); await flush()
  t.mock.timers.tick(900); await flush()
  const late = app.inject({ url: '/api/tables' }); await flush()
  t.mock.timers.tick(100); await flush()
  assert.equal(JSON.parse((await early).body)[0].prediction, null)
  t.mock.timers.tick(100); release(exact); await flush()
  assert.equal(JSON.parse((await late).body)[0].prediction?.targetRound, 43)
  assert.equal(reads, 1, 'never replace an unresolved same-identity read')
})
for (const mode of ['missing', 'error']) test(`late caller ${mode} preserves bounded shared admission`, async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1793166533000 })
  const start = Date.now(), starts = []
  const table = { tableId: 'BAV03', shoe: 1709, round: 42, roundBasis: 'completed' }
  const exact = { ...buildLivePrediction(table), predictionId: 'renew-43', issuedAt: new Date().toISOString() }
  const app = createApp({ autoConnect: false, captureRoundBasis: 'completed', captureOutboxConsumerEnabled: false,
    livePredictionReadWaitMs: 1000, supabaseClient: { configured: true,
      issuePrediction: async () => assert.fail('no write'), readIssuedPrediction: async () => {
        starts.push(Date.now() - start)
        if (mode === 'error') throw new Error('DB unavailable')
        return Date.now() - start >= 1100 ? exact : null
      },
    },
  })
  t.after(() => app.stop()); app.state.setTables([table])
  const early = app.inject({ url: '/api/tables' }); await flush()
  for (let i = 0; i < 90; i++) { t.mock.timers.tick(10); await flush() }
  const late = Array.from({ length: 12 }, () => app.inject({ url: '/api/tables' })); await flush()
  for (let i = 0; i < 100; i++) { t.mock.timers.tick(10); await flush() }
  assert.equal(JSON.parse((await early).body)[0].prediction, null)
  for (const response of await Promise.all(late)) assert.equal(JSON.parse(response.body)[0].prediction?.targetRound ?? null, mode === 'error' ? null : 43)
  assert.ok(starts.length <= (mode === 'error' ? 1 : 6), `coalesced reads: ${starts}`)
})
for (const [latency, ready] of [[100, 880], [150, 800]]) test(`real app reserves observed ${latency}ms read latency (ready ${ready})`, async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1793166533000 })
  const start = Date.now(), starts = []
  const table = { tableId: 'BAV03', shoe: 1709, round: 42, roundBasis: 'completed', sourceUpdatedAt: new Date().toISOString() }
  const exact = { ...buildLivePrediction(table), predictionId: 'latency-43', issuedAt: new Date().toISOString() }
  let active = 0, peak = 0, completedAt
  const app = createApp({ autoConnect: false, captureRoundBasis: 'completed', captureOutboxConsumerEnabled: false,
    livePredictionReadWaitMs: 1000, supabaseClient: { configured: true,
      issuePrediction: async () => assert.fail('no write'),
      readIssuedPrediction: async () => {
        const at = Date.now() - start; starts.push(at); peak = Math.max(peak, ++active)
        await new Promise(resolve => setTimeout(resolve, latency)); active--
        return at >= ready ? exact : null
      },
    },
  })
  t.after(() => app.stop())
  app.state.setTables([table])
  const response = app.inject({ url: '/api/tables' }).then(r => { completedAt = Date.now() - start; return r })
  await flush()
  for (let i = 0; i < 110; i++) { t.mock.timers.tick(10); await flush() }
  assert.equal(JSON.parse((await response).body)[0].prediction?.targetRound, 43, `read starts: ${starts}`)
  assert.ok(completedAt <= 1000)
  assert.ok(starts.length <= 5)
  assert.equal(peak, 1)
})

test('real app: older cache-only continuations must not exhaust 900ms caller',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1793166533000});
 const epoch=Date.now(),row={tableId:'BAV03',shoe:1709,round:42,roundBasis:'completed'};
 const durable={...buildLivePrediction(row),predictionId:'independent-43',issuedAt:new Date().toISOString()};
 const runs=[];
 for(const admissions of [[0,900],[0,50,150,350,900]]){
  const run={admissions,starts:[],callers:[],writes:0};
  run.app=createApp({autoConnect:false,captureRoundBasis:'completed',captureOutboxConsumerEnabled:false,livePredictionReadWaitMs:1000,supabaseClient:{configured:true,
   issuePrediction:async()=>{run.writes++;assert.fail('no writer')},readIssuedPrediction:async()=>{const at=Date.now()-epoch;run.starts.push(at);return at>=1250?durable:null}
  }});
  t.after(()=>run.app.stop());run.app.state.setTables([row]);runs.push(run);
 }
 for(let elapsed=0;elapsed<=2000;elapsed+=10){
  for(const run of runs)if(run.admissions.includes(elapsed)){
   const c={at:elapsed,done:null,prediction:null};run.callers.push(c);
   run.app.inject({url:'/api/tables'}).then(r=>{c.done=Date.now()-epoch;c.prediction=JSON.parse(r.body)[0].prediction?.predictionId??null});
  }
  await flush();t.mock.timers.tick(10);await flush();
 }
 console.log(JSON.stringify(runs.map(({admissions,starts,callers,writes})=>({admissions,starts,callers,writes}))));
 for(const run of runs){assert.equal(run.writes,0);for(const c of run.callers){assert.ok(c.done!==null);assert.ok(c.done-c.at<=1000);assert.ok(run.starts.filter(x=>x>=c.at&&x<c.done).length<=5);}}
 assert.equal(runs[0].callers.find(c=>c.at===900).prediction,durable.predictionId,'control must prove same read cap and deadline can deliver');
 assert.equal(runs[1].callers.find(c=>c.at===900).prediction,durable.predictionId,'older callers must not consume 900ms callers remaining allowance without DB reads');
});
