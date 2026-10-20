"""Real PG17 regression; explicit fresh synthetic loopback opt-in only.
Retains every run, SQL, source and normal-stop receipt. No production credentials.
Derived from the retained preflight run-02 runner; not a production migration.
"""
import os, sys, json, hashlib, subprocess, socket, time, traceback, uuid, re, threading, importlib.util
from pathlib import Path
from datetime import datetime, timezone, timedelta
# Explicit opt-in: only fresh loopback synthetic clusters, never a supplied DSN.
import argparse
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--evidence-root',required=True,type=Path)
parser.add_argument('--pg-bin',required=True,type=Path)
parser.add_argument('--compiler-python',required=True,type=Path)
parser.add_argument('--psutil-path',type=Path)
parser.add_argument('--driver-path',type=Path)
parser.add_argument('--port',required=True,type=int)
parser.add_argument('--expected-head',required=True)
parser.add_argument('--git',required=True,type=Path)
parser.add_argument('--synthetic-disposable-only',required=True,action='store_true')
args=parser.parse_args()
ROOT=args.evidence_root
assert ROOT.is_absolute() and '..' not in ROOT.parts
for p in [ROOT,*ROOT.parents]:
    if p.exists():
        assert not p.is_symlink() and not (p.stat().st_file_attributes & 0x400), 'LINKED_EVIDENCE_ROOT'
ROOT.mkdir(exist_ok=False)
REPO=Path(__file__).resolve().parents[3]
HEAD=args.expected_head
BIN=args.pg_bin
PY312=args.compiler_python
PORT=args.port
assert 1024<PORT<65536
DB='oner_synthetic_'+str(PORT)
GIT=args.git
paths=[]; pins={}; threads=[]; children=[]
index_path=None; index_before=None
DATA=ROOT/'cluster'
SRC=ROOT/'source'
TABLE='public.v105_capture_settlement_outbox'
RESULT={'status':'RUNNING','scope':'SYNTHETIC_DISPOSABLE_PG_ONLY','head':HEAD,'source_kind':'EXACT_RAW_WORKTREE_COPY','tests':[],'cleanup':{},'issues':[]}
clients=[]; proc=None; serverlog=None; control_id=None; pid=None
sha=lambda b:hashlib.sha256(b).hexdigest()
def write(name,obj):
    p=ROOT/name
    p.parent.mkdir(parents=True,exist_ok=True)
    p.write_text(json.dumps(obj,ensure_ascii=False,indent=2,default=str)+'\n',encoding='utf-8')
def log(event):
    with (ROOT/'tests.jsonl').open('a',encoding='utf-8') as f:f.write(json.dumps(event,ensure_ascii=False,default=str)+'\n')
    print(json.dumps(event,ensure_ascii=False,default=str),flush=True)
def record(name,passed,**kw):
    e={'name':name,'passed':bool(passed),**kw};RESULT['tests'].append(e);log(e);write('result.json',RESULT)
    if not passed:raise AssertionError('FAILED_CHECK:'+name)
def cmd(args,name,timeout=30):
    p=subprocess.run([str(a) for a in args],cwd=ROOT,env=env,capture_output=True,timeout=timeout)
    (ROOT/(name+'.stdout')).write_bytes(p.stdout);(ROOT/(name+'.stderr')).write_bytes(p.stderr)
    if p.returncode:raise RuntimeError(f'{name}:exit={p.returncode}: '+p.stderr.decode('utf-8','replace')[:1500])
    return p.stdout.decode('utf-8','replace')
def control(name):
    text=cmd([BIN/'pg_controldata.exe','-D',DATA],name)
    values=dict(line.split(':',1) for line in text.splitlines() if ':' in line)
    return {k.strip():v.strip() for k,v in values.items()}
def connect(role='oner_owner'):
    c=psycopg.connect(host='127.0.0.1',port=PORT,dbname=DB,user=role,connect_timeout=5,sslmode='disable',autocommit=True,options='-c statement_timeout=30000 -c timezone=UTC',application_name='oner-isolated-matrix')
    clients.append(c);return c
