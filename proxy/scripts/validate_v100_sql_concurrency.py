from __future__ import annotations

import json
import sys
import threading
import uuid
from pathlib import Path

import psycopg2

from validate_v100_sql_rollback import load_env_value, migration_body


def call_rpc(dsn: str, schema: str, event: dict, barrier: threading.Barrier, output: list, index: int) -> None:
    conn = psycopg2.connect(dsn)
    try:
        with conn.cursor() as cur:
            cur.execute("set lock_timeout = '10s'")
            barrier.wait()
            cur.execute(f'select "{schema}".apply_v100_rank_ledger_event(%s::jsonb, null::jsonb)', (json.dumps(event),))
            output[index] = cur.fetchone()[0]
        conn.commit()
    except Exception as exc:
        conn.rollback()
        output[index] = {"error": type(exc).__name__, "message": str(exc)}
    finally:
        conn.close()


def concurrent_pair(dsn: str, schema: str, left: dict, right: dict) -> list:
    barrier = threading.Barrier(2)
    output = [None, None]
    threads = [
        threading.Thread(target=call_rpc, args=(dsn, schema, left, barrier, output, 0)),
        threading.Thread(target=call_rpc, args=(dsn, schema, right, barrier, output, 1)),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(20)
    if any(thread.is_alive() for thread in threads):
        raise RuntimeError("concurrency test timed out")
    if any(isinstance(value, dict) and value.get("error") for value in output):
        raise RuntimeError(f"concurrency call failed: {output}")
    return output


def main() -> int:
    root = Path(__file__).resolve().parents[2]
    env_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(r"D:/AI Hermes/supabase-secret.env")
    dsn = load_env_value(env_path, "SUPABASE_DB_CONNECTION_STRING")
    schema = "v100tx_" + uuid.uuid4().hex[:12]
    original = migration_body(root / "frontend" / "supabase" / "schema_v100_rank_ledger.sql")
    isolated = original.replace("public.", f'"{schema}".').replace("pg_catalog, public, extensions", f'pg_catalog, "{schema}", extensions')
    admin = psycopg2.connect(dsn)
    evidence: dict[str, object] = {"schema": schema, "cleaned": False}
    try:
        with admin.cursor() as cur:
            cur.execute(f'create schema "{schema}"')
            cur.execute(isolated)
        admin.commit()

        base = {
            "source": "v100-concurrency-test",
            "table_id": "BAG01",
            "round_no": 1,
            "source_action": "/api/v1/gametype/*/game/*/room/*/table/*/summary",
            "raw_result_exact10": [1, 14, 2, 15, 27, 40, -1, -1, 4, 5],
        }
        same_event = {**base, "shoe_no": "SAME"}
        same_results = concurrent_pair(dsn, schema, same_event, same_event)
        assert sorted((bool(item["duplicate"]) for item in same_results)) == [False, True]
        assert all(item["accepted"] is True for item in same_results)

        first = {**base, "shoe_no": "CONFLICT"}
        second = {**first, "raw_result_exact10": [3, 16, 4, 17, -1, -1, -1, -1, 6, 8]}
        conflict_results = concurrent_pair(dsn, schema, first, second)
        assert sorted(item["status"] for item in conflict_results) == ["conflicted", "contiguous"]
        assert sorted(bool(item["accepted"]) for item in conflict_results) == [False, True]

        round1 = {**base, "shoe_no": "ORDER"}
        round2 = {**round1, "round_no": 2, "raw_result_exact10": [3, 16, 4, 17, -1, -1, -1, -1, 6, 8]}
        order_results = concurrent_pair(dsn, schema, round1, round2)
        with admin.cursor() as cur:
            cur.execute(f'select "{schema}".apply_v100_rank_ledger_event(%s::jsonb, null::jsonb)', (json.dumps(round2),))
            replay = cur.fetchone()[0]
        admin.commit()
        assert replay["accepted"] is True and replay["complete_through_round"] == 2

        evidence.update({
            "sameHash": [{"accepted": item["accepted"], "duplicate": item["duplicate"]} for item in same_results],
            "differentHash": [{"accepted": item["accepted"], "status": item["status"]} for item in conflict_results],
            "outOfOrderInitial": [{"accepted": item["accepted"], "status": item["status"]} for item in order_results],
            "gapReplayAccepted": replay["accepted"],
            "gapReplayCompleteThrough": replay["complete_through_round"],
        })
    finally:
        admin.rollback()
        admin.autocommit = True
        with admin.cursor() as cur:
            cur.execute(f'drop schema if exists "{schema}" cascade')
            cur.execute("select to_regnamespace(%s)", (schema,))
            evidence["cleaned"] = cur.fetchone()[0] is None
        admin.close()
    if evidence["cleaned"] is not True:
        raise RuntimeError("temporary concurrency schema cleanup failed")
    print(json.dumps(evidence, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
