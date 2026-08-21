import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const repo = new URL('../../', import.meta.url)
const read = (path) => readFileSync(new URL(path, repo), 'utf8')
const json = (path) => JSON.parse(read(path))
const extractSqlFunction = (sql, name) => {
  const normalized = sql.replace(/\r\n/g, '\n')
  const match = normalized.match(new RegExp(`create or replace function public\\.${name}\\(p_prediction jsonb\\)\\n[\\s\\S]*?\\n\\$\\$;`, 'i'))
  assert.ok(match, `${name} function is missing`)
  return match[0]
}

test('Formal.25 v105 issuance fence is a row-lock concurrency barrier while late settlement remains authorized', () => {
  const migration = read('supabase/migrations/20260821020000_v106_formal25_issuance_barrier.sql')
  const fence = read('supabase/operations/fence_v105_new_issuance.sql')
  const activate = read('supabase/operations/activate_v106_promotion.sql')
  const rollback = read('supabase/operations/rollback_v106_to_v105.sql')
  const finalize = read('supabase/operations/finalize_v106_promotion.sql')
  assert.match(migration, /add column if not exists issuance_enabled boolean/)
  assert.match(migration, /version = 'v105'[\s\S]*issuance_enabled is true[\s\S]*for share/i)
  assert.match(fence, /update public\.ai_strategy_versions[\s\S]*issuance_enabled = false[\s\S]*version = 'v105'/i)
  assert.ok(fence.indexOf('issuance_enabled = false') < fence.indexOf('revoke execute'))
  assert.match(activate, /version = 'v106'[\s\S]*issuance_enabled = true/i)
  assert.match(rollback, /version = 'v105'[\s\S]*issuance_enabled = true/i)
  assert.match(finalize, /grant execute on function public\.settle_v105_prediction/)
  assert.doesNotMatch(finalize, /revoke execute on function public\.settle_v105_prediction/)
})

test('Formal.26 v106 rollback fence waits for every admitted successor issuance and migrations are rerun-safe', () => {
  const predecessorBarrier = read('supabase/migrations/20260821020000_v106_formal25_issuance_barrier.sql')
  const successorBarrier = read('supabase/migrations/20260821030000_v106_formal26_successor_issuance_barrier.sql')
  const terminalize = read('supabase/operations/terminalize_v106_rollback.sql')
  const successorIssue = extractSqlFunction(successorBarrier, 'issue_v106_prediction')
  assert.match(predecessorBarrier, /where issuance_enabled is null/i)
  assert.doesNotMatch(predecessorBarrier, /where issuance_enabled is null or version in/i)
  assert.match(successorIssue, /version = 'v106'[\s\S]*status = 'active'[\s\S]*issuance_enabled is true[\s\S]*for share/i)
  assert.match(terminalize, /update public\.ai_strategy_versions[\s\S]*issuance_enabled = false[\s\S]*version = 'v106'/i)
  assert.ok(terminalize.indexOf('issuance_enabled = false') < terminalize.indexOf('revoke execute on function public.issue_v106_prediction'))
})

test('Formal.27 exact release binds the real PostgreSQL successor issuance race probe', () => {
  const manifest = json('release/v106-formal-v10-main-release-manifest.json')
  const report = json('release/v106-formal-v10-main-report.json')
  const probePath = 'scripts/verify-v106-issuance-barrier-db.py'
  const probe = read(probePath)
  assert.equal(manifest.verificationArtifacts.successorIssuanceBarrierDbProbe.path, probePath)
  assert.ok(manifest.releaseBinding.implementationTree.paths.includes(probePath))
  assert.ok(manifest.releaseBinding.databaseCutoverInput.paths.includes(probePath))
  assert.match(probe, /psycopg\.connect[\s\S]*threading\.Thread[\s\S]*issue_v106_prediction\(%s::jsonb\)/i)
  assert.match(probe, /fence_thread\.is_alive[\s\S]*post-fence actual issue_v106_prediction was not rejected/i)
  assert.match(probe, /drop schema if exists[\s\S]*to_regnamespace/i)
  assert.match(report.verified.formal27BoundDbProbe, /actual issue_v106_prediction=1[\s\S]*probe schema cleaned=1/i)
  assert.doesNotMatch(report.pending.join('\n'), /two-connection rehearsal|PostgreSQL.*pending/i)
})

