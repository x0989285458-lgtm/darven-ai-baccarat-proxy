import base64
import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile

EXPECTED_RELEASE = 'v106.0.0-formal.63'
EXPECTED_PACKAGE = '1.0.120'
EXPECTED_IMAGE = 'darven-worker:v106-formal3-33f9dc6'
EXPECTED_IMAGE_ID = 'sha256:c52ed0039f1a45611f2d5dfb948450c204ee92c9226e1b7d6d6e2491bb92e7c2'
EXPECTED_COMMIT = os.environ.get('V106_RELEASE_COMMIT', '')
EXPECTED_GENERATION = os.environ.get('V106_CUTOVER_GENERATION', '')

release = os.environ.get('V106_RELEASE_VERSION', '')
package = os.environ.get('V106_PACKAGE_VERSION', '')
if not re.fullmatch(r'[a-f0-9]{40}', EXPECTED_COMMIT) or not re.fullmatch(r'[0-9a-f-]{36}', EXPECTED_GENERATION) or release != EXPECTED_RELEASE or package != EXPECTED_PACKAGE:
    raise SystemExit('bound Formal.21 identity environment is missing')

subst = r'C:\Windows\System32\subst.exe'
maps = [('Q:', r'D:\AI Hermes\hermes\cache\tooling\gcloud-portable'), ('R:', r'C:\Users\童威仁')]
for drive, _ in maps:
    subprocess.run([subst, drive, '/d'], capture_output=True)
for drive, target in maps:
    result = subprocess.run([subst, drive, target], capture_output=True, text=True, errors='replace')
    if result.returncode:
        raise SystemExit(result.stderr or result.stdout)

source_config = pathlib.Path(r'C:\Users\童威仁\AppData\Roaming\gcloud')
temp_config = pathlib.Path(tempfile.mkdtemp(prefix='formal20-gcloud-'))
try:
    shutil.copytree(source_config, temp_config, dirs_exist_ok=True)
    env = os.environ.copy()
    env['CLOUDSDK_CONFIG'] = str(temp_config)
    env['CLOUDSDK_PYTHON'] = r'R:\AppData\Local\hermes\hermes-agent\venv\Scripts\python.exe'
    gcloud = r'Q:\google-cloud-sdk\bin\gcloud.cmd'
    remote_script = f"""set -euo pipefail
test "$(systemctl is-active darven-worker.service || true)" != active
python3 - '{EXPECTED_IMAGE}' <<'PY'
from pathlib import Path
import sys
target = sys.argv[1]
release = Path('/etc/darven-worker/release.env')
lines = release.read_text().splitlines()
key = 'WORKER_IMAGE='
out = [key + target if line.startswith(key) else line for line in lines]
if not any(line.startswith(key) for line in lines):
    out.append(key + target)
tmp = release.with_suffix('.env.formal30.tmp')
tmp.write_text('\\n'.join(out) + '\\n')
tmp.chmod(0o600)
tmp.replace(release)
dropin = Path('/etc/systemd/system/darven-worker.service.d/30-v106-formal3-image.conf')
dropin.parent.mkdir(parents=True, exist_ok=True)
dropin.write_text('[Service]\\nEnvironment="WORKER_IMAGE=' + target + '"\\n')
dropin.chmod(0o644)
PY
systemctl daemon-reload
systemctl reset-failed darven-worker.service >/dev/null 2>&1 || true
systemctl start darven-worker.service
ok=0
for i in $(seq 1 60); do
  code=$(curl -sS -o /tmp/formal30-worker-health.json -w '%{{http_code}}' http://127.0.0.1:8787/health || true)
  if [ "$code" = 200 ] || [ "$code" = 503 ]; then ok=1; break; fi
  sleep 2
done
test "$ok" -eq 1
echo IDENTITY:$(docker inspect darven-worker --format '{{{{.Config.Image}}}}|{{{{.Image}}}}|{{{{.State.Status}}}}')
cat /tmp/formal30-worker-health.json
"""
    encoded = base64.b64encode(remote_script.encode('utf-8')).decode('ascii')
    remote = f'echo {encoded} | base64 -d | sudo bash'
    command = [gcloud, 'compute', 'ssh', 'darven-mt-taiwan-worker-5', '--project=project-fdf510b8-6df7-494d-a36', '--zone=asia-east1-b', '--tunnel-through-iap', '--command', remote, '--quiet']
    result = subprocess.run(command, env=env, capture_output=True, text=True, errors='replace', timeout=180)
    if result.returncode:
        raise SystemExit(result.stderr or result.stdout)
    lines = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    identity = next((line.removeprefix('IDENTITY:') for line in lines if line.startswith('IDENTITY:')), '')
    identity_parts = identity.split('|')
    payload = next((json.loads(line) for line in reversed(lines) if line.startswith('{')), None)
    if identity_parts != [EXPECTED_IMAGE, EXPECTED_IMAGE_ID, 'running'] or not payload:
        raise SystemExit('worker runtime identity or health payload missing')
    checks = {
        'endpointReachable': payload.get('ok') in (True, False),
        'exactImage': identity_parts == [EXPECTED_IMAGE, EXPECTED_IMAGE_ID, 'running'],
    }
    if not all(checks.values()):
        raise SystemExit(json.dumps({'workerStartBlocked': checks}, ensure_ascii=False))
    print(json.dumps({'ok': True, 'release': release, 'commit': EXPECTED_COMMIT, 'generation': EXPECTED_GENERATION, 'workerImageId': EXPECTED_IMAGE_ID, 'worker': checks}, ensure_ascii=False))
finally:
    shutil.rmtree(temp_config, ignore_errors=True)
    for drive, _ in maps:
        subprocess.run([subst, drive, '/d'], capture_output=True)
