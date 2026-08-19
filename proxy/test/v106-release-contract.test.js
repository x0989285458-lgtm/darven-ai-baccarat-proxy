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

test('v106 release identity is coherent while the unchanged capture worker retains protocol v105', () => {
  for (const path of ['proxy/package.json', 'frontend/package.json']) {
    assert.equal(json(path).version, '1.0.63', path)
  }
  assert.equal(json('cloud-browser-worker/package.json').version, '1.0.62')
  assert.match(read('proxy/src/build-version.js'), /BUILD_VERSION = 'v106'/)
  assert.match(read('proxy/src/supabase-writer.js'), /ALL_MT_EQUAL_STRATEGY_VERSION = 'v105'[\s\S]*FORMAL_STRATEGY_VERSION = 'v106'/)
  assert.match(read('proxy/src/server.js'), /import \{[^}]*FORMAL_STRATEGY_VERSION[^}]*\} from '\.\/supabase-writer\.js'/)
  assert.match(read('proxy/src/server.js'), /FORMAL_STRATEGY_VERSION === 'v106'[\s\S]*createV106FormalRuntime/)
  assert.match(read('frontend/src/lib/buildVersion.ts'), /buildVersion: 'v106'[\s\S]*strategyVersion: 'v106'/)
  assert.match(read('cloud-browser-worker/src/runtime-config.js'), /BUILD_VERSION = '105'/)
  assert.match(read('cloud-browser-worker/Dockerfile'), /image\.version="v105"/)
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
  assert.match(guard, /expired_no_final[\s\S]*abandoned_shoe_change/i)
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
  assert.equal(manifest.applicationVersion, '1.0.63')
  assert.equal(manifest.strategyVersion, 'v106')
  assert.equal(manifest.mainStrategy.source, 'v105-shadow-v10-big-road-uncommon-structure-rank-synchronized')
  assert.equal(manifest.sideStrategy.source, 'v105')
  assert.equal(manifest.mainStrategy.activationGate, 'structureDiagnostics.eligible === true')
  assert.equal(manifest.mainStrategy.fallback, 'exact formal v105 main projection')
  assert.equal(manifest.gitTag, 'v106.0.0-formal.3')
  assert.deepEqual(manifest.deploymentOrder, ['database-additive', 'fence-v105-new-issuance', 'producer-stop', 'drain-v105-and-queue', 'activate-v106', 'proxy', 'verify-unchanged-worker', 'frontend', 'live-e2e', 'finalize'])
  assert.equal(manifest.releaseScope.workerBehaviorChanged, false)
  assert.equal(manifest.inheritedProductionSafety.preserveQueue, true)
  assert.equal(manifest.inheritedProductionSafety.preserveAckCursor, true)
  assert.equal(manifest.inheritedProductionSafety.exactAckRequired, true)
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
  assert.deepEqual(manifest.rollback.order, ['stop producer admission', 'drain all non-terminal unsettled v106 issuances', 'run rollback SQL', 'deploy exact v105 proxy and frontend; retain verified unchanged worker', 'verify sole Active v105 and new v105 Final'])
})
