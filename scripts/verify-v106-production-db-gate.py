import json
import os
import pathlib
import re
import urllib.error
import urllib.parse
import urllib.request

EXPECTED_PROJECT_REF = 'gscfexhsqxvtpyxudtza'
EXPECTED_RELEASE = 'v106.0.0-formal.44'
EXPECTED_PACKAGE = '1.0.101'
EXPECTED_MIGRATIONS = [
    '20260820030000', '20260820040000', '20260820050000',
    '20260820060000', '20260821010000', '20260821020000',
    '20260821030000',
]
EXPECTED_WRITER_ACL = {
    'issueV105': False,
    'issueV106': True,
    'settleV105': True,
    'settleV106': True,
    'rawDirect': False,
    'rawFenced': True,
}


def read_env_file(path):
    values = {}
    for raw in pathlib.Path(path).read_text(encoding='utf-8-sig').splitlines():
        line = raw.strip()
        if line and not line.startswith('#') and '=' in line:
            key, value = line.split('=', 1)
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def main():
    phase = os.environ.get('V106_DB_GATE_PHASE', 'pre')
    if phase not in ('pre', 'post'):
        raise SystemExit('production DB gate phase mismatch')
    if os.environ.get('V106_RELEASE_VERSION') != EXPECTED_RELEASE or os.environ.get('V106_PACKAGE_VERSION') != EXPECTED_PACKAGE:
        raise SystemExit('production DB gate release identity mismatch')

    env = read_env_file(r'D:/AI Hermes/local-capture-secret.env')
    base_url = env.get('SUPABASE_URL', '').rstrip('/')
    service_key = env.get('SUPABASE_SERVICE_ROLE_KEY', '')
    parsed = urllib.parse.urlparse(base_url)
    if parsed.scheme != 'https' or parsed.hostname != f'{EXPECTED_PROJECT_REF}.supabase.co' or parsed.path not in ('', '/'):
        raise SystemExit('production DB gate Supabase project mismatch')
    if not service_key or any(char.isspace() for char in service_key):
        raise SystemExit('production DB gate service credential missing')

    body = json.dumps({
        'p_phase': phase,
        'p_release_version': EXPECTED_RELEASE,
        'p_package_version': EXPECTED_PACKAGE,
    }, separators=(',', ':')).encode('utf-8')
    request = urllib.request.Request(
        f'{base_url}/rest/v1/rpc/verify_v106_production_cutover_gate',
        data=body,
        method='POST',
        headers={
            'apikey': service_key,
            'Authorization': f'Bearer {service_key}',
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        },
    )
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=25) as response:
            if response.status != 200:
                raise SystemExit('production DB gate RPC status mismatch')
            payload = json.loads(response.read(65537).decode('utf-8'))
    except urllib.error.HTTPError as error:
        raise SystemExit(f'production DB gate RPC rejected ({error.code})') from None
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        raise SystemExit('production DB gate RPC unavailable') from None

    if not isinstance(payload, dict) or payload.get('ok') is not True:
        raise SystemExit('production DB gate proof missing')
    if payload.get('phase') != phase or payload.get('projectRef') != EXPECTED_PROJECT_REF or payload.get('release') != EXPECTED_RELEASE:
        raise SystemExit('production DB gate proof identity mismatch')
    if not re.fullmatch(r'[0-9a-f-]{36}', payload.get('generation') or ''):
        raise SystemExit('production DB gate generation missing')
    if payload.get('migrations') != EXPECTED_MIGRATIONS or payload.get('writerAcl') != EXPECTED_WRITER_ACL:
        raise SystemExit('production DB gate provenance mismatch')
    if payload.get('issuanceAdmission') != {'v105': False, 'v106': True}:
        raise SystemExit('production DB gate issuance admission mismatch')
    active_outbox = payload.get('activeOutbox')
    if not isinstance(active_outbox, dict) or any(type(active_outbox.get(key)) is not int for key in ('pending', 'processing', 'error', 'dead_letter')):
        raise SystemExit('production DB gate Outbox proof malformed')

    print(json.dumps(payload, ensure_ascii=False, separators=(',', ':')))


if __name__ == '__main__':
    main()