test('Formal.24 isolated runtime DB gate is service-role-only and proves exact cutover provenance', () => {
  const sql = read('supabase/migrations/20260821010000_v106_formal24_isolated_runtime_gate.sql')
  assert.match(sql, /create or replace function public\.verify_v106_production_cutover_gate/)
  assert.match(sql, /security definer[\s\S]*set search_path = pg_catalog, public/i)
  assert.match(sql, /request\.jwt\.claims[\s\S]*service_role/)
  assert.match(sql, /20260821010000[\s\S]*20260821030000/)
  assert.match(sql, /has_function_privilege[\s\S]*issue_v105_prediction[\s\S]*issue_v106_prediction/)
  assert.match(sql, /get_v105_capture_outbox_health/)
  assert.match(sql, /revoke all on function public\.verify_v106_production_cutover_gate\(text, text, text\) from public, anon, authenticated/i)
  assert.match(sql, /grant execute on function public\.verify_v106_production_cutover_gate\(text, text, text\) to service_role/i)
})

test('v106 release identity is coherent while the updated capture worker retains protocol v105', () => {
  assert.equal(json('proxy/package.json').version, '1.0.97')
  assert.equal(json('frontend/package.json').version, '1.0.63')
  assert.equal(json('cloud-browser-worker/package.json').version, '1.0.63')
  assert.match(read('proxy/src/build-version.js'), /BUILD_VERSION = 'v106'/)
  assert.match(read('proxy/src/supabase-writer.js'), /ALL_MT_EQUAL_STRATEGY_VERSION = 'v105'[\s\S]*FORMAL_STRATEGY_VERSION = 'v106'/)
  assert.match(read('proxy/src/server.js'), /import \{[^}]*FORMAL_STRATEGY_VERSION[^}]*\} from '\.\/supabase-writer\.js'/)
  assert.match(read('proxy/src/server.js'), /FORMAL_STRATEGY_VERSION === 'v106'[\s\S]*createV106FormalRuntime/)
  assert.match(read('frontend/src/lib/buildVersion.ts'), /buildVersion: 'v106'[\s\S]*strategyVersion: 'v106'/)
  assert.match(read('cloud-browser-worker/src/runtime-config.js'), /BUILD_VERSION = '105'/)
  assert.match(read('cloud-browser-worker/Dockerfile'), /image\.version="v105"/)
  assert.match(read('scripts/run-worker-tests-scrubbed.mjs'), /cwd:\s*workerRoot/)
  assert.match(read('proxy/src/server.js'), /WORKER_PROTOCOL_BUILD_VERSION = '105'[\s\S]*WORKER_PROTOCOL_VERSION = 'v105'/)
})

test('v106 database migration is additive, active-fenced, immutable issuance and atomic Final settlement', () => {
  const sql = read('supabase/migrations/20260818010000_v106_formal_v10_main.sql')
  assert.match(sql, /issue_v106_prediction/i)
  assert.match(sql, /create or replace function public\.issue_v105_prediction[\s\S]*for\s+share/i)
  assert.match(sql, /create or replace function public\.issue_v106_prediction[\s\S]*for\s+share/i)
  assert.match(sql, /settle_v106_prediction/i)
  assert.match(sql, /reconcile_v106_prediction_lifecycle/i)
  assert.match(sql, /get_v106_prediction_lifecycle_stats/i)
  assert.match(sql, /reconcile_v106_prediction_lifecycle[\s\S]*coalesce\(issuance_status,\s*'pending'\)\s+not\s+in\s*\('expired_no_final',\s*'abandoned_shoe_change'\)/i)
  assert.match(sql, /strategy_version[^\n]*v106/i)
  assert.match(sql, /settlement_final[^\n]*false/i)
  assert.match(sql, /is_verified_final_round_action|source_action[^\n]*summary/i)
  assert.match(sql, /targetTableId[^;]+table_id/is)
  assert.match(sql, /targetShoe[^;]+shoe_no/is)
  assert.match(sql, /targetRound[^;]+round_no/is)
  assert.match(sql, /is_hit[^;]+existing\.predicted_result/is)
  assert.match(sql, /insert\s+into\s+public\.daily_roadmap_events/is)
  assert.match(sql, /conflicting existing roadmap settlement/i)
  assert.doesNotMatch(sql, /grant execute on function public\.issue_v105_prediction/i)
  assert.match(sql, /grant execute on function public\.settle_v105_prediction/i)
  assert.match(sql, /unique[^\n]*status[^\n]*active|exactly_one_active/i)
  assert.doesNotMatch(sql, /drop\s+(table|function)|truncate|delete\s+from\s+.*daily_prediction_results/i)
})

