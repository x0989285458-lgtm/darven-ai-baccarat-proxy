import json
import os
import re
import subprocess
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

BASE = 'https://darven-ai-baccarat-proxy.onrender.com'
STATUS_URL = BASE + '/api/status'
ENV_FILE = Path(r'D:/AI Hermes/local-capture-secret.env')
THRESHOLD_SECONDS = 3 * 60
MAX_FUTURE_SKEW_SECONDS = 5
EXPECTED_TABLE_COUNT = 10
STATE_PATH = Path(__file__).with_name('state') / 'ai_baccarat_data_watchdog.json'
GCLOUD = Path(os.environ.get('AI_BACCARAT_GCLOUD', r'C:\tmp\gcloud-sdk\google-cloud-sdk\bin\gcloud.cmd'))
GCLOUD_PYTHON = os.environ.get('AI_BACCARAT_GCLOUD_PYTHON', r'D:\AI Hermes\hermes\hermes-agent\venv\Scripts\python.exe')
GCP_PROJECT = 'project-fdf510b8-6df7-494d-a36'
GCP_ZONE = 'asia-east1-b'
GCP_WORKER = 'darven-mt-taiwan-worker-5'
RECOVERY_COOLDOWN_SECONDS = 3 * 60
RESTART_BUDGET_SECONDS = 30 * 60


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def load_env():
    for raw in ENV_FILE.read_text(encoding='utf-8').splitlines():
        if '=' in raw and not raw.lstrip().startswith('#'):
            key, value = raw.split('=', 1)
            os.environ.setdefault(key.strip(), value.strip())


def parse_dt(value):
    if not value:
        return None
    try:
        result = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        return (result if result.tzinfo else result.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)
    except (TypeError, ValueError):
        return None


def freshest_status_time(status):
    values = [parse_dt(status.get(key)) for key in ('lastTablesAt', 'lastMessageAt', 'lastRoundAt')]
    valid = [value for value in values if value is not None]
    return max(valid) if valid else None


def progress_status_time(status, table_count):
    if (
        status.get('connected') is True
        and status.get('authenticated') is True
        and table_count == EXPECTED_TABLE_COUNT
    ):
        return parse_dt(status.get('lastRoundAt')) or freshest_status_time(status)
    return freshest_status_time(status)


def load_state():
    try:
        return json.loads(STATE_PATH.read_text(encoding='utf-8'))
    except Exception:
        return {'alerting': False}


