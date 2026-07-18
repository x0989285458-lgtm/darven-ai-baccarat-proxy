import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const read = (path) => readFileSync(resolve(root, path), 'utf8')
const json = (path) => JSON.parse(read(path))
const manifest = json('release/v100-manifest.json')

assert.equal(manifest.release, 'v100.0.8')
assert.equal(manifest.packageVersion, '1.0.8')
assert.equal(manifest.status, 'formal')
assert.deepEqual(manifest.deployment, {
  frontend: 'cloudflare-pages', proxy: 'render', worker: 'gcp-taiwan-vm-systemd',
  workerQueue: '/var/lib/darven-worker:/app/data',
})
assert.deepEqual(manifest.components, {
  frontend: 'v100', proxy: 'v100', workerBuild: '100', workerProtocol: 'v100',
  strategy: 'v100', database: 'v100', monitoring: 'v100',
})
assert.equal(manifest.strategyComposition.main, '主預測靴內偏移去重版')
assert.equal(manifest.strategyComposition.side, '主副訊號去重與8副牌階完整性版')
assert.equal('historicalReadPredecessor' in manifest.strategyComposition, false)
assert.doesNotMatch(JSON.stringify(manifest), /候選|candidate|shadow|release[ _-]?candidate|\brc\b/i)

for (const path of ['frontend/package.json', 'proxy/package.json', 'cloud-browser-worker/package.json']) {
  assert.equal(json(path).version, '1.0.8', `${path} package version`)
}

