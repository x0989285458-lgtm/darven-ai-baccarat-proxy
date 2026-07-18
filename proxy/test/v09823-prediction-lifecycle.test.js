import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createApp } from '../src/server.js'
import { createSupabaseIngestionClient } from '../src/supabase-writer.js'

const migrationUrl = new URL('../../frontend/supabase/schema_v09823_prediction_lifecycle.sql', import.meta.url)
const rollbackUrl = new URL('../../frontend/supabase/rollback_v09823_prediction_lifecycle.sql', import.meta.url)
const dryRunUrl = new URL('../scripts/v09823-prediction-lifecycle-dry-run.sql', import.meta.url)
const postMigrationVerificationUrl = new URL('../scripts/v09823-prediction-lifecycle-post-migration-verification.sql', import.meta.url)
const deploymentUrl = new URL('../../docs/release/v09823-prediction-lifecycle-deployment.md', import.meta.url)
const strategyVersion = 'v98'

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload), json: async () => payload }
}

function table(tableId = 'BAG01', shoe = 88, round = 20) {
  return { tableId, shoe, round, sourceUpdatedAt: '2026-07-17T01:00:00.000Z', beadPlateRaw: '0102', bigRoadRaw: 'BP' }
}

test('v098.23 migration adds lifecycle independently and changes only lifecycle fields during reconcile', () => {
  const sql = readFileSync(migrationUrl, 'utf8')
  assert.match(sql, /add column if not exists issuance_status\s+text/i)
  assert.match(sql, /add column if not exists issuance_status_updated_at\s+timestamptz/i)
  assert.match(sql, /add column if not exists issuance_status_reason\s+text/i)
  assert.match(sql, /issuance_status[^;]+pending[^;]+settled[^;]+expired_no_final[^;]+abandoned_shoe_change/is)
  assert.match(sql, /create or replace function public\.reconcile_v09823_prediction_lifecycle\s*\(\s*p_source text,\s*p_table_id text,\s*p_current_shoe text,\s*p_current_visible_round integer\s*\)/i)
  const rpc = sql.match(/create or replace function public\.reconcile_v09823_prediction_lifecycle[\s\S]*?\$\$;/i)?.[0] ?? ''
  assert.match(rpc, /prediction_issued_at is not null/i)
  assert.match(rpc, /settlement_final is not true/i)
  assert.match(rpc, /shoe_no is distinct from p_current_shoe/i)
  assert.match(rpc, /round_no < p_current_visible_round/i)
  assert.match(rpc, /else 'pending'/i)
  assert.match(rpc, /'source', p_source[\s\S]+'table_id', p_table_id[\s\S]+'current_shoe', p_current_shoe[\s\S]+'current_visible_round', p_current_visible_round/is)
  const update = rpc.match(/update public\.daily_prediction_results[\s\S]*?returning/i)?.[0] ?? ''
  for (const immutable of ['predicted_result', 'confidence', 'probabilities', 'prediction_features', 'issued_prediction_payload', 'prediction_issued_at', 'actual_result', 'is_hit', 'resolved_at', 'settlement_final', 'settlement_status', 'settlement_source_action', 'side_actual_results', 'side_hits']) {
    assert.doesNotMatch(update, new RegExp(`${immutable}\\s*=`, 'i'))
  }
  assert.match(sql, /revoke all on function public\.reconcile_v09823_prediction_lifecycle[^;]+public, anon, authenticated/i)
  assert.match(sql, /grant execute on function public\.reconcile_v09823_prediction_lifecycle[^;]+service_role/i)
})