test('formal.8 database fence preserves the earliest authoritative Final receive time on every write path', () => {
  const sql = read('supabase/migrations/20260820003500_v106_formal8_final_time_fence.sql')
  assert.match(sql, /create or replace function public\.preserve_cloud_round_first_received_at\(\)/i)
  assert.match(sql, /new\.received_at\s*:=\s*least\(old\.received_at,\s*new\.received_at\)/i)
  assert.match(sql, /before update of received_at on public\.cloud_table_rounds/i)
  assert.match(sql, /for each row execute function public\.preserve_cloud_round_first_received_at\(\)/i)
  assert.doesNotMatch(sql, /grant execute/i)
})

test('v106 migration preserves the frozen v105 issuance contract and adds only the Active row lock fence', () => {
  const baseline = extractSqlFunction(read('frontend/supabase/schema_v105_formal.sql'), 'issue_v105_prediction')
  const hardened = extractSqlFunction(read('supabase/migrations/20260818010000_v106_formal_v10_main.sql'), 'issue_v105_prediction')
  const lockFence = /  perform 1\n  from public\.ai_strategy_versions\n  where version = 'v105' and status = 'active'\n  for share;\n  if not found then\n    raise exception 'v105 issuance is fenced because v105 is not Active';\n  end if;\n\n/
  assert.match(hardened, lockFence)
  assert.equal(hardened.replace(lockFence, ''), baseline)
})

