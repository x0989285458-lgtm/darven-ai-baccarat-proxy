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


def recovery_due(state, now=None):
    previous = parse_dt(state.get('last_recovery_attempt_at'))
    current = now or datetime.now(timezone.utc)
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
    last = freshest_status_time(status)
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


def last_status_text(status):
    value = freshest_status_time(status)
    return value.isoformat() if value else None


def main():
    state = load_state()
    try:
        status, table_count, age, healthy = inspect()
    except Exception as error:
        status, table_count, age, healthy = {}, 0, 10**9, False
        first_error = f'{type(error).__name__}: {error}'
    else:
        first_error = None

    attempted = []
    recovery_attempt_at = None
    if not healthy and recovery_due(state):
        recovery_attempt_at = datetime.now(timezone.utc).isoformat()
        try:
            restart_gcp_worker()
            attempted.append('gcp-worker-restart')
            time.sleep(20)
            status, table_count, age, healthy = inspect()
        except Exception as error:
            attempted.append('gcp-worker-restart:failed')
            first_error = first_error or f'{type(error).__name__}: {error}'
            healthy = False

    now = datetime.now(timezone.utc).isoformat()
    if healthy:
        if state.get('alerting'):
            print('✅ AI百家抓牌已自動恢復\n'
                  f'桌數：{table_count}\n'
                  f'最後資料：{last_status_text(status)}\n'
                  f'自動處理：{", ".join(attempted) or "不需要"}')
        save_state({'alerting': False, 'last_ok_at': now})
        return

    error_text = sanitize_error(first_error or status.get('eventMessage') or status.get('errorMessage') or '上游Worker/Tunnel無回傳')
    if not state.get('alerting'):
        print('⚠️ AI百家抓牌中斷警報\n'
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
        'last_recovery_attempt_at': recovery_attempt_at or state.get('last_recovery_attempt_at'),
    }
    if error_text:
        next_state['last_error'] = error_text
        next_state['last_error_at'] = now
    save_state(next_state)


if __name__ == '__main__':
    main()