test('v098.23 issue is pending, settlement is settled, and late authoritative final is not blocked by expired lifecycle', () => {
  const sql = readFileSync(migrationUrl, 'utf8')
  const issue = sql.match(/create or replace function public\.issue_v09821_prediction[\s\S]*?\$\$;/i)?.[0] ?? ''
  const settle = sql.match(/create or replace function public\.settle_v09821_prediction[\s\S]*?\$\$;/i)?.[0] ?? ''
  assert.match(issue, /issuance_status[^\n]+issuance_status_updated_at[^\n]+issuance_status_reason/i)
  assert.match(issue, /'pending'/i)
  assert.match(settle, /issuance_status\s*=\s*'settled'/i)
  assert.doesNotMatch(settle, /issuance_status\s+(?:=|in)\s*\(?\s*'pending'/i)
  assert.match(settle, /settlement_final\s*=\s*true/i)
})

test('v098.23 migration backs up before explicit settled backfill; dry-run is SELECT-only and rollback is non-destructive app-first', () => {
  const migration = readFileSync(migrationUrl, 'utf8')
  const backupAt = migration.search(/create table if not exists public\.daily_prediction_results_v09823_settled_backup/i)
  const backfillAt = backupAt < 0 ? -1 : backupAt + migration.slice(backupAt).search(/update public\.daily_prediction_results[\s\S]+?issuance_status\s*=\s*'settled'/i)
  assert.ok(backupAt >= 0 && backfillAt > backupAt)
  assert.match(migration, /where settlement_final is true/i)
  const dryRun = readFileSync(dryRunUrl, 'utf8')
  assert.doesNotMatch(dryRun, /\b(update|insert|delete|merge|truncate|alter|create|drop)\b/i)
  assert.doesNotMatch(dryRun, /\bissuance_status(?:_updated_at|_reason)?\b|current_issuance_status/i)
  for (const value of ['pending', 'settled', 'expired_no_final', 'abandoned_shoe_change']) assert.match(dryRun, new RegExp(value, 'i'))
  assert.match(dryRun, /current_setting\('app\.v09823_current_source'/i)
  assert.match(dryRun, /prediction_issued_at\s+desc[\s\S]+round_no\s+desc[\s\S]+id\s+desc/i)
  for (const count of ['would_be_pending', 'would_be_settled', 'would_be_expired_no_final', 'would_be_abandoned_shoe_change']) assert.match(dryRun, new RegExp(count, 'i'))
  assert.doesNotMatch(dryRun, /BAG\d+|\b14573\b/i)
  const postMigrationVerification = readFileSync(postMigrationVerificationUrl, 'utf8')
  assert.doesNotMatch(postMigrationVerification, /\b(update|insert|delete|merge|truncate|alter|create|drop)\b/i)
  assert.match(postMigrationVerification, /issuance_status/i)
  assert.match(postMigrationVerification, /active_pending/i)
  const rollback = readFileSync(rollbackUrl, 'utf8')
  assert.match(rollback, /app(?:lication)?[- ]first|application rollback/i)
  assert.match(rollback, /revoke execute on function public\.reconcile_v09823_prediction_lifecycle/i)
  assert.doesNotMatch(rollback, /drop\s+(column|table|function|index)|delete\s+from|truncate/i)
})

test('v098.23 deployment runbook orders dry-run, migration, app rollout, verification and app-first rollback without worker changes', () => {
  const runbook = readFileSync(deploymentUrl, 'utf8')
  const dryRunAt = runbook.search(/SELECT-only dry-run/i)
  const migrationAt = runbook.search(/schema_v09823_prediction_lifecycle\.sql/i)
  const postMigrationVerificationAt = runbook.search(/v09823-prediction-lifecycle-post-migration-verification\.sql/i)
  const appAt = runbook.search(/deploy proxy and frontend/i)
  const verifyAt = runbook.search(/verify lifecycle/i)
  const rollbackAt = runbook.search(/app-first rollback/i)
  assert.ok(dryRunAt >= 0 && migrationAt > dryRunAt && postMigrationVerificationAt > migrationAt && appAt > postMigrationVerificationAt && verifyAt > appAt && rollbackAt > verifyAt)
  assert.match(runbook, /proxy\/frontend[^\n]+098\.23/i)
  assert.match(runbook, /worker protocol[^\n]+v098/i)
  assert.match(runbook, /strategyVersion[^\n]+v098\.20_六階段權重門檻整合版/i)
  assert.match(runbook, /no outcome guessing|never guess outcomes/i)
})

test('v098.23 writer verifies exact reconcile ACK identity and lifecycle counts', async () => {
  const requests = []
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) })
      return response({ source: 'ofalive99', table_id: 'BAG03A', current_shoe: '901', current_visible_round: 12, pending: 2, expired_no_final: 3, abandoned_shoe_change: 4, updated_total: 9 })
    },
  })
  const ack = await client.reconcilePredictionLifecycle({ source: 'ofalive99', tableId: 'BAG03A', currentShoe: 901, currentVisibleRound: 12 })
  assert.deepEqual(ack, { source: 'ofalive99', tableId: 'BAG03A', currentShoe: '901', currentVisibleRound: 12, counts: { pending: 2, expiredNoFinal: 3, abandonedShoeChange: 4, updatedTotal: 9 } })
  assert.match(requests[0].url, /\/rpc\/reconcile_v100_prediction_lifecycle$/)
  assert.deepEqual(requests[0].body, { p_source: 'ofalive99', p_table_id: 'BAG03A', p_current_shoe: '901', p_current_visible_round: 12 })

  const mismatch = createSupabaseIngestionClient({ url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false, fetchImpl: async () => response({ source: 'ofalive99', table_id: 'BAG03A', current_shoe: '902', current_visible_round: 12, pending: 0, expired_no_final: 0, abandoned_shoe_change: 0, updated_total: 0 }) })
  await assert.rejects(mismatch.reconcilePredictionLifecycle({ source: 'ofalive99', tableId: 'BAG03A', currentShoe: 901, currentVisibleRound: 12 }), /reconciliation acknowledgement failed/)
})

