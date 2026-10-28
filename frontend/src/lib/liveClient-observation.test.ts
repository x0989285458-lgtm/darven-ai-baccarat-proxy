import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getBackendPredictionIssue, LiveRoadClient } from './liveClient'
const clock='2026-10-28T01:00:00.000Z'
// Metadata mirrors SQL read_v105_table_publications lines 155-161.
// The API-facing screen round is the target (completed round + 1).
function ready(revision=5, round=18, capture=clock): any {
 return {id:'BAV01',table_id:'BAV01',table_type:'BAC',buildVersion:'v105',sourceUpdatedAt:capture,
 trend:{current_shoe:'123',current_round:round,big2:'0201',bead_plate2:'0102'},
 publication:{state:'ready',revision,publishedAt:clock,sourceCapturedAt:capture,
 rawIdentity:{tableId:'BAV01',shoe:'123',round},readyIdentity:{tableId:'BAV01',shoe:'123',round,predictionId:'pid-'+round}},
 prediction:{source:'backend',strategyVersion:'v105',buildVersion:'v105',targetTableId:'BAV01',targetShoe:'123',targetRound:round,predictionId:'pid-'+round,issuedAt:clock,predictedResult:'banker',confidence:61,probabilities:{banker:61,player:30,tie:9},sidePredictions:{tie:11,superSix:22,bankerPair:33,playerPair:44,bankerDragon:55,playerDragon:66},sideActions:{tie:false,superSix:false,bankerPair:false,playerPair:false,bankerDragon:true,playerDragon:false}}}
}
function pending(round=18,capture=clock):any {
 const t=ready(5,round,capture);t.prediction=undefined;
 t.publication={state:'pending',revision:null,publishedAt:null,sourceCapturedAt:capture,rawIdentity:{tableId:'BAV01',shoe:'123',round},readyIdentity:null};return t
}
function harness(){let last:any;const c=new LiveRoadClient({onTables:ts=>last=ts[0],onStatus:vi.fn()});return {send:(t:any)=>(c as any).publishTables([t],'probe'),last:()=>last}}
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date(clock))})
afterEach(()=>vi.useRealTimers())
describe('DB metadata compatibility supplemental review (not live DB)',()=>{
 it('ready with SQL string shoe and numeric target round is accepted',()=>{const h=harness();h.send(ready());expect(getBackendPredictionIssue(h.last())).toBeNull()})
 it('SQL pending null revision revokes same-screen ready',()=>{const h=harness();h.send(ready());h.send(pending());expect(getBackendPredictionIssue(h.last())).not.toBeNull()})
 it('wrongidentity revokes at unchanged revision',()=>{const h=harness();h.send(ready());const bad=ready();bad.publication.rawIdentity.round=19;h.send(bad);expect(getBackendPredictionIssue(h.last())).not.toBeNull()})
 it('numbered delayed revision cannot evict newer ready',()=>{const h=harness();h.send(ready());const old=ready(4,17,'2026-10-28T00:59:59.000Z');old.publication.state='pending';h.send(old);expect(getBackendPredictionIssue(h.last())).toBeNull();expect(h.last().publication.revision).toBe(5)})
 it('strictly newer ready recovers null-revision revocation and preserves source high-water',()=>{const h=harness();h.send(ready());h.send(pending());const next=ready(6);next.sourceUpdatedAt='2026-10-28T00:59:59.000Z';h.send(next);expect(getBackendPredictionIssue(h.last())).toBeNull();expect(h.last().sourceUpdatedAt).toBe(clock)})
 it('capture regression cannot create actionable output',()=>{const h=harness();h.send(ready());h.send(ready(6,18,'2026-10-28T00:59:59.000Z'));expect(getBackendPredictionIssue(h.last())).not.toBeNull();expect(h.last().publication.sourceCapturedAt).toBe(clock)})
 it('REGRESSION: delayed SQL pending with null revision must not revoke a newer exact screen',()=>{const h=harness();h.send(observed(ready(),'1793149200000002'));h.send(observed(pending(17,'2026-10-28T00:59:59.000Z'),'1793149200000001'));expect(getBackendPredictionIssue(h.last())).toBeNull()})
 it('REGRESSION: DB ready again at same revision after transient pending should converge',()=>{const h=harness();const a=observed(ready(),'1793149200000001'),b=observed(pending(),'1793149200000002'),c=observed(ready(),'1793149200000003');h.send(a);h.send(b);expect(getBackendPredictionIssue(h.last())).not.toBeNull();h.send(c);expect(getBackendPredictionIssue(h.last())).toBeNull();expect(h.last().prediction).toEqual(a.prediction)})
})

