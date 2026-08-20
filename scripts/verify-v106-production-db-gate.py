import json
import os
import pathlib
import re
from urllib.parse import urlparse

import psycopg

EXPECTED_PROJECT_REF = 'gscfexhsqxvtpyxudtza'
EXPECTED_RELEASE = 'v106.0.0-formal.21'
EXPECTED_PACKAGE = '1.0.78'

def read_env_file(path):
    values = {}
    for raw in pathlib.Path(path).read_text(encoding='utf-8-sig').splitlines():
        line = raw.strip()
        if line and not line.startswith('#') and '=' in line:
            key, value = line.split('=', 1)
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values

def scalar(cur, sql, params=()):
    cur.execute(sql, params)
    row = cur.fetchone()
    return row[0] if row else None

def main():
    phase = os.environ.get('V106_DB_GATE_PHASE', 'pre')
    if phase not in ('pre', 'post'):
        raise SystemExit('production DB gate phase mismatch')
    if os.environ.get('V106_RELEASE_VERSION') != EXPECTED_RELEASE or os.environ.get('V106_PACKAGE_VERSION') != EXPECTED_PACKAGE:
        raise SystemExit('production DB gate release identity mismatch')
    env = read_env_file(r'D:/AI Hermes/local-capture-secret.env')
    dsn = env.get('SUPABASE_DB_CONNECTION_STRING', '')
    parsed = urlparse(dsn)
    authority = f'{parsed.username or ""}@{parsed.hostname or ""}'
    if EXPECTED_PROJECT_REF not in authority:
        raise SystemExit('production DB gate Supabase project mismatch')
    with psycopg.connect(dsn, connect_timeout=15) as conn:
        conn.execute("set statement_timeout = '20s'")
        with conn.cursor() as cur:
            required_migrations = {
                '20260820030000', '20260820040000', '20260820050000', '20260820060000'
            }
            cur.execute("select version from supabase_migrations.schema_migrations where version = any(%s)", (list(required_migrations),))
            applied = {row[0] for row in cur.fetchall()}
            if applied != required_migrations:
                raise SystemExit('production DB gate migration provenance mismatch')
            cur.execute("select version,status,cutover_generation::text from public.ai_strategy_versions where status='active' order by version")
            active = cur.fetchall()
            if len(active) != 1 or active[0][0] != 'v106' or active[0][1] != 'active' or not re.fullmatch(r'[0-9a-f-]{36}', active[0][2] or ''):
                raise SystemExit('production DB gate active generation mismatch')
            generation = active[0][2]
            cur.execute("""
                select column_name,is_nullable
                from information_schema.columns
                where table_schema='public' and table_name='v106_rollback_terminalization_receipts'
                  and column_name in ('strategy_activated_at','cutover_generation','started_at','completed_at','consumed_at')
            """)
            receipt_columns = dict(cur.fetchall())
            if receipt_columns.get('strategy_activated_at') != 'NO' or receipt_columns.get('cutover_generation') != 'NO':
                raise SystemExit('production DB gate receipt provenance mismatch')
            inner_definition = scalar(cur, "select pg_get_functiondef('public.persist_v105_capture_envelope(jsonb)'::regprocedure)") or ''
            if "pg_advisory_xact_lock_shared" not in inner_definition or "v105_capture_source_fence:capture" not in inner_definition:
                raise SystemExit('production DB gate Raw barrier mismatch')
            privileges = {
                'issueV105': scalar(cur, "select has_function_privilege('service_role','public.issue_v105_prediction(jsonb)','EXECUTE')"),
                'issueV106': scalar(cur, "select has_function_privilege('service_role','public.issue_v106_prediction(jsonb)','EXECUTE')"),
                'settleV105': scalar(cur, "select has_function_privilege('service_role','public.settle_v105_prediction(jsonb,jsonb)','EXECUTE')"),
                'settleV106': scalar(cur, "select has_function_privilege('service_role','public.settle_v106_prediction(jsonb,jsonb)','EXECUTE')"),
                'rawDirect': scalar(cur, "select has_function_privilege('service_role','public.persist_v105_capture_envelope(jsonb)','EXECUTE')"),
                'rawFenced': scalar(cur, "select has_function_privilege('service_role','public.persist_v105_fenced_capture_envelope(jsonb)','EXECUTE')"),
            }
            if privileges != {'issueV105': False, 'issueV106': True, 'settleV105': True, 'settleV106': True, 'rawDirect': False, 'rawFenced': True}:
                raise SystemExit('production DB gate writer ACL mismatch')
            health = scalar(cur, 'select public.get_v105_capture_outbox_health()') or {}
            pending = int(health.get('pending', 0) or 0)
            processing = int(health.get('processing', 0) or 0)
            error = int(health.get('error', 0) or 0)
            if phase == 'pre' and (pending != 0 or processing != 0 or error != 0):
                raise SystemExit('production DB gate active Outbox is not drained')
            if phase == 'post' and (pending + processing > 1 or error != 0):
                raise SystemExit('production DB gate post-start Outbox is not bounded')
    print(json.dumps({'ok': True, 'phase': phase, 'projectRef': EXPECTED_PROJECT_REF, 'release': EXPECTED_RELEASE, 'generation': generation, 'migrations': sorted(applied), 'writerAcl': privileges, 'activeOutbox': {key: int(health.get(key, 0) or 0) for key in ('pending','processing','error','dead_letter')}}, ensure_ascii=False))

if __name__ == '__main__':
    main()