def execute(c,sql):
    out=[]
    with c.cursor() as cur:
        cur.execute(sql,prepare=False)
        while True:
            if cur.description:out.append({'columns':[x.name for x in cur.description],'rows':cur.fetchall()})
            if not cur.nextset():break
    return out
def snapshot(c):
    return c.execute(f'SELECT id::text,to_jsonb(o)::text FROM {TABLE} o ORDER BY id').fetchall()
def export(c,name):
    r=execute(c,(SRC/'export.sql').read_text('utf-8'))
    raw=r[0]['rows'][0][0]
    (ROOT/(name+'.json')).write_bytes(raw.encode('utf-8'))
    return json.loads(raw)
def sqltest(name,sql,expected=None,setup=None,undo=None):
    c=connect()
    try:
        c.execute("SET hermes.six_cutover_quiesced='yes'")
        if setup:execute(c,setup)
        try:
            out=execute(c,sql)
            if expected:record(name,False,expected=expected,actual='SUCCESS');return False
            record(name,True,sql_sha256=sha(sql.encode()),result_sets=out)
        except psycopg.Error as e:
            c.execute('ROLLBACK')
            good=expected is not None and e.sqlstate==expected[0] and (e.diag.message_primary==expected[1] if expected[0]=='P0001' else expected[1] in e.diag.message_primary)
            record(name,good,sql_sha256=sha(sql.encode()),sqlstate=e.sqlstate,message=str(e),context=e.diag.context,position=e.diag.statement_position)
            if not good:RESULT['issues'].append({'test':name,'sqlstate':e.sqlstate,'message':str(e)})
            return good
    finally:
        c.execute('ROLLBACK')
        if undo:execute(c,undo)
        c.close()
    return True