assert.match(read('frontend/src/lib/buildVersion.ts'), /buildVersion:\s*'v100'[\s\S]*strategyVersion:\s*'v100'/)
assert.match(read('frontend/src/lib/liveClient.ts'), /import \{ frontendBuildMetadata \} from '\.\/buildVersion'[\s\S]*CURRENT_STRATEGY_VERSION\s*=\s*frontendBuildMetadata\.strategyVersion[\s\S]*CURRENT_BUILD_VERSION\s*=\s*frontendBuildMetadata\.buildVersion/)
assert.match(read('proxy/src/build-version.js'), /BUILD_VERSION\s*=\s*'v100'/)
assert.doesNotMatch(read('proxy/src/stable-report.js'), /legacy/i)
const supabaseWriter = read('proxy/src/supabase-writer.js')
assert.match(supabaseWriter, /ALL_MT_EQUAL_STRATEGY_VERSION\s*=\s*'v100'/)
assert.match(supabaseWriter, /V100_SIDE_DEDUP_VERSION\s*=\s*'v100_主副訊號去重與8副牌階完整性版'/)
assert.doesNotMatch(supabaseWriter, /COMPATIBLE_PREDECESSOR_STRATEGY_VERSION|shadow/i)
assert.match(supabaseWriter, /async getRecentPredictionRows[\s\S]*?strategy_version:\s*`eq\.\$\{ALL_MT_EQUAL_STRATEGY_VERSION\}`/)
assert.match(supabaseWriter, /async getTableUiSettledPredictions[\s\S]*?strategy_version:\s*`eq\.\$\{ALL_MT_EQUAL_STRATEGY_VERSION\}`/)
assert.doesNotMatch(supabaseWriter, /strategy_version:\s*`in\.\(\$\{ALL_MT_EQUAL_STRATEGY_VERSION\}/)
assert.match(read('proxy/src/server.js'), /WORKER_PROTOCOL_BUILD_VERSION\s*=\s*'100'[\s\S]*WORKER_PROTOCOL_VERSION\s*=\s*'v100'/)
assert.match(read('proxy/src/cloud-capture.js'), /buildVersion\s*!==\s*'100'/)
assert.match(read('cloud-browser-worker/src/runtime-config.js'), /BUILD_VERSION\s*=\s*'100'/)
assert.doesNotMatch(read('cloud-browser-worker/src/snapshot-pusher.js'), /protocolVersion:\s*'v098'/)
assert.match(read('cloud-browser-worker/src/snapshot-pusher.js'), /protocolVersion:\s*'v100'/)
const dockerfile = read('cloud-browser-worker/Dockerfile')
assert.match(dockerfile, /org\.opencontainers\.image\.version="v100"/)
assert.match(dockerfile, /^RUN npm ci --omit=dev$/m)
assert.doesNotMatch(dockerfile, /npm ci[^\n]*\|\||npm install --omit=dev/)
assert.equal(existsSync(resolve(root, 'cloud-browser-worker/render.yaml')), false, 'Render worker blueprint must stay retired')
assert.equal(existsSync(resolve(root, 'cloud-browser-worker/deploy/vm/docker-compose.yml')), false, 'Compose worker path must stay retired')
assert.equal(existsSync(resolve(root, 'cloud-browser-worker/deploy/vm/darven-cloud-browser-worker.service')), false, 'legacy service must stay retired')
const unit = read('cloud-browser-worker/deploy/vm/darven-worker.service')
const unitValues = Object.fromEntries(unit.split(/\r?\n/).filter((line) => /^[A-Za-z][A-Za-z]+=/u.test(line)).map((line) => {
  const index = line.indexOf('=')
  return [line.slice(0, index), line.slice(index + 1)]
}))
assert.equal(unitValues.Type, 'simple')
assert.equal(unitValues.EnvironmentFile, '/etc/darven-worker/release.env')
assert.equal(unitValues.ExecStartPre, '-/usr/bin/docker rm -f darven-worker')
assert.equal(unitValues.ExecStart, '/usr/bin/docker run --name darven-worker --network host --shm-size=1g --env-file /etc/darven-worker/worker.env -v /var/lib/darven-worker:/app/data --entrypoint /bin/sh ${WORKER_IMAGE} -c "Xvfb :99 -screen 0 1440x1000x24 -nolisten tcp >/tmp/xvfb.log 2>&1 & sleep 2; export DISPLAY=:99; exec npm start"')
assert.equal(unitValues.ExecStop, '/usr/bin/docker stop -t 30 darven-worker')
assert.equal(unitValues.ExecStopPost, '-/usr/bin/docker rm -f darven-worker')
assert.equal(unitValues.Restart, 'always')
assert.equal(unitValues.RestartSec, '5')
assert.equal(unitValues.StartLimitIntervalSec, '60')
assert.equal(unitValues.StartLimitBurst, '3')
assert.doesNotMatch(unitValues.ExecStart, /(?:^|\s)-d(?:\s|$)|:ro(?:\s|$)|\/bin\/false/)
assert.match(read('cloud-browser-worker/deploy/vm/release.env.example'), /^WORKER_IMAGE=darven-worker:v100-REVIEWED_SHA$/m)
assert.match(read('cloud-browser-worker/README.md'), /正式抓牌Worker部署於GCP台灣VM[\s\S]*\/var\/lib\/darven-worker:\/app\/data[\s\S]*未ACK Queue仍存在/)
assert.doesNotMatch(read('cloud-browser-worker/README.md'), /Render 建立方式|darven-cloud-browser-worker\.onrender\.com/)
const runbook = read('cloud-browser-worker/deploy/vm/RUNBOOK.md')
assert.match(runbook, /# v100 GCP VM部署[\s\S]*systemd-analyze verify[\s\S]*PREVIOUS_IMAGE_ID[\s\S]*trap rollback ERR/)
assert.match(runbook, /sudo sh -eu -c[\s\S]*connected[\s\S]*authenticated[\s\S]*len\(x\.get\("tables"\) or \[\]\) == 10/)
assert.match(runbook, /stat -c '%u:%g' \/etc\/darven-worker\/worker\.env[\s\S]*= 0:0[\s\S]*install -o root -g root -m 600 \/dev\/stdin \/etc\/darven-worker\/release\.env/)
assert.match(runbook, /verify-state-continuity\.py[\s\S]*capture[\s\S]*verify/)
assert.doesNotMatch(runbook, /buildVersion!=='098'|buildVersion` 仍為 `098`/)
const continuity = read('cloud-browser-worker/deploy/vm/verify-state-continuity.py')
assert.match(continuity, /MAX_CURSOR_ENTRIES\s*=\s*10000[\s\S]*acknowledged cursor regressed[\s\S]*capped acknowledged cursor shrank[\s\S]*previous_head_sequence[\s\S]*previous_head_sequence in after_sequences[\s\S]*unacknowledged queue head disappeared/)
assert.doesNotMatch(read('cloud-browser-worker/package.json'), /worker for Render|CLOUD_BROWSER_URL/i)
assert.match(read('proxy/deploy/render.yaml'), /V100_RELEASE_ENABLED[\s\S]*value:\s*"true"/)
assert.match(read('proxy/src/v100-formal-runtime.js'), /V100_RELEASE_ENABLED/)
assert.doesNotMatch(read('proxy/src/v100-formal-runtime.js'), /shadow/i)
const strictBacktest = read('proxy/scripts/v100-strict-backtest.mjs')
assert.doesNotMatch(strictBacktest, /shadow/i)
assert.match(strictBacktest, /calculateV100SidePrediction/)
assert.match(strictBacktest, /buildV100SideActions/)
assert.equal(existsSync(resolve(root, 'proxy/scripts/validate_v100_sql_rollback.py')), false)
assert.equal(existsSync(resolve(root, 'proxy/scripts/validate_v100_sql_concurrency.py')), false)
const deploymentDoc = read('proxy/deploy/DEPLOYMENT.md')
assert.match(deploymentDoc, /schema_v100_baseline\.sql[\s\S]*v100\.0\.8/)
assert.doesNotMatch(deploymentDoc, /schema_v0|rollback_v0|version:\s*0?4[12]/i)

