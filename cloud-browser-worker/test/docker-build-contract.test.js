import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const dockerfileUrl = new URL('../Dockerfile', import.meta.url)
const runbookUrl = new URL('../deploy/vm/RUNBOOK.md', import.meta.url)
const serviceUrl = new URL('../deploy/vm/darven-worker.service', import.meta.url)
const continuityUrl = new URL('../deploy/vm/verify-state-continuity.py', import.meta.url)
const secretFetcherUrl = new URL('../deploy/vm/fetch-portal-credentials.py', import.meta.url)

const EXPECTED_EXEC_START = '/usr/bin/docker run --name darven-worker --network host --shm-size=1g --env-file /etc/darven-worker/worker.env -v /run/darven-worker-secrets:/run/secrets:ro -v /var/lib/darven-worker:/app/data --entrypoint /bin/sh ${WORKER_IMAGE} -c "Xvfb :99 -screen 0 1440x1000x24 -nolisten tcp >/tmp/xvfb.log 2>&1 & sleep 2; export DISPLAY=:99; exec npm start"'

function unitValues(source) {
  return Object.fromEntries(source.split(/\r?\n/).filter((line) => /^[A-Za-z][A-Za-z]+=/u.test(line)).map((line) => {
    const index = line.indexOf('=')
    return [line.slice(0, index), line.slice(index + 1)]
  }))
}

test('v104 worker image and systemd deployment fail closed and preserve durable queue state', async () => {
  const [dockerfile, runbook, service, continuity, secretFetcher] = await Promise.all([
    readFile(dockerfileUrl, 'utf8'),
    readFile(runbookUrl, 'utf8'),
    readFile(serviceUrl, 'utf8'),
    readFile(continuityUrl, 'utf8'),
    readFile(secretFetcherUrl, 'utf8'),
  ])
  const values = unitValues(service)

  assert.match(runbook, /docker build --pull[\s\S]*-f cloud-browser-worker\/Dockerfile \./)
  assert.match(runbook, /systemd-analyze verify[\s\S]*trap rollback ERR/)
  assert.match(runbook, /sudo sh -eu -c[\s\S]*connected[\s\S]*authenticated[\s\S]*== 10/)
  assert.match(runbook, /stat -c '%u:%g' \/etc\/darven-worker\/worker\.env[\s\S]*= 0:0/)
  assert.match(runbook, /install -o root -g root -m 600 \/dev\/stdin \/etc\/darven-worker\/release\.env/)
  assert.match(runbook, /verify-state-continuity\.py[\s\S]*capture[\s\S]*verify/)
  assert.match(dockerfile, /^RUN npm ci --omit=dev$/m)
  assert.doesNotMatch(dockerfile, /npm ci[^\n]*\|\||npm install --omit=dev/)
  assert.match(dockerfile, /COPY\s+cloud-browser-worker\/package\*\.json\s+\.\//)
  assert.match(dockerfile, /COPY\s+cloud-browser-worker\/src\s+\.\/src/)
  assert.match(dockerfile, /COPY\s+shared\s+\/shared/)
  assert.match(dockerfile, /org\.opencontainers\.image\.version="v104"/)

  assert.equal(values.Type, 'simple')
  assert.equal(values.EnvironmentFile, '/etc/darven-worker/release.env')
  assert.equal(values.RuntimeDirectory, 'darven-worker-secrets')
  assert.equal(values.RuntimeDirectoryMode, '0700')
  assert.match(service, /^ExecStartPre=-\/usr\/local\/sbin\/darven-fetch-portal-credentials$/m)
  assert.equal(values.ExecStartPre, '-/usr/bin/docker rm -f darven-worker')
  assert.equal(values.ExecStart, EXPECTED_EXEC_START)
  assert.equal(values.ExecStop, '/usr/bin/docker stop -t 30 darven-worker')
  assert.equal(values.ExecStopPost, '-/usr/bin/docker rm -f darven-worker')
  assert.equal(values.Restart, 'always')
  assert.equal(values.StartLimitIntervalSec, '60')
  assert.equal(values.StartLimitBurst, '3')
  assert.doesNotMatch(values.ExecStart, /(?:^|\s)-d(?:\s|$)|\/var\/lib\/darven-worker:\/app\/data:ro|\/bin\/false/)
  assert.match(values.ExecStart, /\/run\/darven-worker-secrets:\/run\/secrets:ro/)
  assert.match(secretFetcher, /metadata\.google\.internal/)
  assert.match(secretFetcher, /darven-portal-username/)
  assert.match(secretFetcher, /darven-portal-password/)
  assert.match(secretFetcher, /os\.chmod\(temporary, 0o400\)/)
  assert.match(secretFetcher, /print\("portal credentials prepared"\)/)

  assert.match(continuity, /lastSequence regressed/)
  assert.match(continuity, /acknowledged cursor regressed/)
  assert.match(continuity, /capped acknowledged cursor shrank/)
  assert.match(continuity, /previous_head_sequence in after_sequences/)
  assert.match(continuity, /unacknowledged queue head disappeared/)
})