def main():
    global env,psycopg,psutil,proc,serverlog,control_id,pid,paths,pins,index_path,index_before
    assert not DATA.exists() and not SRC.exists(), 'FRESH_ROOT_REQUIRED'
    (ROOT/'tmp').mkdir(exist_ok=True)
    env={k:v for k,v in os.environ.items() if k.upper() in {'SYSTEMROOT','WINDIR','COMSPEC'}}
    env.update({'PATH':str(BIN)+';C:/Windows/System32;C:/Users/童威仁/AppData/Local/hermes/git/cmd','TEMP':str(ROOT/'tmp'),'TMP':str(ROOT/'tmp'),'LC_ALL':'C','LANG':'C','LANGUAGE':'C','PYTHONDONTWRITEBYTECODE':'1','PYTHONUTF8':'1'})
    os.environ.clear();os.environ.update(env)
    if args.driver_path:sys.path.append(str(args.driver_path))
    import psycopg as pg
    if args.psutil_path:sys.path.append(str(args.psutil_path))
    import psutil as ps
    psycopg=pg;psutil=ps
    RESULT['environment_keys']=sorted(env)
    SRC.mkdir()
    paths=['supabase/operations/six-raw-outbox-v1/'+n for n in ['build_packet.py','export.sql','README.md','test_build_packet.py','real_pg_regression.py']]+['supabase/migrations/20260729043000_v105_capture_settlement_outbox.sql']
    assert subprocess.check_output([str(GIT),'-C',str(REPO),'rev-parse','HEAD'],env=env).decode().strip()==HEAD
    index_path=Path(subprocess.check_output([str(GIT),'-C',str(REPO),'rev-parse','--path-format=absolute','--git-path','index'],env=env).decode().strip())
    index_before=sha(index_path.read_bytes())
    for path in paths:
        raw=(REPO/path).read_bytes()
        worktree_hash=sha(raw)
        if '/migrations/' in path:
            # Immutable fixture origin is the Git blob, not a checkout EOL filter.
            immutable=subprocess.check_output([str(GIT),'-C',str(REPO),'show',HEAD+':'+path],env=env)
            assert sha(immutable)=='40b985d62f05894a3ac5a9c899cee3f8d59605531000deffb048b745f5fdc70d', 'IMMUTABLE_FIXTURE_MIGRATION_CHANGED'
            assert raw.replace(b'\r\n',b'\n')==immutable, 'FIXTURE_WORKTREE_SEMANTIC_DRIFT'
            raw=immutable
        (SRC/Path(path).name).write_bytes(raw)
        pins[path]={'sha256':sha(raw),'bytes':len(raw),'worktree_sha256':worktree_hash}
        assert sha((REPO/path).read_bytes())==worktree_hash and raw==(SRC/Path(path).name).read_bytes()
    pins['binaries']={str(BIN/n):sha((BIN/n).read_bytes()) for n in ['postgres.exe','pg_ctl.exe','initdb.exe','pg_controldata.exe']}
    pins['interpreters']={str(p):sha(p.read_bytes()) for p in [Path(sys.executable),PY312]}
    pins['psutil']={'origin':ps.__file__,'sha256':sha(Path(ps.__file__).read_bytes()),'version':ps.__version__}
    pins['psycopg']={'origin':pg.__file__,'sha256':sha(Path(pg.__file__).read_bytes()),'version':pg.__version__}
    RESULT['invocation']={'argv':sys.argv,'python':sys.executable,'repo':str(REPO),'index_sha256':index_before}
    write('source-hashes.json',pins)
    cmd([PY312,'-I','-B','-c',"import sys; from pathlib import Path; assert hasattr(Path,'is_junction'); print(sys.executable,sys.version)"],'compiler-python-preflight')
    spec=importlib.util.spec_from_file_location('compiler',SRC/'build_packet.py'); compiler=importlib.util.module_from_spec(spec);spec.loader.exec_module(compiler)
    s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_EXCLUSIVEADDRUSE,1);s.bind(('127.0.0.1',PORT));s.close()
    with socket.socket() as vacant:
        vacant.settimeout(4); code=vacant.connect_ex(('127.0.0.1',PORT))
    assert code in (10061,111), ('VACANCY_NOT_REFUSED',code)
    write('vacancy.json',{'exclusive_bind_succeeded':True,'connect_ex':code,'cluster_absent':not DATA.exists(),'database':DB,'port':PORT,'loopback':'127.0.0.1'})
    cmd([BIN/'initdb.exe','-D',DATA,'-U','oner_owner','--auth=trust','--encoding=UTF8','--locale=C'],'initdb',60)
    ctl=control('control-before');control_id=ctl['Database system identifier'];assert ctl['Database cluster state']=='shut down'
    with (DATA/'postgresql.conf').open('a',encoding='utf-8') as f:f.write(f"\nlisten_addresses='127.0.0.1'\nport={PORT}\nmax_connections=20\nshared_buffers='32MB'\nlogging_collector=off\nlog_min_error_statement=error\n")
    (DATA/'pg_hba.conf').write_text('host all all 127.0.0.1/32 trust\nhost all all 0.0.0.0/0 reject\nhost all all ::0/0 reject\n',encoding='utf-8')
    serverlog=(ROOT/'postgres.log').open('wb')
    proc=subprocess.Popen([str(BIN/'postgres.exe'),'-D',str(DATA)],cwd=ROOT,env=env,stdout=serverlog,stderr=subprocess.STDOUT)
    deadline=time.monotonic()+25
    while True:
        if proc.poll() is not None:raise RuntimeError('SERVER_EXIT_BEFORE_READY')
        try:
            a=psycopg.connect(host='127.0.0.1',port=PORT,dbname='postgres',user='oner_owner',connect_timeout=2,sslmode='disable',autocommit=True);clients.append(a);break
        except psycopg.OperationalError:
            if time.monotonic()>deadline:raise
            time.sleep(.15)
    pid=int((DATA/'postmaster.pid').read_text().splitlines()[0]);assert pid==proc.pid
    RESULT['server']={'pid':pid,'create_time':psutil.Process(pid).create_time(),'port':PORT,'cluster':str(DATA),'system_identifier':control_id,'version':cmd([BIN/'postgres.exe','--version'],'version').strip()}
    admin_identity=a.execute("SELECT current_database(),(SELECT system_identifier::text FROM pg_control_system()),current_setting('data_directory'),host(inet_server_addr()),inet_server_port(),current_user").fetchone()
    assert admin_identity[0]=='postgres' and admin_identity[1]==control_id and admin_identity[2].replace('\\','/').lower()==str(DATA).replace('\\','/').lower() and admin_identity[3]=='127.0.0.1' and admin_identity[4]==PORT and admin_identity[5]=='oner_owner', 'ADMIN_SERVER_IDENTITY'
    write('admin-identity-before-ddl.json',{'actual':admin_identity,'control_identifier':control_id,'cluster':str(DATA),'port':PORT})
    a.execute('CREATE DATABASE '+DB);a.close()
    c=connect()
    identity=c.execute("SELECT current_database(),(SELECT oid::text FROM pg_database WHERE datname=current_database()),(SELECT system_identifier::text FROM pg_control_system()),inet_server_addr()::text,inet_server_port(),current_user,current_user::regrole::oid::text,current_setting('server_version_num'),current_setting('data_directory'),current_setting('listen_addresses')").fetchone()
    assert identity[0]==DB and identity[3]=='127.0.0.1/32' and identity[2]==control_id and identity[4]==PORT and identity[8].replace('\\','/').lower()==str(DATA).replace('\\','/').lower() and identity[9]=='127.0.0.1'
    expected=dict(zip(['database','database_oid','system_identifier','server_address','server_port','role','role_oid','server_version'],identity[:8]));write('expected-identity.json',expected)
    ddl=(SRC/'20260729043000_v105_capture_settlement_outbox.sql').read_text('utf-8')
    start=ddl.index('create table if not exists public.v105_capture_settlement_outbox (');end=ddl.index('\n);',start)+3
    fixture_ddl=ddl[start:end]+f'\nALTER TABLE {TABLE} ENABLE ROW LEVEL SECURITY;\nCREATE ROLE anon LOGIN; CREATE ROLE authenticated LOGIN; CREATE ROLE service_role LOGIN BYPASSRLS; CREATE ROLE fixture_untrusted LOGIN;\nREVOKE ALL ON {TABLE} FROM PUBLIC,anon,authenticated,service_role;'
    (ROOT/'fixture-ddl.sql').write_text(fixture_ddl,encoding='utf-8');execute(c,fixture_ddl)
    ids=[]
    for i,(table,status) in enumerate([('BAG01','pending'),('BAG03A','pending'),('BAG10','pending'),('BAV01','completed'),('BAG02','dead_letter')],1):
        ident=str(uuid.uuid5(uuid.NAMESPACE_URL,'oner-fixture-'+str(i)));ids.append(ident)
        keys=[f'{table}:123:{i}'];payload={'round_keys':keys,'rounds':[{'source':'ofalive99','table_id':table,'shoe_no':123,'round_no':i}],'synthetic':True}
        c.execute(f'INSERT INTO {TABLE}(id,session_id,sequence,round_keys,payload,payload_hash,status) VALUES(%s,%s,%s,%s::jsonb,%s::jsonb,%s,%s)',(ident,'oner-synthetic',i,json.dumps(keys),json.dumps(payload),sha(json.dumps(payload).encode()),status))
    initial=snapshot(c);write('initial-rows.json',initial)
    freeze=export(c,'freeze')
    assert freeze['identity']==expected
    output=cmd([PY312,'-B',SRC/'build_packet.py','--freeze',ROOT/'freeze.json','--expected-identity',ROOT/'expected-identity.json','--output',ROOT/'packet'],'compiler',30)
    manifest=json.loads(output);receipt='public.six_hold_'+manifest['operation_id'].replace('-','')
    hold=(ROOT/'packet/hold.sql').read_text('utf-8');reverse=(ROOT/'packet/reverse.sql').read_text('utf-8')
    assert hold.endswith('ROLLBACK;\n') and reverse.endswith('ROLLBACK;\n')
    commit_hold=hold[:-len('ROLLBACK;\n')]+'COMMIT;\n';commit_reverse=reverse[:-len('ROLLBACK;\n')]+'COMMIT;\n'
    (ROOT/'terminal-only-hold-commit.sql').write_bytes(commit_hold.encode());(ROOT/'terminal-only-reverse-commit.sql').write_bytes(commit_reverse.encode())
    write('terminal-delta.json',{'scope':'SYNTHETIC_DB_ONLY','replacement':'final ROLLBACK; -> COMMIT;','hold_original':sha(hold.encode()),'hold_commit':sha(commit_hold.encode()),'reverse_original':sha(reverse.encode()),'reverse_commit':sha(commit_reverse.encode()),'interior_equal':hold[:-len('ROLLBACK;\n')]==commit_hold[:-len('COMMIT;\n')] and reverse[:-len('ROLLBACK;\n')]==commit_reverse[:-len('COMMIT;\n')]})
    record('actual_export_and_compiler',True,inventory=len(freeze['rows']),targets=manifest['target_count'],identity=expected)
    sqltest('missing_quiescence',hold,('P0001','QUIESCENCE_DECLARATION_REQUIRED'),setup="RESET hermes.six_cutover_quiesced")
    sqltest('hold_default_rollback',hold)
    # A failed positive raises immediately: no dependent negative can mask 42702.
    record('rollback_all_rows_and_receipt_absence',snapshot(c)==initial and c.execute('SELECT to_regclass(%s)',(receipt,)).fetchone()[0] is None)
    # Preimage drift is a committed synthetic fixture mutation; restore it explicitly.
    sqltest('hold_preimage_drift',hold,('P0001','EXACT_INVENTORY_PREIMAGE'),setup=f"UPDATE {TABLE} SET last_error='synthetic-drift' WHERE id='{ids[0]}'",undo=f"UPDATE {TABLE} SET last_error=NULL WHERE id='{ids[0]}'")
    sqltest('catalog_drift',hold,('P0001','CATALOG_DRIFT'),setup=f'GRANT SELECT ON {TABLE} TO anon',undo=f'REVOKE SELECT ON {TABLE} FROM anon')
    # A fresh DB export with BAV pending must be refused by the real compiler.
    c.execute(f"UPDATE {TABLE} SET status='pending' WHERE id=%s",(ids[3],));bav=export(c,'bav-pending')
    try:compiler.validate(bav,expected);record('bav_pending_export_compiler_refusal',False)
    except ValueError as e:record('bav_pending_export_compiler_refusal',str(e)=='NON_BAG_KEY',message=str(e),boundary='actual PG export -> offline compiler')
    sqltest('bav_pending_changed_inventory_sql_refusal',hold,('P0001','EXACT_INVENTORY_PREIMAGE'))
    c.execute(f"UPDATE {TABLE} SET status='completed' WHERE id=%s",(ids[3],))
    # Two physical connections; blocked backend must be observed before its real lock timeout.
    holder=connect();waiter=connect();box={};observed=None;th=None
    try:
        holder.execute('BEGIN');holder.execute(f'UPDATE {TABLE} SET attempts=attempts WHERE id=%s',(ids[0],))
        waiter.execute("SET hermes.six_cutover_quiesced='yes'")
        wp=waiter.info.backend_pid;hp=holder.info.backend_pid
        def wait_sql():
            t=time.monotonic()
            try:execute(waiter,hold);box['success']=True
            except psycopg.Error as e:box.update(sqlstate=e.sqlstate,message=str(e),elapsed=time.monotonic()-t)
            except BaseException as e:box['thread_error']=repr(e)
            finally:
                try:waiter.execute('ROLLBACK')
                except BaseException as e:box['rollback_error']=repr(e)
        th=threading.Thread(target=wait_sql);threads.append(th);th.start()
        deadline=time.monotonic()+2.5
        while time.monotonic()<deadline:
            r=c.execute('SELECT wait_event_type,wait_event,pg_blocking_pids(pid) FROM pg_stat_activity WHERE pid=%s',(wp,)).fetchone()
            if r and r[0]=='Lock' and hp in r[2]:observed=r;break
            time.sleep(.03)
        th.join(8)
    finally:
        holder.execute('ROLLBACK');holder.close()
        if th is not None:th.join(35)
        if th is not None and th.is_alive():raise RuntimeError('UNJOINED_LOCK_CLIENT')
        waiter.close()
    record('two_connection_real_lock_wait_timeout',observed is not None and box.get('sqlstate')=='55P03' and not th.is_alive() and 'rollback_error' not in box,waiter_pid=wp,holder_pid=hp,observation=observed,outcome=box)
    record('lock_timeout_original_rows',snapshot(c)==initial)
    # Unknown default grantee must be rejected, not silently retained.
    sqltest('receipt_unknown_default_grant_refusal',hold,('P0001','RECEIPT_NOT_PRIVATE_PLAIN_OWNER_TABLE'),
        setup='ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO fixture_untrusted',
        undo='ALTER DEFAULT PRIVILEGES REVOKE SELECT ON TABLES FROM fixture_untrusted')
    record('default_grant_refusal_rollback',snapshot(c)==initial and c.execute('SELECT to_regclass(%s)',(receipt,)).fetchone()[0] is None)
    # Explicitly named runtime role defaults must be removed by the product REVOKE.
    c.execute('ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO anon,authenticated,service_role')
    sqltest('known_role_default_grants_hold_rollback',hold)
    sqltest('hold_commit_synthetic_only',commit_hold)
    after=snapshot(c);expected_after=[(r['id'],r['after_text']) for r in freeze['rows']]
    record('independent_full_postimage_non_target',after==expected_after and len(after)==len(initial),rows=after)
    write('held-rows.json',after)
    acl=c.execute('SELECT c.relrowsecurity,c.relforcerowsecurity,c.relacl::text,(SELECT count(*) FROM pg_policy p WHERE p.polrelid=c.oid),(SELECT count(*) FROM aclexplode(coalesce(c.relacl,acldefault(\'r\',c.relowner))) a WHERE a.grantee<>c.relowner) FROM pg_class c WHERE c.oid=%s::regclass',(receipt,)).fetchone();record('receipt_rls_catalog',acl[0] and acl[3]==0 and acl[4]==0,catalog=acl)
    for role in ['anon','authenticated','service_role']:
        rc=connect(role)
        for op in ['SELECT * FROM '+receipt,'UPDATE '+receipt+' SET reversed=true']:
            try:rc.execute(op);record('receipt_acl_'+role+'_'+op.split()[0],False)
            except psycopg.Error as e:record('receipt_acl_'+role+'_'+op.split()[0],e.sqlstate=='42501',sqlstate=e.sqlstate,message=str(e))
        rc.close()
    sqltest('duplicate_hold_held',hold,('P0001','EXACT_INVENTORY_PREIMAGE'))
    sqltest('reverse_postimage_drift',reverse,('P0001','EXACT_INVENTORY_PREIMAGE'),setup=f"UPDATE {TABLE} SET last_error='drift' WHERE id='{ids[0]}'",undo=f"UPDATE {TABLE} SET last_error=NULL WHERE id='{ids[0]}'")
    sqltest('reverse_receipt_drift',reverse,('P0001','RECEIPT_PROOF'),setup=f"UPDATE {receipt} SET before_sha256=repeat('0',64) WHERE id='{ids[0]}'",undo=f"UPDATE {receipt} SET before_sha256='{next(r['before_sha256'] for r in freeze['rows'] if r['id']==ids[0])}' WHERE id='{ids[0]}'")
    sqltest('receipt_grant_drift',reverse,('P0001','RECEIPT_NOT_PRIVATE_PLAIN_OWNER_TABLE'),setup=f'GRANT SELECT ON {receipt} TO anon',undo=f'REVOKE SELECT ON {receipt} FROM anon')
    sqltest('receipt_column_grant_drift',reverse,('P0001','RECEIPT_NOT_PRIVATE_PLAIN_OWNER_TABLE'),setup=f'GRANT SELECT(before_text) ON {receipt} TO anon',undo=f'REVOKE SELECT(before_text) ON {receipt} FROM anon')
    sqltest('receipt_policy_drift',reverse,('P0001','RECEIPT_NOT_PRIVATE_PLAIN_OWNER_TABLE'),setup=f'CREATE POLICY fixture_policy ON {receipt} USING (true)',undo=f'DROP POLICY fixture_policy ON {receipt}')
    sqltest('receipt_rls_disabled_drift',reverse,('P0001','RECEIPT_NOT_PRIVATE_PLAIN_OWNER_TABLE'),setup=f'ALTER TABLE {receipt} DISABLE ROW LEVEL SECURITY',undo=f'ALTER TABLE {receipt} ENABLE ROW LEVEL SECURITY')
    sqltest('reverse_default_rollback',reverse)
    record('reverse_rollback_full_postimage_preserved',snapshot(c)==after and c.execute(f'SELECT bool_and(NOT reversed) FROM {receipt}').fetchone()[0])
    # Explicit synthetic historical receipt fixture, not claimed to be a naturally aged live operation.
    old=dict(freeze);old['exported_at']=(datetime.now(timezone.utc)-timedelta(days=2)).isoformat();raw=json.dumps(old,ensure_ascii=False).encode();fh=sha(raw);operation=str(uuid.uuid5(uuid.NAMESPACE_URL,compiler.VERSION+':'+fh));hist='public.six_hold_'+operation.replace('-','')
    oldsql=compiler.render(old,fh,operation,True);(ROOT/'historical-freeze.json').write_bytes(raw);(ROOT/'historical-reverse.sql').write_bytes(oldsql.encode())
    execute(c,f'CREATE TABLE {hist} (LIKE {receipt} INCLUDING ALL); ALTER TABLE {hist} ENABLE ROW LEVEL SECURITY; REVOKE ALL ON {hist} FROM PUBLIC,anon,authenticated,service_role; INSERT INTO {hist} SELECT id,\'{operation}\'::uuid,\'{fh}\',before_text,before_sha256,after_text,after_sha256,false FROM {receipt};')
    sqltest('historical_freeze_reverse_real_sql',oldsql)
    record('historical_reversal_rollback',snapshot(c)==after,limitation='synthetic 2-day-old freeze and independently seeded matching receipt; actual generated SQL, not 2-day wall-time aging')
    execute(c,f'DROP TABLE {hist}')
    sqltest('reverse_commit_synthetic_only',commit_reverse)
    record('independent_full_restoration_and_reversed_receipt',snapshot(c)==initial and c.execute(f'SELECT bool_and(reversed),count(*) FROM {receipt}').fetchone()==(True,manifest['target_count']))
    sqltest('duplicate_reverse',reverse,('P0001','EXACT_INVENTORY_PREIMAGE'))
    sqltest('duplicate_hold_after_reverse',hold,('42P07','already exists'))
    # Isolate the receipt replay guard while recreating its exact afterimage in a rollback transaction.
    sqltest('reversed_receipt_replay_proof',reverse,('P0001','RECEIPT_PROOF'),setup=f"UPDATE {TABLE} SET status='dead_letter' WHERE id IN ('{ids[0]}','{ids[1]}','{ids[2]}')",undo=f"UPDATE {TABLE} SET status='pending' WHERE id IN ('{ids[0]}','{ids[1]}','{ids[2]}')")
    record('final_original_rows_preserved',snapshot(c)==initial)
    write('final-rows.json',snapshot(c));write('receipt-final.json',execute(c,f'SELECT * FROM {receipt} ORDER BY id'))
    record('outbox_catalog_unchanged',c.execute('SELECT value::text FROM ('+compiler.query('CATALOG')+') q').fetchone()[0]==freeze['catalog_text'])
    RESULT['status']='PASS' if RESULT['tests'] and all(t['passed'] for t in RESULT['tests']) else 'FAIL'

