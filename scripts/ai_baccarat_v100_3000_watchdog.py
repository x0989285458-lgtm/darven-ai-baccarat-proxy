#!/usr/bin/env python
"""Silent watchdog: notify once when formal v100 reaches 3,000 settled main predictions."""
from __future__ import annotations

import json
import os
import tempfile
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

THRESHOLD = 3000
STRATEGY_VERSION = "v100"
ENV_PATH = Path(os.environ.get("AI_BACCARAT_SUPABASE_ENV", r"D:\AI Hermes\supabase-secret.env"))
STATE_PATH = Path(os.environ.get(
    "AI_BACCARAT_V100_WATCHDOG_STATE",
    r"D:\AI Hermes\hermes\scripts\state\ai_baccarat_v100_3000_watchdog.json",
))


def load_env(path: Path = ENV_PATH) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key.startswith("export "):
            key = key.removeprefix("export ").strip()
        values[key] = value.strip().strip('"').strip("'")
    if "SUPABASE_PROJECT_REF" not in values and values.get("SUPABASE_DB_CONNECTION_STRING"):
        parsed = urllib.parse.urlparse(values["SUPABASE_DB_CONNECTION_STRING"])
        username = urllib.parse.unquote(parsed.username or "")
        if username.startswith("postgres."):
            values["SUPABASE_PROJECT_REF"] = username.split(".", 1)[1]
        elif (parsed.hostname or "").startswith("db."):
            values["SUPABASE_PROJECT_REF"] = (parsed.hostname or "").split(".", 2)[1]
    return values


def load_state(path: Path = STATE_PATH) -> dict:
    if not path.exists():
        return {"strategy_version": STRATEGY_VERSION, "notified": False, "last_count": 0, "consecutive_errors": 0}
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        state = {}
    if state.get("strategy_version") != STRATEGY_VERSION:
        return {"strategy_version": STRATEGY_VERSION, "notified": False, "last_count": 0, "consecutive_errors": 0}
    return state


def save_state(state: dict, path: Path = STATE_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False, dir=path.parent, suffix=".tmp") as handle:
        json.dump(state, handle, ensure_ascii=False, indent=2)
        temp_name = handle.name
    os.replace(temp_name, path)


def fetch_count(env: dict[str, str]) -> int:
    project = env["SUPABASE_PROJECT_REF"]
    key = env["SUPABASE_SERVICE_ROLE_KEY"]
    params = {
        "select": "id",
        "strategy_version": f"eq.{STRATEGY_VERSION}",
        "settlement_final": "eq.true",
        "predicted_result": "in.(banker,player)",
        "actual_result": "in.(banker,player)",
        "limit": "1",
    }
    url = f"https://{project}.supabase.co/rest/v1/daily_prediction_results?{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(
        url,
        headers={"apikey": key, "Authorization": f"Bearer {key}", "Prefer": "count=exact", "Range": "0-0"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        content_range = response.headers.get("Content-Range", "")
        response.read()
    if "/" not in content_range or content_range.rsplit("/", 1)[1] == "*":
        raise RuntimeError("Supabase did not return an exact count")
    return int(content_range.rsplit("/", 1)[1])


def main() -> int:
    state = load_state()
    if state.get("notified") is True:
        return 0
    try:
        count = fetch_count(load_env())
    except Exception as exc:
        state["consecutive_errors"] = int(state.get("consecutive_errors", 0)) + 1
        state["updated_at"] = datetime.now(timezone.utc).isoformat()
        save_state(state)
        if state["consecutive_errors"] >= 3:
            raise RuntimeError(f"v100 3000局監控連續失敗：{type(exc).__name__}") from exc
        return 0

    count = max(count, int(state.get("last_count", 0)))
    state.update({
        "strategy_version": STRATEGY_VERSION,
        "last_count": count,
        "consecutive_errors": 0,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    })
    if count >= THRESHOLD:
        state["notified"] = True
        state["notified_at"] = datetime.now(timezone.utc).isoformat()
        save_state(state)
        print(f"哥，v100主預測已達3,000局。目前正式DB已結算非和真牌主預測共 {count:,} 局。")
        return 0
    save_state(state)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
