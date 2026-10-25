import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../src/server.js';
import {buildLivePrediction} from '../src/supabase-writer.js';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
test('HTTP poll sleeping between misses must preserve a new SSE infrastructure backoff',async()=>{
 const table={tableId:'BAV01',shoe:1540,round:14,roundBasis:'completed',sourceUpdatedAt:new Date().toISOString()};
 const issued={...buildLivePrediction(table),predictionId:'review-local-only',issuedAt:new Date().toISOString()};
 const events=[]; let phase='initial',failedAt=null;
 const app=createApp({autoConnect:false,port:0,production:false,memberAuthRequired:false,requireVerifiedStrategy:false,captureRoundBasis:'completed',captureOutboxConsumerEnabled:false,livePredictionReadWaitMs:1000,streamHeartbeatMs:10000,onlineCoreClient:{},licenseAdminClient:{},supabaseClient:{configured:true,issuePrediction:async()=>assert.fail('no writes'),readIssuedPrediction:async()=>{
  const stack = new Error().stack;
  const owner = stack.includes('server.js:2373:') ? 'HTTP-poll' : stack.includes('server.js:2131:') ? 'SSE-refresh' : 'other';
  events.push({n:events.length+1,at:Date.now(),phase,owner});
  if(events.length===10){failedAt=Date.now();throw new Error('local simulated infrastructure failure');}
  if(failedAt!==null)return issued;
  return null;
 }}});
 const controller=new AbortController();
 try{
  app.state.setTables([table]);await app.start();
  // Readiness SSE no longer waits for a whole bounded read flight before its
  // first non-actionable snapshot. Establish that flight via its HTTP owner.
  await app.inject({url:'/api/tables'});
  const response=await fetch(`http://127.0.0.1:${app.server.address().port}/api/tables/stream`,{signal:controller.signal});
  const reader=response.body.getReader();await reader.read();assert.equal(events.length,5);
  phase='overlapping-http-and-scheduled-sse';await sleep(300);
  const result=JSON.parse((await app.inject({url:'/api/tables'})).body);
  const afterError=events.filter(e=>failedAt!==null&&e.n>10);
  console.log(JSON.stringify({kind:'poll_backoff_probe',events,failedAt,afterError:afterError.map(e=>({...e,sinceFailureMs:e.at-failedAt})),predictionTarget:result[0].prediction?.targetRound??null}));
  assert.notEqual(failedAt,null,'must exercise error race');
  assert.equal(afterError.length,0,'HTTP next retry must not bypass a newer SSE 2000ms error backoff');
 }finally{controller.abort();await app.stop();}
});