function observed(t: any, stamp: string) { t.publication.observedAtMicros=stamp; t.publication.observation={epoch:'a'.repeat(64),snapshot:`${stamp}:${stamp}:`}; return t }
function causal(t:any, stamp:string, snapshot:string, epoch='a'.repeat(64)) { observed(t,stamp);t.publication.observation={epoch,snapshot};return t }
describe('causal snapshot authority',()=>{
 it('replays exact real PG fresh-RC inversion and retained snapshot tokens in both arrival orders',()=>{
  // atomic-db-green-hermes-verify-atomic-pg-_sv56p_w.json: real PG17.7,
  // only causality metadata replayed onto this test's complete screen fixture.
  const epoch='d66a28ec8cae908802adc8c1ef513baaf98b97dca0d178a42ccb13c2ed94905a';
  for(const order of ['pending-first','ready-first']) {
   const h=harness();const old=()=>causal(ready(),'1793188917253603','759:759:',epoch);
   const revoked=()=>causal(pending(),'1793188917252583','760:760:',epoch);
   h.send(old());if(order==='pending-first'){h.send(revoked());h.send(old())}else{h.send(old());h.send(revoked())}
   expect(getBackendPredictionIssue(h.last())).not.toBeNull();
   h.send(causal(ready(),'1793188917260689','761:761:',epoch));expect(getBackendPredictionIssue(h.last())).toBeNull();
   h.send(causal(pending(),'1793188917262649','760:760:',epoch));expect(getBackendPredictionIssue(h.last())).toBeNull();
  }
 })
 it('same snapshot later TTL evaluation may legitimately recover a future-source rejection',()=>{
  const h=harness();h.send(causal(ready(),'100','10:10:'));h.send(causal(pending(),'101','10:10:'));
  h.send(causal(ready(),'101','10:10:'));expect(getBackendPredictionIssue(h.last())).not.toBeNull();
  h.send(causal(ready(),'102','10:10:'));expect(getBackendPredictionIssue(h.last())).toBeNull();
 })
 it('exact xip bound is accepted',()=>{
  const h=harness();h.send(causal(ready(),'100',`10:5000:${Array.from({length:2048},(_,i)=>i+10).join(',')}`));expect(getBackendPredictionIssue(h.last())).toBeNull();
 })
 it('xip completion rather than xmax orders snapshots',()=>{
  const h=harness();h.send(causal(ready(),'100','10:20:10,15'));h.send(causal(pending(),'99','10:20:10'));
  h.send(causal(ready(),'101','10:20:10,15'));expect(getBackendPredictionIssue(h.last())).not.toBeNull();
  h.send(causal(ready(),'98','20:20:'));expect(getBackendPredictionIssue(h.last())).toBeNull();
 })
 it('new in-progress xids alone cannot recover equal visibility',()=>{
  const h=harness();h.send(causal(ready(),'100','10:10:'));h.send(causal(pending(),'101','10:10:'));
  h.send(causal(ready(),'101','10:12:10,11'));expect(getBackendPredictionIssue(h.last())).not.toBeNull();
 })
 it.each(['10:20:10,12','10:21:10,12'])('incomparable visibility fails closed: %s',snapshot=>{
  const h=harness();h.send(causal(ready(),'100','10:20:10,15'));h.send(causal(ready(6),'101',snapshot));
  expect(getBackendPredictionIssue(h.last())).not.toBeNull();h.send(causal(ready(7),'102','30:30:'));expect(getBackendPredictionIssue(h.last())).not.toBeNull();
 })
 it('stale lower-revision foreign epoch revokes before stale/revision filtering',()=>{
  const h=harness();h.send(causal(ready(),'100','10:10:'));h.send(causal(ready(4,18,'2026-10-27T00:00:00.000Z'),'101','20:20:','b'.repeat(64)));
  expect(getBackendPredictionIssue(h.last())).not.toBeNull();
 })
 it('epoch switch is never ordered even with new revision',()=>{
  const h=harness();h.send(causal(ready(),'100','10:10:'));h.send(causal(ready(6),'101','20:20:','b'.repeat(64)));
  expect(getBackendPredictionIssue(h.last())).not.toBeNull();h.send(causal(ready(7),'102','30:30:'));expect(getBackendPredictionIssue(h.last())).not.toBeNull();
 })
 it.each(['','1:1:','10:9:','010:10:','10:20:10,10','10:20:15,10','10:20:20','10:20:9','10:20:','18446744073709551616:18446744073709551616:','9'.repeat(65537),`10:5000:${Array.from({length:2049},(_,i)=>i+10).join(',')}`])('invalid snapshot rejected except valid empty xip: %s',snapshot=>{
  const h=harness();h.send(causal(ready(),'100',snapshot));expect(getBackendPredictionIssue(h.last())===null).toBe(snapshot==='10:20:');
 })
 it('xid8 wrap and maximum remain exact BigInts',()=>{
  const h=harness();h.send(causal(ready(),'100','4294967295:4294967296:4294967295'));h.send(causal(pending(),'99','4294967296:4294967296:'));
  h.send(causal(ready(),'98','18446744073709551615:18446744073709551615:'));expect(getBackendPredictionIssue(h.last())).toBeNull();
 })
 it('statement101 pending from later snapshot defeats delayed ready102 from older snapshot',()=>{
  const h=harness();h.send(causal(ready(),'100','10:10:'));
  h.send(causal(pending(),'101','12:12:'));expect(getBackendPredictionIssue(h.last())).not.toBeNull();
  h.send(causal(ready(),'102','11:11:'));expect(getBackendPredictionIssue(h.last())).not.toBeNull();
  h.send(causal(ready(),'99','13:13:'));expect(getBackendPredictionIssue(h.last())).toBeNull();
 })
})
describe('DB observation authority guards',()=>{
 it.each([null, 1793149200000001, '', ' 1793149200000001', '+1793149200000001', '01', '0', '-1', '1.5', '1e16', '9'.repeat(21), {}, []])('malformed observation fails closed: %j',stamp=>{
  const h=harness();const t=ready();t.publication.observedAtMicros=stamp;h.send(t);expect(getBackendPredictionIssue(h.last())).not.toBeNull()
 })
 it('unobserved revocation cannot be laundered by successive same-revision observations',()=>{
  const h=harness();h.send(observed(ready(),'9007199254740992'));h.send(pending());
  h.send(observed(ready(),'9007199254740993'));h.send(observed(ready(),'9007199254740994'));
  expect(getBackendPredictionIssue(h.last())).not.toBeNull()
 })
 it('cannot change immutable prediction at the same revision during recovery',()=>{
  const h=harness();h.send(observed(ready(),'9007199254740992'));h.send(observed(pending(),'9007199254740993'));
  const bad=observed(ready(),'9007199254740994');bad.prediction.confidence=62;h.send(bad);
  expect(getBackendPredictionIssue(h.last())).not.toBeNull()
 })
 it('compares adjacent above-safe-integer stamps without Number rounding',()=>{
  const h=harness();h.send(observed(ready(),'9007199254740993'));h.send(observed(pending(),'9007199254740992'));
  expect(getBackendPredictionIssue(h.last())).toBeNull()
 })
 it('equal/older ready cannot revive pending but a strictly later exact observation can',()=>{
  const h=harness();h.send(observed(ready(),'100'));h.send(observed(pending(),'102'));
  h.send(observed(ready(),'101'));h.send(observed(ready(),'102'));expect(getBackendPredictionIssue(h.last())).not.toBeNull();
  h.send(observed(ready(),'103'));expect(getBackendPredictionIssue(h.last())).toBeNull()
 })
 it('pending identity advance prevents borrowing the old round',()=>{
  const h=harness();h.send(observed(ready(),'100'));h.send(observed(pending(19),'101'));h.send(observed(ready(),'102'));
  expect(getBackendPredictionIssue(h.last())).not.toBeNull()
 })
 it('stale older null revision cannot delete newer ready',()=>{
  const h=harness();h.send(observed(ready(),'102'));h.send(observed(pending(17,'2026-10-27T00:00:00.000Z'),'101'));
  expect(getBackendPredictionIssue(h.last())).toBeNull()
 })
 it.each(['identity','capture','TTL','build','source','sideActions'])('new observation cannot bypass %s gate',gate=>{
  const h=harness();h.send(observed(ready(),'100'));h.send(observed(pending(),'101'));const bad=observed(ready(),'102');
  if(gate==='identity') bad.publication.readyIdentity.round=19;
  if(gate==='capture') bad.publication.sourceCapturedAt='2026-10-28T00:59:59.000Z';
  if(gate==='TTL') bad.sourceUpdatedAt='2026-10-27T00:00:00.000Z';
  if(gate==='build') bad.buildVersion='wrong';
  if(gate==='source') bad.prediction.source='wrong';
  if(gate==='sideActions') delete bad.prediction.sideActions;
  h.send(bad);expect(getBackendPredictionIssue(h.last())).not.toBeNull()
 })
})

