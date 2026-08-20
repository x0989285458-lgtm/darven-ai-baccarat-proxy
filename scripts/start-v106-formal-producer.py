import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile

EXPECTED_RELEASE = 'v106.0.0-formal.19'
EXPECTED_PACKAGE = '1.0.76'
EXPECTED_IMAGE = 'darven-worker:v106-formal3-33f9dc6'
EXPECTED_COMMIT = os.environ.get('V106_RELEASE_COMMIT', '')

release = os.environ.get('V106_RELEASE_VERSION', '')
package = os.environ.get('V106_PACKAGE_VERSION', '')
if not re.fullmatch(r'[a-f0-9]{40}', EXPECTED_COMMIT) or release != EXPECTED_RELEASE or package != EXPECTED_PACKAGE:
    raise SystemExit('bound Formal.19 identity environment is missing')

subst = r'C:\Windows\System32\subst.exe'
maps = [('Q:', r'D:\AI Hermes\hermes\cache\tooling\gcloud-portable'), ('R:', r'C:\Users\童威仁')]
for drive, _ in maps:
    subprocess.run([subst, drive, '/d'], capture_output=True)
for drive, target in maps:
    result = subprocess.run([subst, drive, target], capture_output=True, text=True, errors='replace')
    if result.returncode:
        raise SystemExit(result.stderr or result.stdout)

source_config = pathlib.Path(r'C:\Users\童威仁\AppData\Roaming\gcloud')
temp_config = pathlib.Path(tempfile.mkdtemp(prefix='formal19-gcloud-'))
try:
    shutil.copytree(source_config, temp_config, dirs_exist_ok=True)
    env = os.environ.copy()
    env['CLOUDSDK_CONFIG'] = str(temp_config)
    env['CLOUDSDK_PYTHON'] = r'R:\AppData\Local\hermes\hermes-agent\venv\Scripts\python.exe'
    gcloud = r'Q:\google-cloud-sdk\bin\gcloud.cmd'
    remote = (
        "set -e; "
        "test \"$(systemctl is-active darven-worker.service || true)\" != active; "
        "sudo env TARGET_IMAGE='" + EXPECTED_IMAGE + "' python3 -c \"from pathlib import Path; import os; p=Path('/etc/darven-worker/release.env'); lines=p.read_text().splitlines(); key='WORKER_IMAGE='; out=[key+os.environ['TARGET_IMAGE'] if x.startswith(key) else x for x in lines]; out.append(key+os.environ['TARGET_IMAGE']) if not any(x.startswith(key) for x in lines) else None; t=p.with_suffix('.env.formal19.tmp'); t.write_text('\\n'.join(out)+'\\n'); t.chmod(0o600); t.replace(p)\"; "
        "sudo systemctl daemon-reload; sudo systemctl start darven-worker.service; "
        "ok=0; for i in $(seq 1 30); do if curl -fsS http://127.0.0.1:8790/health >/tmp/formal19-worker-health.json; then ok=1; break; fi; sleep 2; done; test $ok -eq 1; "
        "echo IDENTITY:$(sudo docker inspect darven-worker --format '{{.Config.Image}}|{{.Image}}|{{.State.Status}}'); "
        "cat /tmp/formal19-worker-health.json"
    )
    command = [gcloud, 'compute', 'ssh', 'darven-mt-taiwan-worker-5', '--project=project-fdf510b8-6df7-494d-a36', '--zone=asia-east1-b', '--tunnel-through-iap', '--command', remote, '--quiet']
    result = subprocess.run(command, env=env, capture_output=True, text=True, errors='replace', timeout=180)
    if result.returncode:
        raise SystemExit(result.stderr or result.stdout)
    lines = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    identity = next((line.removeprefix('IDENTITY:') for line in lines if line.startswith('IDENTITY:')), '')
    payload = next((json.loads(line) for line in reversed(lines) if line.startswith('{')), None)
    if not identity.startswith(EXPECTED_IMAGE + '|') or not identity.endswith('|running') or not payload:
        raise SystemExit('worker runtime identity or health payload missing')
    source = payload.get('captureSource') or payload.get('source') or {}
    checks = {
        'healthy': payload.get('healthy') is True,
        'connected': source.get('connected') is True,
        'authenticated': source.get('authenticated') is True,
        'joined': source.get('joined') is True,
        'tenTables': int(source.get('tableCount') or 0) == 10,
        'queueBounded': int((payload.get('queue') or {}).get('entries') or 0) <= 1,
        'exactImage': identity.startswith(EXPECTED_IMAGE + '|') and identity.endswith('|running'),
    }
    if not all(checks.values()):
        raise SystemExit(json.dumps({'workerStartBlocked': checks}, ensure_ascii=False))
    print(json.dumps({'ok': True, 'release': release, 'commit': EXPECTED_COMMIT, 'worker': checks}, ensure_ascii=False))
finally:
    shutil.rmtree(temp_config, ignore_errors=True)
    for drive, _ in maps:
        subprocess.run([subst, drive, '/d'], capture_output=True)
