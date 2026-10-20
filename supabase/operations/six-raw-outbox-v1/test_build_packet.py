"""Synthetic offline tests. NO PostgreSQL or network evidence."""
import ast
import copy
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.abc
import io
import json
import os
from pathlib import Path
import runpy
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

# Runner must scrub credentials; deny drivers/network/process creation even if added later.
DENIED={'socket','_socket','ssl','urllib','http','sqlite3','_sqlite3','psycopg','psycopg2','pg8000','sqlalchemy','asyncpg','subprocess'}
class OfflineImports(importlib.abc.MetaPathFinder):
    def find_spec(self,fullname,path=None,target=None):
        if fullname.split('.')[0] in DENIED:
            raise ImportError('OFFLINE_IMPORT_DENIED:'+fullname)
sys.meta_path.insert(0,OfflineImports())
def audit(event,args):
    if event.startswith(('socket.','subprocess.','sqlite3.')) or event in ('os.system','os.spawn','os.posix_spawn'):
        raise RuntimeError('OFFLINE_IO_DENIED:'+event)
sys.addaudithook(audit)
import build_packet as b

NOW=datetime.now(timezone.utc)
IDENTITY={'database':'SYNTHETIC_NOT_A_REAL_DB','database_oid':'100','system_identifier':'12345',
          'server_address':'192.0.2.1','server_port':5432,'role':'fixture_owner','role_oid':'10','server_version':'170000'}

def fixture():
    rows=[]
    for number,status in [(1,'pending'),(2,'completed'),(3,'dead_letter')]:
        value={k:None for k in b.COLUMNS}
        value.update(id=f'00000000-0000-4000-8000-{number:012d}',session_id='SYNTHETIC',sequence=number,
            round_keys=['BAG01:1:1'],status=status,attempts=0,lease_generation=0,payload_hash='a'*64,
            payload={'round_keys':['BAG01:1:1'],'rounds':[{'table_id':'BAG01','shoe_no':'1','round_no':1,'source':'ofalive99'}]},
            created_at=NOW.isoformat(),updated_at=NOW.isoformat())
        before=json.dumps(value,ensure_ascii=False,sort_keys=True)
        after=json.dumps(dict(value,status='dead_letter') if status=='pending' else value,ensure_ascii=False,sort_keys=True)
        rows.append({'id':value['id'],'before_text':before,'before_sha256':b.sha(before),'after_text':after,'after_sha256':b.sha(after)})
    catalog=json.dumps({'supported':True,'owner':'10','note':'SYNTHETIC_NOT_PG_NATIVE'})
    return {'version':b.VERSION,'scope':b.TABLE,'exported_at':NOW.isoformat(),'identity':copy.deepcopy(IDENTITY),
            'catalog_text':catalog,'catalog_sha256':b.sha(catalog),'non_target_sha256':b.sha('\n'.join(r['id']+':'+r['before_sha256'] for r in rows[1:])),'rows':rows}

def change_row(freeze,**changes):
    row=freeze['rows'][0]; before=json.loads(row['before_text']); before.update(changes)
    row['before_text']=json.dumps(before,ensure_ascii=False,sort_keys=True)
    row['after_text']=json.dumps(dict(before,status='dead_letter'),ensure_ascii=False,sort_keys=True)
    for side in ('before','after'): row[side+'_sha256']=b.sha(row[side+'_text'])

