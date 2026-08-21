from pathlib import Path
import argparse
import json
import threading
import time
import uuid

import psycopg

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ENV = Path(r'D:/AI Hermes/local-capture-secret.env')


def read_env_file(path):
    values = {}
    for raw in Path(path).read_text(encoding='utf-8-sig').splitlines():
        line = raw.strip()
        if line and not line.startswith('#') and '=' in line:
            key, value = line.split('=', 1)
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def sql_body(path):
    lines = path.read_text(encoding='utf-8-sig').strip().splitlines()
    if lines and lines[0].strip().lower() == 'begin;':
        lines = lines[1:]
    if lines and lines[-1].strip().lower() == 'commit;':
        lines = lines[:-1]
    return '\n'.join(lines)


def schema_sql(path, schema):
    return sql_body(path).replace('public.', f'{schema}.').replace('set search_path = public', f'set search_path = {schema}')


def payload(shoe):
    return {
        'source': 'formal27_probe', 'table_id': 'BAG01', 'shoe_no': shoe,
        'round_no': 1, 'strategy_version': 'v106', 'predicted_result': 'banker', 'confidence': 55,
        'issued_prediction_payload': {
            'targetTableId': 'BAG01', 'targetShoe': shoe, 'targetRound': 1,
            'strategyVersion': 'v106', 'predictionTiming': 'pre_result_context',
            'predictedResult': 'banker', 'confidence': 55,
        },
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--env-file', default=str(DEFAULT_ENV))
    args = parser.parse_args()
    dsn = read_env_file(args.env_file)['SUPABASE_DB_CONNECTION_STRING']
    schema = 'formal27_probe_' + uuid.uuid4().hex[:12]
    formal25 = schema_sql(ROOT / 'supabase/migrations/20260821020000_v106_formal25_issuance_barrier.sql', schema)
    formal26 = schema_sql(ROOT / 'supabase/migrations/20260821030000_v106_formal26_successor_issuance_barrier.sql', schema)
    errors = []
    evidence = {}
    connected = threading.Event()
    admin = psycopg.connect(dsn, autocommit=True, application_name='formal27_barrier_admin')

    def issue_worker():
        try:
            with psycopg.connect(dsn, application_name='formal27_admitted_issue') as connection:
                with connection.cursor() as cursor:
                    cursor.execute('select pg_backend_pid()')
                    evidence['issue_pid'] = cursor.fetchone()[0]
                    connected.set()
                    cursor.execute(f'select {schema}.issue_v106_prediction(%s::jsonb)', (json.dumps(payload('probe-' + uuid.uuid4().hex)),))
                    evidence['issued'] = cursor.fetchone()[0]
                connection.commit()
        except Exception as error:
            errors.append(('issue', type(error).__name__, str(error).splitlines()[0]))

    def fence_worker():
        started = time.monotonic()
        try:
            with psycopg.connect(dsn, application_name='formal27_rollback_fence') as connection:
                connection.execute(f"update {schema}.ai_strategy_versions set issuance_enabled=false where version='v106'")
                connection.commit()
            evidence['fence_elapsed'] = time.monotonic() - started
        except Exception as error:
            errors.append(('fence', type(error).__name__, str(error).splitlines()[0]))

    try:
        admin.execute(f'create schema {schema}')
        admin.execute(f'create table {schema}.ai_strategy_versions as select * from public.ai_strategy_versions where false')
        admin.execute(f'create table {schema}.daily_prediction_results (like public.daily_prediction_results including defaults including generated including identity)')
        admin.execute(f'create unique index result_identity_uq on {schema}.daily_prediction_results(source,table_id,shoe_no,round_no,strategy_version)')
        admin.execute(f"insert into {schema}.ai_strategy_versions(version,status) values('v105','archived'),('v106','active')")
        admin.execute(formal25, prepare=False)
        admin.execute(formal26, prepare=False)
        admin.execute(f"create function {schema}.delay_issuance_insert() returns trigger language plpgsql as $$ begin perform pg_sleep(2); return new; end $$")
        admin.execute(f'create trigger delay_issuance_insert before insert on {schema}.daily_prediction_results for each row execute function {schema}.delay_issuance_insert()')

        issue_thread = threading.Thread(target=issue_worker)
        issue_thread.start()
        assert connected.wait(5), 'issuance connection did not become ready'
        deadline = time.monotonic() + 8
        reached_insert = False
        while time.monotonic() < deadline:
            activity = admin.execute(
                'select wait_event from pg_stat_activity where pid=%s and state=\'active\'',
                (evidence['issue_pid'],),
            ).fetchone()
            if activity and activity[0] == 'PgSleep':
                reached_insert = True
                break
            time.sleep(0.05)
        assert reached_insert, f'actual issue_v106_prediction did not reach delayed insert: {errors}'

        fence_thread = threading.Thread(target=fence_worker)
        fence_thread.start()
        time.sleep(0.35)
        assert fence_thread.is_alive(), 'rollback fence did not wait for actual admitted issue_v106_prediction'
        issue_thread.join(10)
        fence_thread.join(10)
        assert not issue_thread.is_alive() and not fence_thread.is_alive(), 'race threads did not settle'
        assert not errors, errors
        assert evidence['fence_elapsed'] >= 1.0, evidence
        assert admin.execute(f"select issuance_enabled from {schema}.ai_strategy_versions where version='v106'").fetchone() == (False,)
        assert admin.execute(f"select count(*) from {schema}.daily_prediction_results where strategy_version='v106'").fetchone() == (1,)

        rejected = False
        try:
            with psycopg.connect(dsn) as connection:
                connection.execute(f'select {schema}.issue_v106_prediction(%s::jsonb)', (json.dumps(payload('blocked-' + uuid.uuid4().hex)),))
        except psycopg.Error as error:
            rejected = 'admission is disabled' in str(error)
        assert rejected, 'post-fence actual issue_v106_prediction was not rejected'

        admin.execute(formal25, prepare=False)
        assert admin.execute(f"select issuance_enabled from {schema}.ai_strategy_versions where version='v106'").fetchone() == (False,), 'migration rerun rewrote successor admission'

        admin.execute(f"update {schema}.ai_strategy_versions set issuance_enabled=true where version='v106'")
        with psycopg.connect(dsn) as connection:
            connection.execute(f"update {schema}.ai_strategy_versions set issuance_enabled=false where version='v106'")
            connection.rollback()
        assert admin.execute(f"select issuance_enabled from {schema}.ai_strategy_versions where version='v106'").fetchone() == (True,), 'rolled-back fence changed admission'

        print('FORMAL27_DB_RACE_PASS actual_issue=1 fence_waited=1 post_fence_rejected=1 migration_rerun_preserved=1 rollback_restored=1')
    finally:
        admin.execute(f'drop schema if exists {schema} cascade')
        assert admin.execute('select to_regnamespace(%s)', (schema,)).fetchone() == (None,)
        admin.close()
        print('FORMAL27_PROBE_SCHEMA_CLEANED=1')


if __name__ == '__main__':
    main()