test('v098.23 runtime reconciles once per changed screen identity per table, including ten tables and restart', async () => {
  const calls = []
  const writer = {
    configured: true,
    async reconcilePredictionLifecycle(identity) { calls.push(identity); return { ...identity, counts: { pending: 0, expiredNoFinal: 0, abandonedShoeChange: 0, updatedTotal: 0 } } },
    async issuePrediction(candidate) { return { ...candidate, predictionId: `pid-${candidate.targetTableId}-${candidate.targetShoe}-${candidate.targetRound}`, issuedAt: '2026-07-17T01:00:00.000Z' } },
    async readIssuedPrediction() { return null },
  }
  const ten = ['BAG01', 'BAG02', 'BAG03', 'BAG03A', 'BAG05', 'BAG06', 'BAG07', 'BAG08', 'BAG09', 'BAG10'].map((id) => table(id))
  const app = createApp({ autoConnect: false, supabaseClient: writer })
  app.state.setTables(ten)
  app.state.setTables(ten.map((item) => ({ ...item, sourceUpdatedAt: '2026-07-17T01:00:01.000Z' })))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.length, 10)
  assert.ok(calls.every((item) => item.source === 'ofalive99' && item.currentVisibleRound === 20))
  app.state.setTables(ten.map((item) => item.tableId === 'BAG05' ? { ...item, round: 21 } : item))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.length, 11)
  assert.equal(calls.at(-1).tableId, 'BAG05')
  assert.equal(calls.at(-1).currentVisibleRound, 21)

  const restartedCalls = []
  const restarted = createApp({ autoConnect: false, supabaseClient: { ...writer, reconcilePredictionLifecycle: async (identity) => { restartedCalls.push(identity); return { ...identity, counts: { pending: 0, expiredNoFinal: 0, abandonedShoeChange: 0, updatedTotal: 0 } } } } })
  restarted.state.setTables(ten)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(restartedCalls.length, 10)
})

