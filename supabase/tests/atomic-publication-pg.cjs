const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('../../proxy/node_modules/pg');
const root = path.resolve(__dirname, '../..');
const clients = [];
async function connect() {
  assert.equal(process.env.PGHOST, '127.0.0.1');
  assert(process.env.ATOMIC_OWNED_PG_DATA, 'must be launched by the owned disposable runner');
  const data=path.resolve(process.env.ATOMIC_OWNED_PG_DATA);
  assert.equal(path.dirname(path.dirname(data)),path.resolve(require('node:os').tmpdir()));
  assert(path.basename(path.dirname(data)).startsWith('hermes-verify-atomic-pg-'));
  assert.equal(path.basename(data),'data');
  const c = new Client({host:'127.0.0.1', port:Number(process.env.PGPORT), user:'postgres', database:'postgres', statement_timeout:5000, connectionTimeoutMillis:5000});
  await c.connect(); clients.push(c);
  const actual=(await c.query("select current_setting('data_directory') d, host(inet_server_addr()) host, inet_server_port() port")).rows[0];
  assert.equal(path.resolve(actual.d).toLowerCase(),data.toLowerCase());
  assert.equal(actual.host,'127.0.0.1'); assert.equal(actual.port,Number(process.env.PGPORT));
  return c;
}
(async () => {
  const a = await connect();
  if (process.argv[2] === 'red') {
    await a.query('select public.read_v105_table_publications()');
    throw Error('Expected missing publication RPC');
  }
  const checks=[];
  const ok = name => {checks.push(name); console.log(JSON.stringify({passed:name}));};
  const migration = fs.readFileSync(path.join(root,'supabase/migrations/20261028090000_v105_table_publications.sql'),'utf8');
  const rollback = fs.readFileSync(path.join(root,'supabase/operations/20261028090000_v105_table_publications_rollback.sql'),'utf8');
  const read = async c => (await c.query('select public.read_v105_table_publications() v')).rows[0].v;
  const pub = async (c,t=1,shoe='999',round=11,id=ids[t-1]) => (await c.query('select public.publish_v105_table_publication($1,$2,$3,$4) v',[`T${t}`,shoe,round,id])).rows[0].v;
  const request = (t,shoe='999',round=11) => ({source:'ofalive99',table_id:`T${t}`,shoe_no:shoe,round_no:round,strategy_version:'v105',predicted_result:'banker',confidence:75,issued_prediction_payload:{targetTableId:`T${t}`,targetShoe:shoe,targetRound:round,strategyVersion:'v105',predictedResult:'banker',confidence:75,unknownNested:{preserved:[1,2,3]}}});
  const issue = async (c,t,shoe='999',round=11) => (await c.query('select public.issue_v105_prediction($1::jsonb) v',[JSON.stringify(request(t,shoe,round))])).rows[0].v;
  if (process.argv[2] === 'recover') {
    const prior=(await a.query("select id from public.daily_prediction_results where table_id='T6'")).rows[0].id;
    const recovered=await issue(a,6); assert.equal(recovered.prediction_id,prior);
    const ids=[]; const p=await pub(a,6,'999',11,prior); assert.equal(p.disposition,'published');
    console.log(JSON.stringify({recoveryPid:process.pid,existingIssueReused:prior})); return;
  }
  const schema=JSON.parse(fs.readFileSync(process.env.ATOMIC_SCHEMA_ARTIFACT,'utf8'));
  await a.query('create role anon; create role authenticated; create role service_role; create table public.ai_strategy_versions(version text primary key,status text,issuance_enabled boolean); insert into public.ai_strategy_versions values (\'v105\',\'active\',true)');
  for(const name of ['cloud_table_snapshots','daily_prediction_results']) {
    const cols=schema.columns.filter(c=>c.table_name===name).map(c=>`${c.column_name} ${c.data_type}${c.column_name==='id'?' primary key default gen_random_uuid()':c.column_name==='created_at'?' default now()':''}`);
    if(name==='daily_prediction_results') cols.push('unique(source,table_id,shoe_no,round_no,strategy_version)');
    await a.query(`create table public.${name} (${cols.join(',')})`);
  }
  await a.query(schema.functions.find(f=>f.proname==='issue_v105_prediction').definition);
  await a.query(migration); await a.query(migration); ok('fresh apply and exact rerun');
  const causalPath=path.join(root,'supabase/migrations/20261028120000_v105_publication_causal_observation.sql');
  if(fs.existsSync(causalPath)) await a.query(fs.readFileSync(causalPath,'utf8'));
  const stamp=()=>new Date().toISOString();
  const screens=Array.from({length:6},(_,i)=>({tableId:`T${i+1}`,shoe:999,round:10,roundBasis:'completed',sourceUpdatedAt:stamp(),dealerName:`dealer${i}`,bigRoadRaw:[{banker:[1,2]}],unknownNested:{keep:['all','fields']}}));
  const raw=async()=>a.query("insert into public.cloud_table_snapshots(id,session_id,capture_source,table_count,tables,snapshot_at) values ('00000000-0000-0000-0000-000000000001','fixture','cloud_browser',6,$1::jsonb,clock_timestamp()) on conflict(id) do update set tables=excluded.tables,snapshot_at=excluded.snapshot_at",[JSON.stringify(screens)]);
  await raw();
  const ids=[]; for(let t=1;t<=6;t++) ids.push((await issue(a,t)).prediction_id);
  const pending=await read(a); assert.equal(pending.length,6); pending.forEach((x,i)=>{assert.deepEqual(x.table,screens[i]); assert.equal(x.prediction,null); assert.equal(x.publication.state,'pending');}); ok('all six complete raw screens pending');
  // Observation is read metadata, not a publication write or transaction clock.
  const beforeObservation=(await a.query('select to_jsonb(p) v from public.v105_table_publications p order by table_id')).rows;
  await a.query('begin read only');
  const observed1=(await a.query("select public.read_v105_table_publications() v, pg_current_snapshot()::text snapshot, (extract(epoch from statement_timestamp())*1000000)::bigint::text stamp, pg_current_xact_id_if_assigned()::text xid")).rows[0];
  assert.equal(observed1.xid,null);
  const activeSnapshot=observed1.snapshot;
  assert.equal(observed1.v[0].publication.observation?.snapshot,activeSnapshot,'read must expose its active MVCC snapshot');
  assert.match(observed1.v[0].publication.observation.epoch,/^[a-f0-9]{64}$/);
  assert.equal(observed1.v.length,6);
  for(const row of observed1.v) { assert.deepEqual(row.publication.observation,observed1.v[0].publication.observation); assert.match(row.publication.observedAtMicros,/^[1-9][0-9]*$/); assert.equal(row.publication.observedAtMicros,observed1.stamp); assert.equal(row.publication.revision,null); }
  ok('one SQL statement stamps every pending row with exact decimal microseconds');
  const observed2=await read(a);
  assert.equal(observed2[0].publication.observation.snapshot,activeSnapshot);
  assert.equal(new Set(observed2.map(x=>x.publication.observedAtMicros)).size,1);
  await a.query('commit');
  assert.deepEqual((await a.query('select to_jsonb(p) v from public.v105_table_publications p order by table_id')).rows,beforeObservation);
  ok('two statements in one read-only transaction preserve visibility without writes or invented generation');
  const b=await connect(), c=await connect();
  await a.query('begin'); assert.equal((await pub(a)).disposition,'published');
  assert.equal((await read(b))[0].publication.state,'pending'); await a.query('rollback');
  assert.equal((await c.query('select count(*)::int n from public.v105_table_publications')).rows[0].n,0); ok('uncommitted bundle invisible; rollback no publication');
  await a.query('begin'); const first=await pub(a); assert.equal(first.publication_revision,1);
  let done=false; const racing=pub(b).then(v=>{done=true;return v;});
  const pid=(await c.query('select pid from pg_stat_activity where pid<>pg_backend_pid() and query like $1 and wait_event=\'advisory\'',['select public.publish_v105_table_publication%'])).rows;
  // Poll the actual scheduler, not merely a timer assertion.
  let observed=pid.length>0;
  for(let i=0;!observed && i<60;i++){await new Promise(r=>setTimeout(r,10)); observed=(await c.query("select 1 from pg_stat_activity where wait_event='advisory' and cardinality(pg_blocking_pids(pid))>0")).rowCount>0;}
  assert(observed); assert.equal(done,false);
  assert.equal((await pub(c,2)).disposition,'published'); ok('same-table real advisory waiter; different-table no lock contention');
  await a.query('commit'); assert.equal((await racing).disposition,'duplicate');
  const ready=(await read(c))[0]; assert.equal(ready.publication.state,'ready'); assert.deepEqual(ready.table,screens[0]); assert.equal(ready.prediction.predictionId,ids[0]);
  assert.equal((await pub(c)).publication_revision,1); ok('atomic commit exact bundle and concurrent duplicate stable revision');
  const publicationBefore=(await a.query('select to_jsonb(p) v from public.v105_table_publications p order by table_id')).rows;
  await a.query("update public.ai_strategy_versions set issuance_enabled=false");
  const revokedObservation=(await read(c))[0];
  assert.equal(revokedObservation.publication.state,'pending'); assert.equal(revokedObservation.publication.revision,null);
  await a.query("update public.ai_strategy_versions set issuance_enabled=true");
  await c.query('begin read only'); const restoredObservation=await read(c); await c.query('commit');
  assert.equal(new Set(restoredObservation.map(x=>x.publication.observedAtMicros)).size,1);
  assert.equal(restoredObservation[0].publication.revision,ready.publication.revision);
  assert.equal(restoredObservation[0].publication.sourceCapturedAt,ready.publication.sourceCapturedAt);
  assert.deepEqual(restoredObservation[0].prediction,ready.prediction);
  assert(BigInt(revokedObservation.publication.observedAtMicros)>BigInt(ready.publication.observedAtMicros));
  assert(BigInt(restoredObservation[0].publication.observedAtMicros)>BigInt(revokedObservation.publication.observedAtMicros));
  assert.deepEqual((await a.query('select to_jsonb(p) v from public.v105_table_publications p order by table_id')).rows,publicationBefore);
  ok('ready pending ready keeps same publication revision and source while observations advance; mixed rows share stamp');
  // Real fresh READ COMMITTED inversion, no sleep: the simple-protocol message
  // fixes A's statement timestamp before a controlled lock barrier; its second
  // SELECT obtains a new snapshot only after disable commits.
  await c.query('select pg_advisory_lock(1052026)');
  const apid=(await b.query('select pg_backend_pid() pid')).rows[0].pid;
  const inverted=b.query('select pg_advisory_lock(1052026); select public.read_v105_table_publications() v; select pg_advisory_unlock(1052026)');
  let barrier=false;
  for(let i=0;i<200 && !barrier;i++) barrier=(await a.query("select wait_event='advisory' as blocked from pg_stat_activity where pid=$1",[apid])).rows[0]?.blocked===true;
  assert(barrier,'real A lock waiter required');
  const oldReady=(await read(a))[0];
  await a.query('update public.ai_strategy_versions set issuance_enabled=false');
  await c.query('select pg_advisory_unlock(1052026)');
  const laterPending=(await inverted)[1].rows[0].v[0];
  assert.equal(oldReady.publication.state,'ready'); assert.equal(laterPending.publication.state,'pending');
  assert(BigInt(laterPending.publication.observedAtMicros)<BigInt(oldReady.publication.observedAtMicros));
  assert.notEqual(laterPending.publication.observation.snapshot,oldReady.publication.observation.snapshot);
  console.log(JSON.stringify({causalRace:{oldReady,laterPending}}));
  ok('real fresh READ COMMITTED later snapshot has older statement clock');
  // Retained RR also exposes its actual old active snapshot, not a fake new token.
  await b.query('begin isolation level repeatable read read only');
  const retained=(await read(b))[0];
  await a.query('update public.ai_strategy_versions set issuance_enabled=true');
  const restored=(await read(a))[0]; const retainedAgain=(await read(b))[0];
  assert.equal(retainedAgain.publication.state,'pending');
  assert.equal(retainedAgain.publication.observation.snapshot,retained.publication.observation.snapshot);
  assert.notEqual(restored.publication.observation.snapshot,retained.publication.observation.snapshot);
  await b.query('rollback');
  assert.equal(restored.publication.revision,oldReady.publication.revision);
  console.log(JSON.stringify({causalRecovery:{restored,retainedAgain}}));
  ok('retained snapshot stays old; committed re-enable advances causality without republishing');
  await b.query('begin'); await b.query('update public.ai_strategy_versions set issuance_enabled=false');
  assert.equal((await read(b))[0].publication.observation,null,'own writes cannot supply causal evidence');
  await c.query('select pg_current_xact_id()'); // Finish a higher xid while b remains in progress.
  const xipReady=(await read(a))[0]; await b.query('commit'); const xipPending=(await read(a))[0];
  assert.equal(xipReady.publication.state,'ready'); assert.equal(xipPending.publication.state,'pending');
  const xr=xipReady.publication.observation.snapshot.split(':'), xp=xipPending.publication.observation.snapshot.split(':');
  assert.equal(xr[1],xp[1]); assert.notEqual(xr[2],xp[2]);
  console.log(JSON.stringify({causalXip:{xipReady,xipPending}}));
  await a.query('update public.ai_strategy_versions set issuance_enabled=true');
  ok('same xmax with completed xip changes visibility; own-xid observation rejected');
  screens[0].dealerName='new complete screen'; screens[0].sourceUpdatedAt=stamp(); await raw();
  const beforeRefresh=(await read(c))[0]; assert.equal(beforeRefresh.table.dealerName,'dealer0');
  assert.equal(beforeRefresh.publication.sourceCapturedAt,ready.publication.sourceCapturedAt);
  assert.equal(beforeRefresh.publication.publishedAt,ready.publication.publishedAt);
  ok('read returns entire prior bundle, never newer raw screen with older prediction or query-time clocks');
  assert.equal((await pub(a)).publication_revision,2); const enrichment=(await read(c))[0]; assert.equal(enrichment.table.dealerName,'new complete screen'); assert.equal(enrichment.prediction.predictionId,ids[0]); ok('same identity mutable snapshot full-screen refresh without issue');
  await assert.rejects(pub(a,1,'999',11,ids[1]),/exact immutable/); ok('wrong durable id rejected');
  await a.query("update public.daily_prediction_results set issued_prediction_payload=jsonb_set(issued_prediction_payload,'{targetRound}','12') where id=$1",[ids[0]]);
  await assert.rejects(pub(a),/exact immutable/); assert.equal((await read(c))[0].publication.state,'pending');
  await a.query('update public.daily_prediction_results set issued_prediction_payload=$1::jsonb where id=$2',[JSON.stringify(request(1).issued_prediction_payload),ids[0]]); ok('wrong immutable payload target refused in publish and read');
  for(const update of ["source='wrong'", "settlement_final=true", "actual_result='banker'", "resolved_at=now()"]){
    await a.query('begin'); await a.query(`update public.daily_prediction_results set ${update} where id=$1`,[ids[0]]);
    assert.equal((await read(a))[0].publication.state,'pending'); await assert.rejects(pub(a),/exact immutable/); await a.query('rollback');
  } ok('wrong source and all Final indicators fail closed');
  await a.query('begin'); await a.query("update public.ai_strategy_versions set status='disabled'"); assert.equal((await read(a))[0].publication.state,'pending'); await assert.rejects(pub(a),/Active/); await a.query('rollback'); ok('inactive strategy refused');
  await a.query('begin'); await a.query("update public.v105_table_publications set source_captured_at=now()-interval '121 seconds' where table_id='T1'"); assert.equal((await read(a))[0].publication.state,'pending'); await a.query('rollback');
  const saved=screens[0].sourceUpdatedAt; screens[0].sourceUpdatedAt=new Date(Date.now()-121000).toISOString(); await raw(); await assert.rejects(pub(a),/stale/); assert.equal((await read(c))[0].publication.state,'pending'); screens[0].sourceUpdatedAt=saved; await raw(); ok('120s source freshness and publication freshness enforced');
  await a.query('begin'); await pub(a);
  const late=pub(b); let wait=false; for(let i=0;!wait&&i<60;i++){await new Promise(r=>setTimeout(r,10));wait=(await c.query("select 1 from pg_stat_activity where wait_event='advisory' and cardinality(pg_blocking_pids(pid))>0")).rowCount>0;} assert(wait);
  screens[0].shoe=1; screens[0].round=0; screens[0].sourceUpdatedAt=stamp();
  await c.query('update public.cloud_table_snapshots set tables=$1::jsonb,snapshot_at=clock_timestamp()',[JSON.stringify(screens)]);
  const advanced=await read(c); assert.equal(advanced.length,6); assert.equal(advanced[0].publication.state,'pending'); assert.deepEqual(advanced[0].table,screens[0]); assert.equal(advanced[0].prediction,null);
  await a.query('commit'); assert.equal((await late).disposition,'superseded');
  const newId=(await issue(a,1,'1',1)).prediction_id; assert.equal((await pub(a,1,'1',1,newId)).disposition,'published'); assert.equal((await pub(a)).disposition,'superseded'); assert.equal((await read(c))[0].prediction.predictionId,newId); ok('raw advance fences waited old publication; 999 to 1 valid; late old superseded');
  await pub(a,2); // Bring T2 to the latest raw snapshot clock before exact replay ACL checks.
  for(const role of ['anon','authenticated','service_role']){
    await a.query(`set role ${role}`);
    for(const sql of ['select * from public.v105_table_publications','delete from public.v105_table_publications',"insert into public.v105_table_publications(table_id) values ('bad')", "update public.v105_table_publications set revision=999"]){await assert.rejects(a.query(sql),e=>e.code==='42501');}
    if(role==='service_role'){assert.equal((await read(a)).length,6);assert.equal((await pub(a,2)).disposition,'duplicate');}
    else {await assert.rejects(read(a),e=>e.code==='42501');await assert.rejects(pub(a,2),e=>e.code==='42501');}
    await a.query('reset role');
  }
  assert.equal((await a.query("select relrowsecurity from pg_class where oid='public.v105_table_publications'::regclass")).rows[0].relrowsecurity,true); ok('real role SELECT/DML/EXECUTE privileges and RLS');
  const {spawn}=require('node:child_process');
  const recovered=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[__filename,'recover'],{env:process.env,stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.on('error',reject);child.on('close',code=>code===0?resolve(out):reject(Error(err)));});
  assert.equal((await read(a))[5].prediction.predictionId,ids[5]); console.log(recovered.trim()); ok('fresh OS process fills missing publication using existing issue identity');
  await a.query('begin');
  await a.query("insert into public.cloud_table_snapshots select 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid,session_id,capture_source,table_count,jsonb_set(tables,'{2,round}','11'),table_summary,snapshot_at,metadata from public.cloud_table_snapshots where id='00000000-0000-0000-0000-000000000001'");
  assert.equal((await read(a))[2].publication.rawIdentity.round,12);
  assert.equal((await pub(a,3)).disposition,'superseded'); await a.query('rollback'); ok('latest raw authority snapshot_at then id tie-break, no shoe ordering');
  await a.query('begin'); await a.query('update public.ai_strategy_versions set issuance_enabled=false');
  assert.equal((await read(a))[1].publication.state,'pending'); await assert.rejects(pub(a,2),/Active/); await a.query('rollback'); ok('Active issuance admission fence enforced');
  const catalog=(await a.query("select proname,prosecdef,proconfig,proacl::text from pg_proc where oid in ('public.publish_v105_table_publication(text,text,integer,uuid)'::regprocedure,'public.read_v105_table_publications()'::regprocedure) order by proname")).rows;
  assert.equal(catalog.length,2); for(const f of catalog){assert.equal(f.prosecdef,true);assert.deepEqual(f.proconfig,['search_path=pg_catalog']);assert(!f.proacl.includes('=X/postgres,anon'));}
  await a.query('create role publication_outsider; set role publication_outsider'); await assert.rejects(read(a),e=>e.code==='42501'); await assert.rejects(pub(a,2),e=>e.code==='42501'); await a.query('reset role');
  console.log(JSON.stringify({catalog})); ok('definer safe search_path catalog and PUBLIC-only outsider rejection');
  const before=(await a.query('select to_jsonb(p) v from public.v105_table_publications p order by table_id')).rows;
  await a.query(rollback); await a.query(rollback); await a.query('set role service_role'); await assert.rejects(pub(a,2),e=>e.code==='42501'); assert.equal((await read(a)).length,6); await a.query('reset role');
  assert.deepEqual((await a.query('select to_jsonb(p) v from public.v105_table_publications p order by table_id')).rows,before);
  await a.query(migration); await a.query(fs.readFileSync(causalPath,'utf8')); await a.query('set role service_role'); assert.equal((await pub(a,2)).disposition,'duplicate'); assert((await read(a))[0].publication.observation); await a.query('reset role'); ok('non-destructive rollback rerun retains read and evidence; explicit forward reactivation');
  assert((await a.query("select pg_get_functiondef('public.read_v105_table_publications()'::regprocedure) def")).rows[0].def.includes('pg_current_snapshot()'));
  console.log(JSON.stringify({checks,passed:checks.length,fixtureScope:'publication only; archived issue RPC with minimal columns, no full settlement pipeline'}));
})().catch(e => {console.error(JSON.stringify({error:e.message, code:e.code, stack:e.stack})); process.exitCode=1;}).finally(async()=>{for(const c of clients) {try{await c.query('rollback');}catch{} await c.end();}});
