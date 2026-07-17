#!/usr/bin/env python3
"""Capture/verify durable worker queue continuity without printing payload or secrets."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

QUEUE_NAME = "latest-snapshot.json"
CURSOR_NAME = f"{QUEUE_NAME}.cursor.json"


def read_json(path: Path):
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def queue_entries(value) -> list[dict]:
    if value is None:
        return []
    entries = value.get("entries") if isinstance(value, dict) else None
    if not isinstance(entries, list):
        entries = [value] if isinstance(value, dict) else []
    return [item for item in entries if isinstance(item, dict)]


def snapshot(state_dir: Path) -> dict:
    queue = queue_entries(read_json(state_dir / QUEUE_NAME))
    cursor = read_json(state_dir / CURSOR_NAME) or {}
    corrupt = sorted(path.name for path in state_dir.glob("*.corrupt*"))
    head = queue[0] if queue else {}
    return {
        "last_sequence": int(cursor.get("lastSequence") or 0),
        "observed_round_keys": sorted(str(value) for value in (cursor.get("observedRoundKeys") or [])),
        "acknowledged_round_keys": sorted(str(value) for value in (cursor.get("acknowledgedRoundKeys") or [])),
        "queue_sequences": [int(item.get("sequence") or 0) for item in queue],
        "head_round_keys": sorted(str(value) for value in (head.get("roundKeys") or [])),
        "corrupt_files": corrupt,
    }


def verify(before: dict, after: dict) -> None:
    if after["last_sequence"] < before["last_sequence"]:
        raise RuntimeError("worker cursor lastSequence regressed")
    if not set(before["acknowledged_round_keys"]).issubset(after["acknowledged_round_keys"]):
        raise RuntimeError("worker acknowledged cursor regressed")
    new_corrupt = set(after["corrupt_files"]) - set(before["corrupt_files"])
    if new_corrupt:
        raise RuntimeError("worker created corrupt durable state")
    previous_head = set(before["head_round_keys"])
    after_sequences = set(after["queue_sequences"])
    prior_sequences = set(before["queue_sequences"])
    head_still_queued = bool(prior_sequences & after_sequences)
    head_acknowledged = previous_head.issubset(after["acknowledged_round_keys"])
    if previous_head and not head_still_queued and not head_acknowledged:
        raise RuntimeError("unacknowledged queue head disappeared across restart")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("capture", "verify"))
    parser.add_argument("--state-dir", default="/var/lib/darven-worker")
    parser.add_argument("--evidence", required=True)
    args = parser.parse_args()
    state_dir = Path(args.state_dir)
    evidence = Path(args.evidence)
    current = snapshot(state_dir)
    if args.mode == "capture":
        evidence.write_text(json.dumps(current, sort_keys=True), encoding="utf-8")
        print("worker durable state captured")
        return 0
    before = json.loads(evidence.read_text(encoding="utf-8"))
    verify(before, current)
    print("worker durable state continuity: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