try:
    main()
except BaseException as e:
    RESULT['status']='ERROR';RESULT['issues'].append({'type':type(e).__name__,'message':str(e),'traceback':traceback.format_exc()});log({'fatal':str(e),'traceback':traceback.format_exc()})
finally:
    for th in threads:
        th.join(35)
    RESULT['cleanup']['all_threads_joined']=all(not th.is_alive() for th in threads)
    for c in clients:
        try:
            if not c.closed:c.execute('ROLLBACK');c.close()
        except BaseException as e:RESULT['cleanup'].setdefault('connection_errors',[]).append(str(e));c.close()
    try:
        RESULT['cleanup']['all_clients_closed']=all(c.closed for c in clients)
        if proc is not None and proc.poll() is None:
            children=psutil.Process(proc.pid).children(recursive=True)
            RESULT['cleanup']['children_before_stop']=[{'pid':p.pid,'create_time':p.create_time()} for p in children]
            cmd([BIN/'pg_ctl.exe','-D',DATA,'stop','-m','fast','-w','-t','30'],'pg-stop',40)
            RESULT['cleanup']['normal_pg_ctl_stop']=True
            RESULT['cleanup']['owned_process_exit']=proc.wait(timeout=10)
            gone,alive=psutil.wait_procs(children,timeout=10)
            RESULT['cleanup']['children_natural_exit']=not alive
            RESULT['cleanup']['children_remaining']=[p.pid for p in alive]
        elif proc is not None:RESULT['cleanup']['unexpected_server_exit']=proc.returncode
        if DATA.exists():
            ctl=control('control-after');RESULT['cleanup']['control']=ctl
            RESULT['cleanup']['control_identity_equal']=ctl.get('Database system identifier')==control_id
            RESULT['cleanup']['control_shut_down']=ctl.get('Database cluster state')=='shut down'
            RESULT['cleanup']['postmaster_pid_absent']=not (DATA/'postmaster.pid').exists()
        if pid is not None:RESULT['cleanup']['original_pid_absent']=not psutil.pid_exists(pid)
        with socket.socket() as s:
            s.settimeout(4);code=s.connect_ex(('127.0.0.1',PORT));RESULT['cleanup']['port_connect_ex']=code;RESULT['cleanup']['port_refused']=code in (10061,111)
        RESULT['cleanup']['cluster_retained_for_evidence']=True
    except BaseException as e:
        RESULT['cleanup']['error']={'message':str(e),'traceback':traceback.format_exc()};RESULT['status']='CLEANUP_FAILED'
    if serverlog:serverlog.close()
    if proc is not None and not all(RESULT['cleanup'].get(k) for k in ['normal_pg_ctl_stop','control_identity_equal','control_shut_down','postmaster_pid_absent','original_pid_absent','port_refused','children_natural_exit','all_clients_closed','all_threads_joined']):RESULT['status']='CLEANUP_FAILED'
    try:
        source_after={path:{'sha256':sha((REPO/path).read_bytes()),'copy_sha256':sha((SRC/Path(path).name).read_bytes())} for path in paths}
        RESULT['source_unchanged']=bool(paths) and all(v['sha256']==pins[k]['worktree_sha256'] and v['copy_sha256']==pins[k]['sha256'] for k,v in source_after.items())
        RESULT['index_unchanged']=index_path is not None and sha(index_path.read_bytes())==index_before
        RESULT['head_unchanged']=subprocess.check_output([str(GIT),'-C',str(REPO),'rev-parse','HEAD'],env=env).decode().strip()==HEAD
        RESULT['binary_unchanged']=all(sha(Path(k).read_bytes())==v for k,v in pins.get('binaries',{}).items())
        write('source-after.json',source_after)
        if not all(RESULT[k] for k in ['source_unchanged','index_unchanged','head_unchanged','binary_unchanged']):RESULT['status']='SOURCE_DRIFT'
    except BaseException as e:
        RESULT['issues'].append({'source_finalization_error':repr(e)});RESULT['status']='SOURCE_DRIFT'
    RESULT['passed_count']=sum(t['passed'] for t in RESULT['tests']);RESULT['test_count']=len(RESULT['tests'])
    write('result.json',RESULT)
    files={str(p.relative_to(ROOT)).replace('\\','/'):{'sha256':sha(p.read_bytes()),'bytes':p.stat().st_size} for p in ROOT.rglob('*') if p.is_file() and not p.is_relative_to(DATA) and p.name!='artifact-hashes.json'}
    write('artifact-hashes.json',files)
    print(json.dumps({'status':RESULT['status'],'tests':RESULT['test_count'],'passed':RESULT['passed_count'],'cleanup':RESULT['cleanup']},ensure_ascii=False),flush=True)
sys.exit(0 if RESULT['status']=='PASS' else 1)