for (const path of [
  'frontend/supabase/schema_v100_baseline.sql',
  'frontend/supabase/schema_v100_latest_only.sql',
  'frontend/supabase/rollback_v100_latest_only.sql',
]) assert.equal(existsSync(resolve(root, path)), true, `${path} exists`)

const baselineSql = read('frontend/supabase/schema_v100_baseline.sql')
const latestOnlySql = read('frontend/supabase/schema_v100_latest_only.sql')
const latestRollback = read('frontend/supabase/rollback_v100_latest_only.sql')
assert.match(baselineSql, /create table public\.shoe_round_card_events/i)
assert.match(baselineSql, /create table public\.shoe_rank_ledgers/i)
assert.match(baselineSql, /issue_v100_prediction[\s\S]*settle_v100_prediction[\s\S]*reconcile_v100_prediction_lifecycle/i)
assert.match(baselineSql, /v100[\s\S]*active/i)
assert.doesNotMatch(baselineSql, /v098|v097|v096|v094|v092|v091|v98|v99/i)
assert.doesNotMatch(baselineSql, /^\\/m)
assert.doesNotMatch(baselineSql, /ALTER DEFAULT PRIVILEGES[^;]*GRANT (?:ALL|EXECUTE) ON (?:FUNCTIONS|TABLES|SEQUENCES) TO (?:anon|authenticated);/i)
assert.doesNotMatch(read('proxy/test/formal-release.test.js'), /schema_v98|rollback_v98/)
assert.doesNotMatch(latestOnlySql, /drop function|drop table/i)
assert.match(latestRollback, /revoke execute on function public\.issue_v100_prediction/i)
assert.doesNotMatch(latestRollback, /drop\s+(?:table|function)|truncate|delete\s+from/i)
assert.equal(existsSync(resolve(root, 'scripts/ai_baccarat_v100_3000_watchdog.py')), false, '3000-round watchdog removed')

const captureWatchdog = read('scripts/ai_baccarat_data_watchdog.py')
assert.match(captureWatchdog, /GCP_WORKER\s*=\s*'darven-mt-taiwan-worker-5'/)
assert.match(captureWatchdog, /--tunnel-through-iap[\s\S]*systemctl restart darven-worker\.service/)
assert.match(captureWatchdog, /RECOVERY_COOLDOWN_SECONDS\s*=\s*3\s*\*\s*60/)
assert.doesNotMatch(captureWatchdog, /cloud-capture\/(?:tick|start)/)

console.log('v100 release consistency: PASS')
