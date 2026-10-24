import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../src/server.js';
import {buildLivePrediction} from '../src/supabase-writer.js';
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const table = {tableId:'BAV01',shoe:1540,round:14,roundBasis:'completed',sourceUpdatedAt:new Date().toISOString()};
const issued = {...buildLivePrediction(table),predictionId:'review-fixture',issuedAt:new Date().toISOString()};
test('late SSE-owned null must not shorten HTTP deadline 2000ms backoff', async () => {
  let reads=0, release, signal;
  const held=new Promise(r=>release=r);
  const started=new Promise(r=>signal=r);
  const app=createApp({autoConnect:false,port:0,production:false,memberAuthRequired:false,requireVerifiedStrategy:false,
    captureRoundBasis:'completed',captureOutboxConsumerEnabled:false,livePredictionReadWaitMs:50,streamHeartbeatMs:10000,
    onlineCoreClient:{},licenseAdminClient:{},
    supabaseClient:{configured:true,issuePrediction:async()=>assert.fail('no writes'),readIssuedPrediction:async()=>{
      reads++; if(reads===1)return null; if(reads===2){signal();return held;}return issued;
    }}});
  const controller=new AbortController();
  try {
    app.state.setTables([table]); await app.start();
    const response=await fetch(`http://127.0.0.1:${app.server.address().port}/api/tables/stream`,{signal:controller.signal});
    const reader=response.body.getReader(); await reader.read();
    await Promise.race([started,sleep(2000).then(()=>assert.fail('SSE read did not start'))]);
    const missed=JSON.parse((await app.inject({url:'/api/tables'})).body);
    assert.equal(missed[0].prediction,null); assert.equal(reads,2);
    const deadlineAt=Date.now(); release(null); await sleep(300);
    const result=JSON.parse((await app.inject({url:'/api/tables'})).body);
    console.log(JSON.stringify({kind:'deadline_then_late_sse_null',reads,elapsedSinceDeadlineMs:Date.now()-deadlineAt,predictionTarget:result[0].prediction?.targetRound??null}));
    assert.equal(reads,2,'late null must preserve the existing 2000ms deadline backoff');
  } finally {release(null); controller.abort();await app.stop();}
});