test('v106 rollback restores v105 as sole Active and its writer grants without deleting evidence', () => {
  const sql = read('supabase/operations/rollback_v106_to_v105.sql')
  assert.match(sql, /ai_strategy_versions[\s\S]*for\s+update/i)
  const guard = sql.slice(0, sql.indexOf('revoke execute'))
  assert.match(guard, /strategy_version\s*=\s*'v106'[\s\S]*settlement_final\s+is\s+not\s+true/i)
  assert.doesNotMatch(guard, /issuance_status\s*=\s*'pending'/i)
  assert.match(guard, /issuance_status\s+is\s+distinct\s+from\s+'expired_no_final'/i)
  assert.doesNotMatch(guard, /abandoned_shoe_change/i)
  assert.match(sql, /version\s*=\s*'v105'|values\s*\(\s*'v105'/i)
  assert.match(sql, /status\s*=\s*'active'/i)
  assert.match(sql, /version\s*=\s*'v106'[\s\S]*status\s*=\s*'archived'/i)
  assert.match(sql, /grant execute on function public\.issue_v105_prediction/i)
  assert.match(sql, /grant execute on function public\.settle_v105_prediction/i)
  assert.match(sql, /grant execute on function public\.persist_v105_settled_round\(jsonb, jsonb\) to service_role/i)
  assert.match(sql, /revoke execute on function public\.issue_v106_prediction/i)
  assert.doesNotMatch(sql, /revoke execute on function public\.settle_v106_prediction/i)
  assert.doesNotMatch(sql, /revoke execute on function public\.reconcile_v106_prediction_lifecycle/i)
  assert.match(sql, /grant execute on function public\.settle_v106_prediction\(jsonb, jsonb\) to service_role/i)
  assert.match(sql, /grant execute on function public\.reconcile_v106_prediction_lifecycle\(text, text, text, integer\) to service_role/i)
  assert.match(sql, /grant execute on function public\.get_v106_prediction_lifecycle_stats\(\) to service_role/i)
  assert.doesNotMatch(sql, /delete|drop|truncate/i)
  assert.match(sql, /v105_shadow_v10_rank_sync_runtime_settings[\s\S]*status\s*=\s*'shadow'[\s\S]*enabled\s*=\s*true[\s\S]*active_strategy_version\s*=\s*'v105'/i)
})

test('v106 cutover fences new v105 issuance while preserving predecessor settlement drain', () => {
  const sql = read('supabase/operations/fence_v105_new_issuance.sql')
  assert.match(sql, /revoke execute on function public\.issue_v105_prediction/i)
  assert.doesNotMatch(sql, /revoke execute on function public\.settle_v105_prediction/i)
  assert.doesNotMatch(sql, /delete|drop|truncate/i)
})

test('v106 activation fences pending v105 and disables the actual promoted V10 runtime without deleting evidence', () => {
  const sql = read('supabase/operations/activate_v106_promotion.sql')
  assert.match(sql, /ai_strategy_versions[\s\S]*for\s+update/i)
  assert.match(sql, /grant execute on function public\.issue_v106_prediction\(jsonb\) to service_role/i)
  assert.match(sql, /grant execute on function public\.settle_v105_prediction\(jsonb, jsonb\) to service_role/i)
  assert.match(sql, /revoke execute on function public\.persist_v105_settled_round\(jsonb, jsonb\) from service_role/i)
  assert.match(sql, /count\(\*\)[^;]+status\s*=\s*'active'[^;]+version\s*=\s*'v105'/is)
  assert.match(sql, /coalesce\(issuance_status,\s*'pending'\)[^;]+not\s+in\s*\('expired_no_final',\s*'abandoned_shoe_change'\)/is)
  assert.match(sql, /strategy_version\s*=\s*'v105'[^;]+settlement_final\s+is\s+not\s+true/is)
  assert.match(sql, /v105_shadow_v10_rank_sync_runtime_settings/i)
  assert.match(sql, /enabled\s*=\s*false/i)
  assert.match(sql, /has_function_privilege\([\s\S]*settle_v105_prediction/i)
  assert.doesNotMatch(sql, /revoke execute on function public\.settle_v105_prediction/i)
  assert.match(sql, /version\s*=\s*'v106'[^;]+status\s*=\s*'active'|status\s*=\s*'active'[^;]+version\s*=\s*'v106'/is)
  assert.doesNotMatch(sql, /delete|drop|truncate/i)
})

test('v106 finalize fences predecessor issuance after live E2E while retaining immutable late settlement', () => {
  const sql = read('supabase/operations/finalize_v106_promotion.sql')
  const guard = sql
  assert.match(guard, /strategy_version\s*=\s*'v105'[\s\S]*prediction_issued_at\s+is\s+not\s+null[\s\S]*settlement_final\s+is\s+not\s+true/i)
  assert.doesNotMatch(guard, /issuance_status\s*=\s*'pending'/i)
  assert.match(guard, /expired_no_final[\s\S]*abandoned_shoe_change/i)
  assert.match(sql, /revoke execute on function public\.issue_v105_prediction/i)
  assert.doesNotMatch(sql, /revoke execute on function public\.settle_v105_prediction/i)
  assert.match(sql, /revoke execute on function public\.persist_v105_settled_round\(jsonb, jsonb\) from service_role/i)
  assert.doesNotMatch(sql, /revoke execute on function public\.reconcile_v105_prediction_lifecycle/i)
  assert.match(sql, /grant execute on function public\.settle_v105_prediction\(jsonb, jsonb\) to service_role/i)
  assert.doesNotMatch(sql, /grant execute on function public\.persist_v105_settled_round\(jsonb, jsonb\) to service_role/i)
  assert.doesNotMatch(sql, /delete|drop|truncate/i)
  assert.match(read('proxy/src/server.js'), /v105ShadowV10\s*=\s*FORMAL_STRATEGY_VERSION\s*===\s*'v106'[\s\S]*\?\s*null/)
})

test('v106 frontend version gate fails closed and formal writer/hydration use v106 paths', () => {
  assert.match(read('frontend/src/lib/liveClient.ts'), /v106/)
  assert.match(read('frontend/src/lib/liveClient.ts'), /version_mismatch|版本不符/)
  const writer = read('proxy/src/supabase-writer.js')
  assert.match(writer, /FORMAL_STRATEGY_VERSION = 'v106'/)
  assert.match(writer, /rpc\/issue_v106_prediction/)
  assert.match(writer, /rpc\/settle_v106_prediction/)
  assert.match(writer, /getV106FormalHistory/)
  assert.match(writer, /strategy_version:\s*'in\.\(v105,v106\)'/)
  assert.doesNotMatch(writer, /patchRest\('ai_strategy_versions'[\s\S]{0,500}postRest\('ai_strategy_versions'/)
})

test('v106 manifest encodes DB-first through finalize order and exact rollback', () => {
  const manifest = json('release/v106-formal-v10-main-release-manifest.json')
  assert.equal(manifest.applicationVersion, '1.0.97')
  assert.equal(manifest.strategyVersion, 'v106')
  assert.equal(manifest.mainStrategy.source, 'v105-shadow-v10-big-road-uncommon-structure-rank-synchronized')
  assert.equal(manifest.sideStrategy.source, 'v105')
  assert.equal(manifest.mainStrategy.activationGate, 'structureDiagnostics.eligible === true')
  assert.equal(manifest.mainStrategy.fallback, 'exact formal v105 main projection')
  assert.equal(manifest.gitTag, 'v106.0.0-formal.40')
  assert.deepEqual(manifest.deploymentOrder, ['database-additive', 'database-final-time-fence', 'database-bounded-raw-ack', 'database-monotonic-projection', 'database-rollback-receipt', 'database-single-use-rollback-receipt', 'database-cutover-generation', 'database-raw-ingest-barrier', 'database-isolated-runtime-gate', 'database-issuance-admission-barrier', 'deploy-worker-1.0.63-protocol-v105', 'verify-worker-v105-compatibility', 'fence-v105-new-issuance', 'producer-stop', 'terminalize-v105-cutover', 'drain-v105-and-queue', 'activate-v106', 'proxy', 'run-bound-production-cutover', 'frontend', 'live-e2e', 'finalize'])
  assert.equal(manifest.canonicalPublicProxyUrl, 'https://darven-ai-baccarat-proxy.onrender.com')
  assert.deepEqual(manifest.publicReadinessGate, {
    script: 'scripts/verify-v106-public-readiness.mjs',
    deploymentStep: 'run-bound-production-cutover',
    producerStartStep: 'run-bound-production-cutover',
    requiredConsecutive: 2,
    boundedAttempts: 30,
    requestTimeoutMs: 20000,
    intervalMs: 15000,
    requiredIdentity: {
      version: 'v106', buildVersion: 'v106', releaseVersion: 'v106.0.0-formal.40',
      packageVersion: '1.0.97', commit: 'annotated-tag-attested-commit',
    },
    failClosedExitCode: 2,
    phases: {
      preProducerIdentity: {
        accept: 'HTTP 200 healthy or HTTP 503 ok=false only when exact signed release/package/commit identity matches twice; health reason is intentionally irrelevant before producer bootstrap',
        purpose: 'prove the deployed immutable proxy before producer bootstrap',
      },
      postProducerService: {
        accept: 'HTTP 200 ok=true with the same exact identity twice',
        purpose: 'prove source plus proxy service health before post DB gate',
      },
    },
  })
  assert.equal(manifest.releaseScope.workerBehaviorChanged, true)
  assert.equal(manifest.releaseScope.workerProtocolChanged, false)
  assert.equal(manifest.inheritedProductionSafety.preserveQueue, true)
  assert.equal(manifest.inheritedProductionSafety.preserveAckCursor, true)
  assert.equal(manifest.inheritedProductionSafety.exactAckRequired, true)
  assert.equal(manifest.productionCutoverRunner.requiresPostStartFailStopCompensation, true)
  assert.equal(manifest.productionCutoverRunner.producerStopScript, 'scripts/stop-v106-formal-producer.py')
  assert.match(manifest.productionCutoverRunner.producerStopScriptGitBlobSha1, /^[a-f0-9]{40}$/)
  assert.equal(manifest.productionReplay.overlapRows, 36856)
  assert.equal(manifest.productionReplay.netHitDelta, 29)
  assert.equal(manifest.rollback.script, 'supabase/operations/rollback_v106_to_v105.sql')
  assert.equal(manifest.rollback.targetSoleActive, 'v105')
  assert.deepEqual(manifest.settlementCompatibility, {
    predecessorNewIssuanceFenced: true,
    predecessorImmutableSettlementRetainedAfterFinalize: true,
    successorImmutableSettlementRetainedAfterRollback: true,
    terminalEvidenceStatuses: ['expired_no_final', 'abandoned_shoe_change'],
    unknownOrPendingNonFinalBlocksCutover: true,
  })
  assert.deepEqual(manifest.rollback.order, ['stop producer admission', 'run bound v106 rollback terminalization and isolate active outbox evidence', 'run rollback SQL', 'deploy exact v105 proxy 6bdd39e8, current exact v105 frontend, and worker 6bdd39e8', 'verify sole Active v105 and new v105 Final'])
})

test('formal rollback terminalization fences v106, proves quiet, preserves evidence, and isolates active outbox', () => {
  const sql = read('supabase/operations/terminalize_v106_rollback.sql')
  const rollback = read('supabase/operations/rollback_v106_to_v105.sql')
  const receipt = read('supabase/migrations/20260820030000_v106_formal16_rollback_receipt.sql')
  const singleUseReceipt = read('supabase/migrations/20260820040000_v106_formal17_single_use_rollback_receipt.sql')
  const cutoverGeneration = read('supabase/migrations/20260820050000_v106_formal19_cutover_generation.sql')
  const rawIngestBarrier = read('supabase/migrations/20260820060000_v106_formal20_raw_ingest_barrier.sql')
  const activation = read('supabase/operations/activate_v106_promotion.sql')
  const manifest = json('release/v106-formal-v10-main-release-manifest.json')
  assert.match(sql, /revoke execute on function public\.issue_v106_prediction\(jsonb\) from service_role/i)
  assert.match(sql, /version\s*=\s*'v106'[\s\S]*status\s*=\s*'active'/i)
  assert.match(sql, /quiet_before_at\s*:=\s*terminalization_started_at\s*-\s*interval\s*'15 seconds'/i)
  assert.match(sql, /issuance_status\s*=\s*'expired_no_final'/i)
  assert.match(sql, /status\s*=\s*'dead_letter'[\s\S]*claim_token\s*=\s*null[\s\S]*isolated_at\s*=\s*now\(\)/i)
  assert.match(sql, /last_error\s*=\s*coalesce\(\s*nullif\(last_error,\s*''\),\s*'formal_v106_rollback_after_producer_stop'\s*\)/i)
  assert.match(sql, /status\s+in\s*\(\s*'pending'\s*,\s*'processing'\s*,\s*'error'\s*\)/i)
  assert.match(sql, /v106 non-terminal issuance remains after rollback terminalization/i)
  assert.match(sql, /active outbox remains after rollback terminalization/i)
  assert.match(sql, /insert into public\.v106_rollback_terminalization_receipts/i)
  assert.match(sql, /pg_advisory_xact_lock\(hashtextextended\('v105_capture_source_fence:capture', 0\)\)/i)
  assert.match(sql, /revoke execute on function public\.persist_v105_capture_envelope\(jsonb\) from service_role/i)
  assert.match(sql, /revoke execute on function public\.persist_v105_fenced_capture_envelope\(jsonb\) from service_role/i)
  assert.doesNotMatch(sql, /abandoned_shoe_change/)
  assert.match(receipt, /unresolved_after_count integer not null check \(unresolved_after_count = 0\)/i)
  assert.match(receipt, /active_outbox_after_count integer not null check \(active_outbox_after_count = 0\)/i)
  assert.match(singleUseReceipt, /cutover_generation uuid/i)
  assert.match(singleUseReceipt, /strategy_activated_at timestamptz/i)
  assert.match(singleUseReceipt, /consumed_at timestamptz/i)
  assert.match(singleUseReceipt, /unique index[\s\S]*cutover_generation/i)
  assert.match(cutoverGeneration, /alter table public\.ai_strategy_versions[\s\S]*add column if not exists cutover_generation uuid/i)
  assert.match(cutoverGeneration, /cutover_generation set not null/i)
  assert.match(rawIngestBarrier, /pg_advisory_xact_lock_shared\(pg_catalog\.hashtextextended\('v105_capture_source_fence:capture', 0\)\)/i)
  assert.match(rawIngestBarrier, /revoke execute on function public\.persist_v105_capture_envelope\(jsonb\) from public, anon, authenticated, service_role/i)
  assert.match(rawIngestBarrier, /grant execute on function public\.persist_v105_fenced_capture_envelope\(jsonb\) to service_role/i)
  assert.match(activation, /revoke execute on function public\.persist_v105_capture_envelope\(jsonb\) from service_role/i)
  assert.match(activation, /status = 'active', issuance_enabled = true, activated_at = now\(\), cutover_generation = gen_random_uuid\(\)/i)
  assert.match(sql, /select activated_at, cutover_generation[\s\S]*receipt_generation := active_cutover_generation/i)
  assert.match(rollback, /cutover_generation = active_cutover_generation/i)
  assert.match(rollback, /started_at >= active_strategy_activated_at/i)
  assert.match(rollback, /completed_at >= started_at/i)
  assert.match(rollback, /durable v106 rollback terminalization receipt is missing or incomplete/i)
  assert.match(rollback, /issuance_status_updated_at < latest_receipt\.started_at/i)
  assert.match(rollback, /active outbox appeared after rollback terminalization receipt/i)
  assert.match(rollback, /strategy_activated_at = active_strategy_activated_at/i)
  assert.match(rollback, /consumed_at is null/i)
  assert.match(rollback, /set consumed_at = clock_timestamp\(\), consumed_by = 'rollback_v106_to_v105'/i)
  assert.doesNotMatch(rollback, /grant execute on function public\.persist_v105_capture_envelope\(jsonb\) to service_role/i)
  assert.match(rollback, /grant execute on function public\.persist_v105_fenced_capture_envelope\(jsonb\) to service_role/i)
  assert.doesNotMatch(rollback, /abandoned_shoe_change/)
  assert.equal(manifest.databaseArtifacts.rollbackReceipt.path, 'supabase/migrations/20260820030000_v106_formal16_rollback_receipt.sql')
  assert.equal(manifest.databaseArtifacts.rollbackReceiptSingleUse.path, 'supabase/migrations/20260820040000_v106_formal17_single_use_rollback_receipt.sql')
  assert.equal(manifest.databaseArtifacts.cutoverGeneration.path, 'supabase/migrations/20260820050000_v106_formal19_cutover_generation.sql')
  assert.equal(manifest.databaseArtifacts.rawIngestBarrier.path, 'supabase/migrations/20260820060000_v106_formal20_raw_ingest_barrier.sql')
  assert.equal(manifest.databaseArtifacts.rollbackTerminalize.path, 'supabase/operations/terminalize_v106_rollback.sql')
  assert.equal(manifest.rollback.terminalizeScript, 'supabase/operations/terminalize_v106_rollback.sql')
  assert.equal(manifest.rollback.order[1], 'run bound v106 rollback terminalization and isolate active outbox evidence')
})

test('formal.4 cutover terminalization is fenced, quiet-period guarded, and identity preserving', () => {
  const sql = read('supabase/operations/terminalize_v105_cutover.sql')
  assert.match(sql, /has_function_privilege\('service_role',\s*'public\.issue_v105_prediction\(jsonb\)',\s*'EXECUTE'\)/i)
  assert.match(sql, /version\s*=\s*'v105'[\s\S]*status\s*=\s*'active'/i)
  assert.match(sql, /prediction_issued_at\s*>\s*now\(\)\s*-\s*interval\s*'15 seconds'/i)
  assert.match(sql, /strategy_version\s*=\s*'v105'[\s\S]*prediction_issued_at\s+is\s+not\s+null[\s\S]*settlement_final\s+is\s+not\s+true/i)
  assert.match(sql, /issuance_status\s*=\s*'expired_no_final'/i)
  assert.match(sql, /issuance_status_reason\s*=\s*'formal_v106_cutover_after_producer_stop'/i)
  assert.doesNotMatch(sql, /delete\s+from|prediction_issued_at\s*=|issued_prediction_payload\s*=/i)
})
