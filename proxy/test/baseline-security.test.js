import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const baseline = readFileSync(new URL('../../frontend/supabase/schema_v100_baseline.sql', import.meta.url), 'utf8')

const serviceOnlyFunctions = [
  'apply_v100_rank_ledger_event',
  'cleanup_cloud_table_snapshots',
  'cleanup_short_retention_data',
  'compact_cloud_table_snapshots',
  'get_v100_prediction_lifecycle_stats',
  'issue_v100_prediction',
  'limit_cloud_table_snapshot_writes',
  'persist_latest_cloud_table_snapshot',
  'persist_v100_settled_round',
  'purge_expired_manager_licenses',
  'reconcile_v100_prediction_lifecycle',
  'settle_v100_prediction',
]

test('every SECURITY DEFINER function is service-role-only in the v100 baseline', () => {
  for (const name of serviceOnlyFunctions) {
    const grants = [...baseline.matchAll(new RegExp(`GRANT\\s+(?:ALL|EXECUTE)\\s+ON\\s+FUNCTION\\s+public\\.${name}\\([^;]*?\\)\\s+TO\\s+([^;]+);`, 'gi'))]
      .map((match) => match[1].trim().toLowerCase())
    assert.deepEqual(grants, ['service_role'], `${name} execute grants`)
    assert.match(baseline, new RegExp(`REVOKE\\s+ALL\\s+ON\\s+FUNCTION\\s+public\\.${name}\\([^;]*?\\)\\s+FROM\\s+PUBLIC;`, 'i'), `${name} public execute revoked`)
  }
  assert.doesNotMatch(
    baseline,
    /ALTER DEFAULT PRIVILEGES[^;]*GRANT (?:ALL|EXECUTE) ON FUNCTIONS TO (?:anon|authenticated);/i,
  )
  assert.doesNotMatch(
    baseline,
    /ALTER DEFAULT PRIVILEGES[^;]*GRANT ALL ON (?:TABLES|SEQUENCES) TO (?:anon|authenticated);/i,
  )
  assert.doesNotMatch(baseline, /^\\(?:un)?restrict\b/m)
})

test('v100 baseline preserves current RLS, identity uniqueness, compaction, and retention contracts', () => {
  assert.match(baseline, /ENABLE ROW LEVEL SECURITY/)
  assert.match(baseline, /cloud_table_rounds_identity_unique/)
  assert.match(baseline, /daily_prediction_results_identity_strategy_unique/)
  assert.match(baseline, /daily_roadmap_events_identity_unique/)
  assert.match(baseline, /CREATE FUNCTION public\.compact_cloud_table_snapshots\(\)/)
  assert.match(baseline, /CREATE FUNCTION public\.cleanup_short_retention_data\(retention interval(?: DEFAULT [^)]+)?\)/)
  assert.match(baseline, /CREATE TRIGGER trg_limit_cloud_table_snapshot_writes/)
  assert.match(baseline, /snapshot_at > now\(\) - interval '30 seconds'/)
  assert.match(baseline, /snapshot_at < now\(\) - interval '24 hours'/)
  assert.match(baseline, /pg_advisory_xact_lock\(hashtext\(snapshot_session\)\)/)
  assert.match(baseline, /CREATE FUNCTION public\.compact_cloud_table_snapshots\(\)[\s\S]*?TRUNCATE TABLE public\.cloud_table_snapshots/i)
})