function wire(t:any) {return {tableId:t.id,tableType:t.table_type,shoe:t.trend.current_shoe,round:t.trend.current_round,buildVersion:t.buildVersion,sourceUpdatedAt:t.sourceUpdatedAt,publication:t.publication,prediction:t.prediction,bigRoadRaw:t.trend.big2,beadPlateRaw:t.trend.bead_plate2}}
function tombstone(t: any) {
 return { tableId:t.id, buildVersion:t.buildVersion, sourceUpdatedAt:t.sourceUpdatedAt,
  screenUnavailable:true, publication:{...t.publication,state:'unavailable',readyIdentity:null} }
}
describe('ready-only tombstone wire',()=>{
 const hidden=(t:any)=>({id:t.id,table_id:t.id,table_type:'BAC',buildVersion:t.buildVersion,sourceUpdatedAt:t.sourceUpdatedAt,
  screenUnavailable:true,trend:{big2:'',bead_plate2:''},publication:{...t.publication,state:'unavailable',readyIdentity:null}})
 it.each(['missing observation','invalid observation','missing identity','wrong identity','invalid shoe','epoch','capture','non-ISO capture'])('cannot launder %s through placeholder recovery',gate=>{
  const h=harness();h.send(observed(ready(),'100'));const revoked=hidden(observed(ready(),'101'));
  if(gate==='missing observation') delete revoked.publication.observation;
  if(gate==='invalid observation') revoked.publication.observation.snapshot='invalid';
  if(gate==='missing identity') delete revoked.publication.rawIdentity;
  if(gate==='wrong identity') revoked.publication.rawIdentity.tableId='BAV02';
  if(gate==='invalid shoe') revoked.publication.rawIdentity.shoe={};
  if(gate==='epoch') revoked.publication.observation.epoch='b'.repeat(64);
  if(gate==='capture') revoked.publication.sourceCapturedAt='invalid';
  if(gate==='non-ISO capture') revoked.publication.sourceCapturedAt='2026-10-28 01:00:00.000Z';
  h.send(revoked);expect(h.last().screenUnavailable).toBe(true);expect(h.last().prediction).toBeUndefined();
  h.send(observed(ready(),'102'));h.send(observed(ready(),'103'));
  expect(getBackendPredictionIssue(h.last())).not.toBeNull();
 })
 it('older ready cannot undo placeholder; later exact recovery cannot mutate prediction',()=>{
  const h=harness();h.send(observed(ready(),'100'));h.send(hidden(observed(ready(),'102')));
  h.send(observed(ready(),'101'));expect(h.last().screenUnavailable).toBe(true);
  const bad=observed(ready(),'103');bad.prediction.confidence=99;h.send(bad);
  h.send(observed(ready(),'104'));expect(getBackendPredictionIssue(h.last())).not.toBeNull();
 })
 it('stale placeholder retains table selection without making its identity a visible screen',()=>{
  const h=harness();h.send(observed(ready(),'100'));
  h.send(hidden(observed(ready(5,18,'2026-10-27T00:00:00.000Z'),'101')));
  expect(h.last().screenUnavailable).toBe(true);expect(h.last().trend.current_round).toBeUndefined();
  expect(h.last().prediction).toBeUndefined();expect(getBackendPredictionIssue(h.last())).not.toBeNull();
 })
 it('initial valid placeholder permits a later exact ready revision',()=>{
  const h=harness();h.send(hidden(observed(pending(),'100')));h.send(observed(ready(),'101'));
  expect(getBackendPredictionIssue(h.last())).toBeNull();
 })
 it('keeps six selectors, clears only revoked screen and recovers same revision via raw identity',async()=>{
  let stream!:ReadableStreamDefaultController<Uint8Array>;let last:any[]=[];
  const unauthorized=vi.fn();
  vi.stubGlobal('fetch',vi.fn(()=>Promise.resolve({ok:true,status:200,body:new ReadableStream<Uint8Array>({start(c){stream=c}})})))
  const c=new LiveRoadClient({onTables:rows=>last=rows,onStatus:vi.fn(),onUnauthorized:unauthorized});
  const cohort=(stamp:string)=>['BAV01','BAV02','BAV03','BAV03A','BAV05','BAV06'].map(id=>{
   const t=observed(ready(),stamp);t.id=t.table_id=id;t.publication.rawIdentity.tableId=id;t.publication.readyIdentity.tableId=id;t.prediction.targetTableId=id;return wire(t)
  });
  const send=async(rows:any[])=>{stream.enqueue(new TextEncoder().encode(`event: tables\ndata: ${JSON.stringify({tables:rows})}\n\n`));await vi.advanceTimersByTimeAsync(1)};
  try {
   c.connect();await Promise.resolve();await send(cohort('100'));
   expect(last).toHaveLength(6);expect(getBackendPredictionIssue(last[0])).toBeNull();
   const rows=cohort('101');rows[0]=tombstone(observed(ready(),'101')) as any;await send(rows);
   expect(last).toHaveLength(6);expect(last[0].screenUnavailable).toBe(true);
   expect(last[0].trend.current_round).toBeUndefined();expect(last[0].trend.current_shoe).toBeUndefined();expect(last[0].prediction).toBeUndefined();
   expect(last[0].trend.big2).toBe('');expect(getBackendPredictionIssue(last[1])).toBeNull();
   await send(cohort('102'));expect(getBackendPredictionIssue(last[0])).toBeNull();
   stream.enqueue(new TextEncoder().encode('event: error\ndata: {"error":"unavailable"}\n\n'));await vi.advanceTimersByTimeAsync(1);
   expect(last).toEqual([]);expect(unauthorized).not.toHaveBeenCalled();
   await send(cohort('99'));expect(last).toEqual([]);
   await send(cohort('103'));expect(last).toHaveLength(6);expect(getBackendPredictionIssue(last[0])).toBeNull();
  }finally{c.disconnect(false);stream.close();vi.unstubAllGlobals()}
 })
})
describe('actual REST and SSE observation ordering',()=>{
 it('late REST pending cannot revoke SSE ready; later REST exact ready recovers SSE pending',async()=>{
  let stream!:ReadableStreamDefaultController<Uint8Array>;let release!:(v:any)=>void;let last:any;
  vi.stubGlobal('fetch',vi.fn((url:any)=>String(url).endsWith('/stream')
   ? Promise.resolve({ok:true,status:200,body:new ReadableStream<Uint8Array>({start(c){stream=c}})})
   : new Promise(resolve=>{release=resolve})))
  const client=new LiveRoadClient({onTables:rows=>{last=rows[0]},onStatus:vi.fn()});
  const send=(t:any)=>stream.enqueue(new TextEncoder().encode(`event: tables\ndata: ${JSON.stringify({tables:[wire(t)]})}\n\n`));
  try {
   client.connect();await Promise.resolve();
   const oldPoll=(client as any).poll(true);send(observed(ready(),'102'));await vi.advanceTimersByTimeAsync(1);
   release({ok:true,status:200,json:async()=>[wire(observed(pending(),'101'))]});await oldPoll;
   expect(getBackendPredictionIssue(last)).toBeNull();
   send(observed(pending(),'103'));await vi.advanceTimersByTimeAsync(1);expect(getBackendPredictionIssue(last)).not.toBeNull();
   const refresh=(client as any).poll(true);release({ok:true,status:200,json:async()=>[wire(observed(ready(),'104'))]});await refresh;
   expect(getBackendPredictionIssue(last)).toBeNull();expect(last.publication.revision).toBe(5);
   send(observed(pending(),'103'));await vi.advanceTimersByTimeAsync(1);expect(getBackendPredictionIssue(last)).toBeNull();
  }finally{client.disconnect(false);stream.close();vi.unstubAllGlobals()}
 })
 it('first pending without any publication revision recovers at identical capture',()=>{
  const h=harness();h.send(observed(pending(),'101'));h.send(observed(ready(),'102'));
  expect(getBackendPredictionIssue(h.last())).toBeNull()
 })
 it('newer exact recovery preserves source timestamp high-water',()=>{
  const h=harness();h.send(observed(ready(),'101'));h.send(observed(pending(),'102'));
  const next=observed(ready(),'103');next.sourceUpdatedAt='2026-10-28T00:59:59.000Z';h.send(next);
  expect(getBackendPredictionIssue(h.last())).toBeNull();expect(h.last().sourceUpdatedAt).toBe(clock)
 })
})
