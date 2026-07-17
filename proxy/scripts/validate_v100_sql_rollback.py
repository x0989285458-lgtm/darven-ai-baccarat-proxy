from __future__ import annotations

import json
import os
import sys
import uuid
from pathlib import Path

import psycopg2


def load_env_value(path: Path, key: str) -> str:
    for raw in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip()
        if line and not line.startswith("#") and "=" in line:
            name, value = line.split("=", 1)
            if name.strip() == key:
                return value.strip().strip('"').strip("'")
    raise RuntimeError(f"missing {key}")


def migration_body(path: Path) -> str:
    sql = path.read_text(encoding="utf-8")
    lines = sql.splitlines()
    lines = [line for line in lines if line.strip().lower() not in {"begin;", "commit;"}]
    return "\n".join(lines)


def main() -> int:
    root = Path(__file__).resolve().parents[2]
    env_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(r"D:/AI Hermes/supabase-secret.env")
    schema_path = root / "frontend" / "supabase" / "schema_v100_rank_ledger.sql"
    dsn = load_env_value(env_path, "SUPABASE_DB_CONNECTION_STRING")
    identity = f"V100TX-{uuid.uuid4().hex[:12]}"
    conn = psycopg2.connect(dsn)
    conn.autocommit = False
    evidence: dict[str, object] = {"identity": identity, "rolledBack": False}
    try:
        with conn.cursor() as cur:
            cur.execute("select to_regclass('public.shoe_round_card_events'), to_regclass('public.shoe_rank_ledgers')")
            before = cur.fetchone()
            if any(before):
                raise RuntimeError("candidate v100 tables already exist; refusing destructive validation")
            cur.execute(migration_body(schema_path))

            event = {
                "source": "v100-transaction-test",
                "table_id": "BAG01",
                "shoe_no": identity,
                "round_no": 1,
                "source_action": "/api/v1/gametype/*/game/*/room/*/table/*/summary",
                "raw_result_exact10": [1, 14, 2, 15, 27, 40, -1, -1, 4, 5],
            }
            cur.execute("select public.apply_v100_rank_ledger_event(%s::jsonb, null::jsonb)", (json.dumps(event),))
            accepted = cur.fetchone()[0]
            assert accepted["accepted"] is True and accepted["complete_through_round"] == 1
            assert accepted["cards_seen_dealt"] == 6
            assert accepted["seen_dealt_rank_counts"]["A"] == 4
            assert accepted["seen_dealt_rank_counts"]["2"] == 2

            cur.execute("select public.apply_v100_rank_ledger_event(%s::jsonb, null::jsonb)", (json.dumps(event),))
            duplicate = cur.fetchone()[0]
            assert duplicate["accepted"] is True and duplicate["duplicate"] is True
            required_ack = {
                "status", "complete_through_round", "revision", "seen_dealt_rank_counts",
                "seen_dealt_code_counts", "undealt_after_observed_deals", "cards_seen_dealt",
                "ledger_checksum", "physical_remaining_exact", "burn_observation_status",
            }
            assert required_ack.issubset(duplicate)

            conflict_event = {**event, "raw_result_exact10": [3, 16, 4, 17, -1, -1, -1, -1, 6, 8]}
            cur.execute("select public.apply_v100_rank_ledger_event(%s::jsonb, null::jsonb)", (json.dumps(conflict_event),))
            conflict = cur.fetchone()[0]
            assert conflict["accepted"] is False and conflict["status"] == "conflicted"

            gap_event = {**event, "shoe_no": identity + "-GAP", "round_no": 2}
            cur.execute("select public.apply_v100_rank_ledger_event(%s::jsonb, null::jsonb)", (json.dumps(gap_event),))
            gap = cur.fetchone()[0]
            assert gap["accepted"] is False and gap["status"] == "gap" and gap["expected_round"] == 1
            cur.execute(
                "select dealt_rank_delta from public.shoe_round_card_events where source=%s and shoe_no=%s and round_no=2",
                (gap_event["source"], gap_event["shoe_no"]),
            )
            gap_delta = cur.fetchone()[0]
            assert gap_delta == {"A": 4, "2": 2}

            immutable_blocked = False
            try:
                cur.execute(
                    "update public.shoe_round_card_events set raw_result_exact10 = '[]'::jsonb where source=%s and shoe_no=%s",
                    (event["source"], identity),
                )
            except psycopg2.Error:
                immutable_blocked = True
                conn.rollback()
                # Re-run the migration transaction after rollback so final cleanup remains a rollback.
                cur.execute(migration_body(schema_path))
            assert immutable_blocked

            cur.execute("select has_table_privilege('anon','public.shoe_round_card_events','select'), has_table_privilege('authenticated','public.shoe_rank_ledgers','select'), has_table_privilege('service_role','public.shoe_round_card_events','insert')")
            anon_select, authenticated_select, service_insert = cur.fetchone()
            assert anon_select is False and authenticated_select is False and service_insert is False

            evidence.update({
                "migrationExecuted": True,
                "accepted": accepted["accepted"],
                "duplicate": duplicate["duplicate"],
                "conflictStatus": conflict["status"],
                "gapStatus": gap["status"],
                "immutableEvidenceBlocked": immutable_blocked,
                "anonymousReadBlocked": not anon_select,
                "authenticatedReadBlocked": not authenticated_select,
                "serviceRoleDirectInsertBlocked": not service_insert,
            })
    finally:
        conn.rollback()
        evidence["rolledBack"] = True
        conn.close()
    print(json.dumps(evidence, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