class ValidationTests(unittest.TestCase):
    def test_rejects_missing_freeze_contract(self):
        with self.assertRaises(ValueError): b.validate({}, {})

    def test_valid_synthetic_inventory(self):
        f=fixture(); self.assertEqual(b.validate(f,IDENTITY,NOW),[f['rows'][0]['id']])

    def test_freeze_negative_matrix(self):
        mutations={
          'scope':lambda f:f.update(scope='public.other'),
          'version':lambda f:f.update(version='v2'),
          'identity':lambda f:f['identity'].update(database='other'),
          'stale':lambda f:f.update(exported_at=(NOW-timedelta(seconds=901)).isoformat()),
          'future':lambda f:f.update(exported_at=(NOW+timedelta(seconds=1)).isoformat()),
          'timezone':lambda f:f.update(exported_at='2026-10-20T00:00:00'),
          'catalog_hash':lambda f:f.update(catalog_sha256='0'*64),
          'inventory_hash':lambda f:f.update(non_target_sha256='0'*64),
          'row_hash':lambda f:f['rows'][0].update(before_sha256='0'*64),
          'uuid':lambda f:f['rows'][0].update(id="x'; DROP TABLE foo;--"),
          'duplicate':lambda f:f['rows'].append(copy.deepcopy(f['rows'][0])),
          'empty':lambda f:f.update(rows=[]),
          'empty_targets':lambda f:f.update(rows=f['rows'][1:]),
          'extra_field':lambda f:f.update(unapproved=True),
          'postimage':lambda f:f['rows'][0].update(after_text='{}',after_sha256=b.sha('{}')),
        }
        for name,mutate in mutations.items():
            with self.subTest(name=name):
                f=fixture(); mutate(f)
                with self.assertRaises((ValueError,TypeError)): b.validate(f,IDENTITY,NOW)

    def test_row_negative_matrix(self):
        for changes in [dict(status='processing'),dict(status='error'),dict(status='unknown'),
            dict(claim_token='00000000-0000-4000-8000-000000000099'),dict(round_keys=[]),
            dict(round_keys=['BAV01:1:1']),dict(round_keys=['BAG99:1:1']),dict(round_keys=['BAG01:1:1','BAV01:1:1']),
            dict(round_keys=["BAG01:1:1';--"]),dict(session_id='changed',unexpected_column=True)]:
            with self.subTest(changes=changes):
                f=fixture(); change_row(f,**changes)
                with self.assertRaises((ValueError,TypeError)): b.validate(f,IDENTITY,NOW)

    def test_nested_mixed_payload(self):
        f=fixture(); payload=json.loads(f['rows'][0]['before_text'])['payload']; payload['snapshot']={'table_id':'BAV01'}
        change_row(f,payload=payload)
        with self.assertRaises(ValueError): b.validate(f,IDENTITY,NOW)

    def test_catalog_unsupported(self):
        for catalog in [{'supported':False,'owner':'10'},{'supported':True,'owner':'11'}]:
            f=fixture(); f['catalog_text']=json.dumps(catalog); f['catalog_sha256']=b.sha(f['catalog_text'])
            with self.assertRaises(ValueError): b.validate(f,IDENTITY,NOW)

    def test_strict_json(self):
        for text in ['{"a":1,"a":2}','{"a":NaN}']:
            with self.assertRaises(ValueError): b.loads(text)