test('v098.23 lifecycle guard rejects same-shoe round regression without stale reconcile or issuance mutation', async () => {
  const reconciled = []
  const issued = []
  const writer = {
    configured: true,
    async reconcilePredictionLifecycle(identity) { reconciled.push(identity) },
    async issuePrediction(candidate) {
      issued.push([candidate.targetShoe, candidate.targetRound])
      return { ...candidate, predictionId: `pid-${candidate.targetShoe}-${candidate.targetRound}`, issuedAt: '2026-07-17T01:00:00.000Z' }
    },
    async readIssuedPrediction() { return null },
  }
  const app = createApp({ autoConnect: false, supabaseClient: writer })
  for (const round of [20, 21, 20]) {
    app.state.setTables([table('BAG01', 88, round)])
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.deepEqual(reconciled.map(({ currentShoe, currentVisibleRound }) => [currentShoe, currentVisibleRound]), [['88', 20], ['88', 21]])
  assert.deepEqual(issued, [['88', 21], ['88', 22]])
})

test('v098.23 lifecycle guard rejects old-shoe replay and still accepts a legitimate newer shoe', async () => {
  const reconciled = []
  const issued = []
  const writer = {
    configured: true,
    async reconcilePredictionLifecycle(identity) { reconciled.push(identity) },
    async issuePrediction(candidate) {
      issued.push([candidate.targetShoe, candidate.targetRound])
      return { ...candidate, predictionId: `pid-${candidate.targetShoe}-${candidate.targetRound}`, issuedAt: '2026-07-17T01:00:00.000Z' }
    },
    async readIssuedPrediction() { return null },
  }
  const app = createApp({ autoConnect: false, supabaseClient: writer })
  for (const shoe of [88, 89, 88, 90]) {
    app.state.setTables([table('BAG01', shoe, 20)])
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.deepEqual(reconciled.map(({ currentShoe, currentVisibleRound }) => [currentShoe, currentVisibleRound]), [['88', 20], ['89', 20], ['90', 20]])
  assert.deepEqual(issued, [['88', 21], ['89', 21], ['90', 21]])
})

test('v098.23 reconcile failure records persistence error without pretending settlement or polling repeatedly', async () => {
  let reconcileCalls = 0
  let issueCalls = 0
  const app = createApp({ autoConnect: false, supabaseClient: {
    configured: true,
    async reconcilePredictionLifecycle() { reconcileCalls += 1; throw new Error('reconcile unavailable') },
    async issuePrediction(candidate) { issueCalls += 1; return { ...candidate, predictionId: 'pid', issuedAt: '2026-07-17T01:00:00.000Z' } },
    async readIssuedPrediction() { return null },
  } })
  app.state.setTables([table()])
  app.state.setTables([{ ...table(), sourceUpdatedAt: '2026-07-17T01:00:02.000Z' }])
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(reconcileCalls, 1)
  assert.equal(issueCalls, 1, 'preissuance may proceed independently')
  assert.match(app.state.snapshot().status.persistenceError ?? '', /reconcile unavailable/)
})

test('v098.23 lifecycle stats use an aggregate RPC and exclude expired and abandoned rows from active pending while old APIs remain additive', async () => {
  let statsUrl = ''
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    fetchImpl: async (url) => {
      statsUrl = String(url)
      return response({ active_pending: 2, settled: 1, expired_no_final: 1, abandoned_shoe_change: 1, unclassified: 1, total: 6 })
    },
  })
  assert.deepEqual(await client.getPredictionLifecycleStats(), { activePending: 2, settled: 1, expiredNoFinal: 1, abandonedShoeChange: 1, unclassified: 1, total: 6 })
  assert.match(statsUrl, /\/rpc\/get_v100_prediction_lifecycle_stats$/)

  const app = createApp({ autoConnect: false, licenseAdminClient: { configured: false, getCloudDataStatus: async () => ({ message: 'ok' }), getDailyAnalytics: async () => ({ todayRoundCount: 0, tableStats: [], dailyReports: [] }) }, supabaseClient: { configured: true, getPredictionLifecycleStats: async () => ({ activePending: 2, settled: 1, expiredNoFinal: 1, abandonedShoeChange: 1, unclassified: 0, total: 5 }) } })
  const status = JSON.parse((await app.inject({ url: '/api/cloud-data/status' })).body)
  assert.equal(status.ok, true)
  assert.equal(status.lifecycleStats.activePending, 2)
  assert.ok(Array.isArray(status.tableStats))
})
