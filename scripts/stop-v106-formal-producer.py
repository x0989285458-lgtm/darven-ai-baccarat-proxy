import base64
import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile

EXPECTED_RELEASE = 'v106.0.0-formal.57'
EXPECTED_PACKAGE = '1.0.114'
EXPECTED_COMMIT = os.environ.get('V106_RELEASE_COMMIT', '')
EXPECTED_GENERATION = os.environ.get('V106_CUTOVER_GENERATION', '')

release = os.environ.get('V106_RELEASE_VERSION', '')
package = os.environ.get('V106_PACKAGE_VERSION', '')
if not re.fullmatch(r'[a-f0-9]{40}', EXPECTED_COMMIT) or not re.fullmatch(r'[0-9a-f-]{36}', EXPECTED_GENERATION) or release != EXPECTED_RELEASE or package != EXPECTED_PACKAGE:
    raise SystemExit('bound Formal.21 stop identity environment is missing')

subst = r'C:\Windows\System32\subst.exe'
maps = [('Q:', r'D:\AI Hermes\hermes\cache\tooling\gcloud-portable'), ('R:', r'C:\Users\童威仁')]
for drive, _ in maps:
    subprocess.run([subst, drive, '/d'], capture_output=True)
for drive, target in maps:
    result = subprocess.run([subst, drive, target], capture_output=True, text=True, errors='replace')
    if result.returncode:
        raise SystemExit(result.stderr or result.stdout)

source_config = pathlib.Path(r'C:\Users\童威仁\AppData\Roaming\gcloud')
temp_config = pathlib.Path(tempfile.mkdtemp(prefix='formal21-stop-gcloud-'))
try:
    shutil.copytree(source_config, temp_config, dirs_exist_ok=True)
    env = os.environ.copy()
    env['CLOUDSDK_CONFIG'] = str(temp_config)
    env['CLOUDSDK_PYTHON'] = r'R:\AppData\Local\hermes\hermes-agent\venv\Scripts\python.exe'
    gcloud = r'Q:\google-cloud-sdk\bin\gcloud.cmd'
    remote_script = """set -euo pipefail
systemctl stop darven-worker.service || true
systemctl reset-failed darven-worker.service >/dev/null 2>&1 || true
active=$(systemctl is-active darven-worker.service || true)
sub=$(systemctl show darven-worker.service -p SubState --value)
running=$(docker inspect darven-worker --format '{{.State.Running}}' 2>/dev/null || echo false)
echo "STOP_IDENTITY:${active}|${sub}|${running}"
"""
    encoded = base64.b64encode(remote_script.encode('utf-8')).decode('ascii')
    remote = f'echo {encoded} | base64 -d | sudo bash'
    command = [gcloud, 'compute', 'ssh', 'darven-mt-taiwan-worker-5', '--project=project-fdf510b8-6df7-494d-a36', '--zone=asia-east1-b', '--tunnel-through-iap', '--command', remote, '--quiet']
    result = subprocess.run(command, env=env, capture_output=True, text=True, errors='replace', timeout=180)
    if result.returncode:
        raise SystemExit(result.stderr or result.stdout)
    lines = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    identity = next((line.removeprefix('STOP_IDENTITY:') for line in lines if line.startswith('STOP_IDENTITY:')), '')
    parts = identity.split('|')
    if len(parts) != 3 or parts[0] != 'inactive' or parts[2].lower() == 'true':
        raise SystemExit(json.dumps({'producerStopBlocked': {'identity': identity}}, ensure_ascii=False))
    print(json.dumps({'ok': True, 'stopped': True, 'activeState': parts[0], 'subState': parts[1], 'containerRunning': False, 'release': release, 'commit': EXPECTED_COMMIT, 'generation': EXPECTED_GENERATION}, ensure_ascii=False))
finally:
    shutil.rmtree(temp_config, ignore_errors=True)
    for drive, _ in maps:
        subprocess.run([subst, drive, '/d'], capture_output=True)
