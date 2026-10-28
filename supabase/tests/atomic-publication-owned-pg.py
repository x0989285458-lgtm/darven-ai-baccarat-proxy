"""Disposable loopback PG only. Never accepts a DSN or existing data root.
The fixture covers the publication dependencies, not full issuance/settlement.
"""
import datetime, hashlib, json, os, pathlib, socket, subprocess, sys, tempfile
ROOT = pathlib.Path(__file__).resolve().parents[2]
BIN = pathlib.Path('D:/AI Hermes/tools/postgresql-17.7/pgsql/bin')
P = pathlib.Path('C:/Users/童威仁/AppData/Local/hermes/cache/prediction-atomic-delivery-20261028')
mode = sys.argv[1]
assert mode in ('red', 'green')
root = pathlib.Path(tempfile.mkdtemp(prefix='hermes-verify-atomic-pg-'))
data = root / 'data'
with socket.socket() as s:
    s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]
env = {**os.environ, 'LC_ALL': 'C', 'LANG': 'C', 'PGHOST': '127.0.0.1', 'PGPORT': str(port), 'PGUSER': 'postgres', 'PGDATABASE': 'postgres', 'ATOMIC_OWNED_PG_DATA': str(data), 'ATOMIC_SCHEMA_ARTIFACT': str(P / 'atomic-schema-readonly.json')}
for k in ('PGSERVICE','PGSERVICEFILE','DATABASE_URL','PGPASSWORD','PGOPTIONS'):
    env.pop(k, None)
report = {'mode': mode, 'root': str(root), 'port': port, 'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'commands': [], 'fixtureScope': 'minimal publication dependencies; exact archived issue RPC, not full production issue/settlement'}
def run(args, timeout=40):
    # Windows server children can inherit pipe handles; regular files avoid communicate() hanging.
    out = root / f'command-{len(report["commands"])}.out'
    err = root / f'command-{len(report["commands"])}.err'
    with out.open('wb') as o, err.open('wb') as e:
        r = subprocess.run([str(a) for a in args], env=env, stdout=o, stderr=e, timeout=timeout)
    r.stdout = out.read_text(encoding='utf-8', errors='replace')
    r.stderr = err.read_text(encoding='utf-8', errors='replace')
    report['commands'].append({'argv': [str(a) for a in args], 'exit': r.returncode, 'stdout': r.stdout, 'stderr': r.stderr})
    return r
code = 1
try:
    assert run([BIN/'initdb.exe', '-D', data, '-U', 'postgres', '-A', 'trust', '--encoding=UTF8', '--no-locale']).returncode == 0
    assert run([BIN/'pg_ctl.exe', '-D', data, '-l', root/'server.log', '-o', f'-h 127.0.0.1 -p {port}', '-w', 'start']).returncode == 0
    r = run(['node', ROOT/'supabase/tests/atomic-publication-pg.cjs', mode], 120)
    code = r.returncode
    report['testExit'] = code
except Exception as e:
    report['error'] = repr(e)
finally:
    if (data/'postmaster.pid').exists():
        report['stopExit'] = run([BIN/'pg_ctl.exe', '-D', data, '-m', 'fast', '-w', 'stop']).returncode
    report['pidfileAbsent'] = not (data/'postmaster.pid').exists()
    with socket.socket() as s:
        s.settimeout(5); rc = s.connect_ex(('127.0.0.1', port))
    report['portConnectResult'] = rc
    report['portClosed'] = rc in (10061, 111, 61)
    report['control'] = run([BIN/'pg_controldata.exe', data]).stdout
    report['normalStop'] = report.get('stopExit') == 0 and report['pidfileAbsent'] and report['portClosed'] and 'shut down' in report['control']
    files = [pathlib.Path(__file__), ROOT/'supabase/tests/atomic-publication-pg.cjs', ROOT/'supabase/migrations/20261028090000_v105_table_publications.sql', ROOT/'supabase/operations/20261028090000_v105_table_publications_rollback.sql']
    report['sha256'] = {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in files if p.exists()}
    target = P / ('atomic-db-' + mode + '-' + root.name + '.json')
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'report': str(target), 'testExit': code, 'normalStop': report['normalStop'], 'root': str(root), 'port': port}))
    for c in report['commands']:
        if c['argv'][0] == 'node': print(c['stdout']); print(c['stderr'])
sys.exit(code if report['normalStop'] else 2)