def save_state(value):
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE_PATH.with_suffix('.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    os.replace(tmp, STATE_PATH)


def same_origin(left, right):
    a = urlsplit(left)
    b = urlsplit(right)
    return (a.scheme.lower(), a.hostname, a.port) == (b.scheme.lower(), b.hostname, b.port)


def sanitize_error(value):
    text = str(value or '')
    text = re.sub(r'(?i)(token|secret|key|password)=([^&\s]+)', r'\1=[redacted]', text)
    return text[:500]


def restart_gcp_worker():
    if not GCLOUD.exists():
        raise RuntimeError('gcloud CLI is unavailable')
    environment = os.environ.copy()
    environment['CLOUDSDK_PYTHON'] = GCLOUD_PYTHON
    command = [
        str(GCLOUD), 'compute', 'ssh', GCP_WORKER,
        f'--project={GCP_PROJECT}', f'--zone={GCP_ZONE}', '--tunnel-through-iap',
        '--command=sudo systemctl restart darven-worker.service',
    ]
    completed = subprocess.run(
        command,
        capture_output=True,
        text=True,
        timeout=150,
        env=environment,
        shell=os.name == 'nt',
    )
    if completed.returncode != 0:
        detail = sanitize_error(completed.stderr or completed.stdout or f'exit {completed.returncode}')
        raise RuntimeError(f'GCP worker restart failed: {detail}')


def recovery_due(state, failure_kind=None, now=None):
    if state.get('alerting') and failure_kind and state.get('failure_kind') == failure_kind and state.get('last_recovery_attempt_at'):
        return False
    current = now or datetime.now(timezone.utc)
    previous_restart = parse_dt(state.get('last_worker_restart_at'))
    if previous_restart is not None and (current - previous_restart).total_seconds() < RESTART_BUDGET_SECONDS:
        return False
    previous = parse_dt(state.get('last_recovery_attempt_at'))
    return previous is None or (current - previous).total_seconds() >= RECOVERY_COOLDOWN_SECONDS


def fetch_json(url, method='GET', token=None, timeout=45):
    headers = {'Cache-Control': 'no-cache', 'User-Agent': 'darven-watchdog/2.0'}
    if token:
        if not same_origin(url, BASE):
            raise ValueError('refusing to send control token to a different origin')
        headers['x-control-token'] = token
    request = urllib.request.Request(url, data=b'{}' if method == 'POST' else None, method=method, headers=headers)
    opener = urllib.request.build_opener(NoRedirectHandler()) if token else urllib.request.build_opener()
    with opener.open(request, timeout=timeout) as response:
        return json.loads(response.read().decode('utf-8'))


def inspect():
    status = fetch_json(STATUS_URL)
    table_count_value = status.get('tableCount')
    table_count_valid = isinstance(table_count_value, int) and not isinstance(table_count_value, bool)
    table_count = table_count_value if table_count_valid else 0
    last = progress_status_time(status, table_count)
    raw_age = (datetime.now(timezone.utc) - last).total_seconds() if last else 10**9
    timestamp_healthy = -MAX_FUTURE_SKEW_SECONDS <= raw_age <= THRESHOLD_SECONDS
    age = max(0, raw_age) if timestamp_healthy else raw_age
    healthy = (
        status.get('connected') is True
        and status.get('authenticated') is True
        and table_count_valid
        and table_count == EXPECTED_TABLE_COUNT
        and timestamp_healthy
    )
    return status, table_count, age, healthy


def classify_failure(status, table_count, age):
    message = ' '.join(str(status.get(key) or '') for key in ('eventKind', 'eventMessage', 'errorMessage', 'reason')).lower()
    event_layer = str(status.get('eventLayer') or '').lower()
    event_kind = str(status.get('eventKind') or '').lower()
    if 'portal_auth_refresh_failed' in message:
        return 'authorization_refresh_failed'
    if status.get('persistenceStatus') == 'error' or status.get('persistenceError') or event_layer == 'write_error':
        return 'persistence_backpressure'
    if status.get('connected') is True and status.get('authenticated') is False and table_count == 0:
        return 'authorization_lost'
    if status.get('connected') is not True:
        formal_worker_transport = (
            event_layer == 'capture_error'
            and event_kind == 'worker_snapshot'
            and re.search(r'timeout|timed out|abort|socket|reset|network|fetch failed|econn(?:refused|reset)|unreachable', message)
        )
        if formal_worker_transport:
            return 'worker_transport_confirmed'
        return 'transport_unresolved'
    if status.get('authenticated') is not True:
        return 'authentication_unknown'
    if table_count != EXPECTED_TABLE_COUNT:
        return 'table_set_invalid'
    if age > THRESHOLD_SECONDS:
        return 'round_progress_stale'
    if age < -MAX_FUTURE_SKEW_SECONDS:
        return 'timestamp_invalid'
    return 'unknown'


def restart_allowed(failure_kind):
    return failure_kind == 'worker_transport_confirmed'


def last_status_text(status):
    value = freshest_status_time(status)
    return value.isoformat() if value else None


def main():
    state = load_state()
    inspection_failure_kind = None
    try:
        status, table_count, age, healthy = inspect()
    except Exception as error:
        status, table_count, age, healthy = {}, 0, 10**9, False
        first_error = f'{type(error).__name__}: {error}'
        inspection_failure_kind = 'proxy_unreachable'
    else:
        first_error = None

    failure_kind = None if healthy else (inspection_failure_kind or classify_failure(status, table_count, age))
    attempted = []
    recovery_attempt_at = None
    last_worker_restart_at = state.get('last_worker_restart_at')
    if not healthy and restart_allowed(failure_kind) and recovery_due(state, failure_kind):
        recovery_attempt_at = datetime.now(timezone.utc).isoformat()
        last_worker_restart_at = recovery_attempt_at
        try:
            restart_gcp_worker()
            attempted.append('gcp-worker-restart')
            time.sleep(20)
            status, table_count, age, healthy = inspect()
            failure_kind = None if healthy else classify_failure(status, table_count, age)
        except Exception as error:
            attempted.append('gcp-worker-restart:failed')
            first_error = first_error or f'{type(error).__name__}: {error}'
            healthy = False
            failure_kind = failure_kind or 'worker_transport_confirmed'
    elif not healthy and failure_kind in {'authorization_lost', 'authorization_refresh_failed'}:
        attempted.append('worker-session-refresh')
    elif not healthy:
        attempted.append('保留Worker，禁止未確認重啟')

    now = datetime.now(timezone.utc).isoformat()
    if healthy:
        if state.get('alerting'):
            print('✅ AI百家抓牌已自動恢復\n'
                  f'桌數：{table_count}\n'
                  f'最後資料：{last_status_text(status)}\n'
                  f'自動處理：{", ".join(attempted) or "不需要"}')
        healthy_state = {'alerting': False, 'last_ok_at': now}
        if last_worker_restart_at:
            healthy_state['last_worker_restart_at'] = last_worker_restart_at
        save_state(healthy_state)
        return

    if failure_kind == 'authorization_lost':
        error_text = 'MT授權失效，等待Worker自動取得新Session'
    elif failure_kind == 'authorization_refresh_failed':
        error_text = 'MT授權自動更新已失敗兩次，已停止重試並等待人工處理'
    elif failure_kind == 'persistence_backpressure':
        error_text = 'Proxy／Supabase持久化阻塞，Worker仍保留運行，禁止以重啟掩蓋積壓'
    elif failure_kind == 'round_progress_stale':
        error_text = '10桌仍連線但權威Final超過3分鐘未前進；來源與持久化尚未能可靠分流，禁止直接重啟Worker'
    elif failure_kind == 'proxy_unreachable':
        error_text = sanitize_error(first_error or 'Proxy無法連線，禁止誤判為Worker故障')
    else:
        error_text = sanitize_error(first_error or status.get('eventMessage') or status.get('errorMessage') or '上游Worker/Tunnel無回傳')
    if not state.get('alerting'):
        print('⚠️ AI百家抓牌中斷警報\n'
              f'類型：{failure_kind}\n'
              f'connected={status.get("connected")}, authenticated={status.get("authenticated")}, tables={table_count}\n'
              f'最後資料已逾期：{int(age)}秒\n'
              f'自動復原嘗試：{", ".join(attempted) or "無"}\n'
              f'錯誤：{error_text}')
    elif error_text and error_text != state.get('last_error'):
        print('⚠️ AI百家監控錯誤更新\n'
              f'桌數：{table_count}\n'
              f'自動復原嘗試：{", ".join(attempted) or "無"}\n'
              f'錯誤：{error_text}')
    next_state = {
        'alerting': True,
        'first_alerted_at': state.get('first_alerted_at') or state.get('alerted_at') or now,
        'last_checked_at': now,
        'age_seconds': int(age),
        'attempted': attempted,
        'failure_kind': failure_kind,
        'last_recovery_attempt_at': recovery_attempt_at or state.get('last_recovery_attempt_at'),
        'last_worker_restart_at': last_worker_restart_at,
    }
    if error_text:
        next_state['last_error'] = error_text
        next_state['last_error_at'] = now
    save_state(next_state)


if __name__ == '__main__':
    main()