class CompilerTests(unittest.TestCase):
    def test_full_packet_and_no_overwrite(self):
        root=os.environ.get('SIX_RAW_TEST_ROOT')
        self.assertTrue(root,'explicit evidence-owned test root required')
        with tempfile.TemporaryDirectory(dir=root,prefix='synthetic-') as tmp:
            p=Path(tmp); f=fixture(); freeze=p/'input.json'; identity=p/'identity.json'
            freeze.write_text(json.dumps(f),encoding='utf-8'); identity.write_text(json.dumps(IDENTITY),encoding='utf-8')
            result=b.build_packet(freeze,identity,p/'packet')
            self.assertEqual(result['terminal'],'ROLLBACK'); self.assertEqual(result['target_count'],1)
            for name,h in result['files'].items(): self.assertEqual(hashlib.sha256((p/'packet'/name).read_bytes()).hexdigest(),h)
            with self.assertRaises(FileExistsError): b.build_packet(freeze,identity,p/'packet')
            second=b.build_packet(freeze,identity,p/'second')
            self.assertEqual(result['operation_id'],second['operation_id'])
            # Exercise actual CLI dispatcher in-process: no child process allowed.
            previous=sys.argv
            try:
                sys.argv=['build_packet.py','--freeze',str(freeze),'--expected-identity',str(identity),'--output',str(p/'cli')]
                with redirect_stdout(io.StringIO()) as output: runpy.run_path(str(Path(b.__file__)),run_name='__main__')
                self.assertEqual(json.loads(output.getvalue())['operation_id'],result['operation_id'])
            finally: sys.argv=previous

    def test_sql_contract(self):
        f=fixture(); op='00000000-0000-4000-8000-000000000099'
        for reverse in (False,True):
            sql=b.render(f,'a'*64,op,reverse)
            self.assertTrue(sql.endswith('ROLLBACK;\n')); self.assertNotIn('COMMIT',sql)
            self.assertLess(sql.index('LOCK TABLE'),sql.index('DO $packet$'))
            self.assertLess(sql.index('EXACT_INVENTORY_PREIMAGE'),sql.index('UPDATE public.v105_capture_settlement_outbox'))
            for token in ['EXACT_POSTIMAGE','CATALOG_DRIFT','WRONG_DATABASE_IDENTITY','aclexplode','pg_inherits','pg_trigger','pg_rewrite','pg_policy','statement_timeout','lock_timeout']:
                self.assertIn(token,sql)
            self.assertNotIn('DELETE FROM',sql); self.assertNotIn('TRUNCATE',sql)
            self.assertNotIn('UPDATE public.v105_capture_ingest_sessions',sql)
            if reverse:
                self.assertIn('RECEIPT_PROOF',sql); self.assertIn('SET reversed=true',sql)
            else:
                self.assertIn('ENABLE ROW LEVEL SECURITY',sql)
                self.assertIn('FROM PUBLIC, anon, authenticated, service_role',sql)
                self.assertLess(sql.index('REVOKE ALL'),sql.index('INSERT INTO public.six_hold_'))
                self.assertLess(sql.index('INSERT INTO public.six_hold_'),sql.index('UPDATE public.v105_capture_settlement_outbox'))

    def test_admin_connection_identity_precedes_fixture_ddl(self):
        from types import SimpleNamespace
        source=Path(b.__file__).with_name('real_pg_regression.py').read_text(encoding='utf-8')
        tree=ast.parse(source)
        main=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='main')
        start=next(i for i,n in enumerate(main.body) if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='pid' for t in n.targets))
        end=next(i for i,n in enumerate(main.body[start:],start) if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='c' for t in n.targets))
        block=compile(ast.Module(body=main.body[start:end],type_ignores=[]),'actual-admin-admission','exec')
        root=os.environ['SIX_RAW_TEST_ROOT']
        with tempfile.TemporaryDirectory(dir=root,prefix='admission-') as tmp:
            data=Path(tmp); (data/'postmaster.pid').write_text('12345\n',encoding='utf-8')
            identity=('postgres','123456',str(data),'127.0.0.1',56444,'oner_owner')
            class Connection:
                def __init__(self,row): self.row=row; self.queries=[]
                def execute(self,sql): self.queries.append(sql); return self
                def fetchone(self): return self.row
                def close(self): pass
            for field in range(len(identity)):
                with self.subTest(wrong_identity_field=field):
                    wrong=list(identity); wrong[field]=0 if field==4 else 'WRONG'
                    conn=Connection(tuple(wrong))
                    ns={'DATA':data,'PORT':56444,'DB':'oner_synthetic_56444','BIN':data,'control_id':'123456','a':conn,
                        'proc':SimpleNamespace(pid=12345),'RESULT':{},'cmd':lambda *a:'fixture',
                        'write':lambda *a:None,'psutil':SimpleNamespace(Process=lambda _:SimpleNamespace(create_time=lambda:1))}
                    with self.assertRaisesRegex(AssertionError,'ADMIN_SERVER_IDENTITY'):
                        exec(block,ns)
                    self.assertFalse(any(q.startswith('CREATE DATABASE') for q in conn.queries))
            conn=Connection(identity); ns['a']=conn
            exec(block,ns)
            self.assertEqual([q for q in conn.queries if q.startswith('CREATE DATABASE')],['CREATE DATABASE oner_synthetic_56444'])

    def test_packet_locals_do_not_shadow_embedded_catalog_aliases(self):
        # PL/pgSQL lazily plans these queries; real_pg_regression.py also executes
        # the generated HOLD and reversal against PostgreSQL's default resolver.
        import re
        catalog=b.query('CATALOG')
        # Qualified n.nspname is unambiguous; only bare whole-row values collide.
        aliases=set(re.findall(r'\bto_jsonb\((\w+)\)',catalog,re.I))
        f=fixture(); op='00000000-0000-4000-8000-000000000099'
        for reverse in (False,True):
            sql=b.render(f,'a'*64,op,reverse)
            declarations=sql.split('DECLARE ',1)[1].split('\nBEGIN',1)[0]
            locals_=set(re.findall(r'(?:^|;)\s*(\w+)\s+(?:jsonb|bigint)\b',declarations))
            self.assertFalse(locals_ & aliases, f'PL/pgSQL/catalog collision: {locals_ & aliases}')
            self.assertNotIn('variable_conflict',sql)

    def test_only_hold_requires_original_freeze_freshness(self):
        f=fixture(); op='00000000-0000-4000-8000-000000000099'
        hold=b.render(f,'a'*64,op,False)
        reverse=b.render(f,'a'*64,op,True)
        self.assertIn("interval '15 minutes'",hold)
        self.assertIn('STALE_SNAPSHOT',hold)
        self.assertFalse("interval '15 minutes'" in reverse, 'reversal must use exact historical images, not original freeze age')
        self.assertNotIn('STALE_SNAPSHOT',reverse)
        for token in ('QUIESCENCE_DECLARATION_REQUIRED','WRONG_DATABASE_IDENTITY','CATALOG_DRIFT','EXACT_INVENTORY_PREIMAGE','EXACT_POSTIMAGE','RECEIPT_PROOF','ACTIVE_WORK'):
            self.assertIn(token,reverse)

    def test_injection_remains_data(self):
        f=fixture(); attack="'); END $packet$; DROP TABLE public.victim; --\\\n雪"
        change_row(f,last_error=attack)
        b.validate(f,IDENTITY,NOW)
        sql=b.render(f,'a'*64,'00000000-0000-4000-8000-000000000099')
        self.assertNotIn(attack,sql)
        encoded=b.canonical(f).encode('utf-8').hex(); self.assertIn(encoded,sql)
        self.assertEqual(json.loads(bytes.fromhex(encoded)),f)

    def test_no_driver_or_network_imports(self):
        tree=ast.parse(Path(b.__file__).read_text(encoding='utf-8'))
        for node in ast.walk(tree):
            if isinstance(node,ast.Import):
                for alias in node.names: self.assertNotIn(alias.name.split('.')[0],DENIED)
            if isinstance(node,ast.ImportFrom): self.assertNotIn(node.module.split('.')[0],DENIED)
        with self.assertRaises(ImportError): __import__('psycopg')
        with self.assertRaises(RuntimeError): sys.audit('socket.connect',None,None)

    def test_export_is_read_only(self):
        text=Path(b.__file__).with_name('export.sql').read_text(encoding='utf-8')
        self.assertIn('REPEATABLE READ READ ONLY',text); self.assertTrue(text.endswith('ROLLBACK;\n'))
        self.assertIn('non_target_sha256',text); self.assertIn('system_identifier',text)
        for keyword in ('INSERT INTO','UPDATE public.','DELETE FROM','COMMIT;'): self.assertNotIn(keyword,text)

if __name__=='__main__': unittest.main()
