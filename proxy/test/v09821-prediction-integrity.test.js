import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createApp } from '../src/server.js'
import { buildLivePrediction, buildPredictionResultRow, createSupabaseIngestionClient } from '../src/supabase-writer.js'
import { buildDailyReports, buildTableStats, createLicenseAdminClient } from '../src/license-admin.js'

const migrationUrl = new URL('../../frontend/supabase/schema_v09821_prediction_integrity.sql', import.meta.url)
const rollbackUrl = new URL('../../frontend/supabase/rollback_v09821_prediction_integrity.sql', import.meta.url)
const dryRunUrl = new URL('../scripts/v09821-prediction-integrity-dry-run.sql', import.meta.url)

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload), json: async () => payload }
}

function table(overrides = {}) {
  return { tableId: 'BAG01', shoe: 88, round: 20, sourceUpdatedAt: '2026-07-16T01:00:00.000Z', ...overrides }
}

test('v098.21 additive migration keeps legacy RPC and defines immutable issuance/settlement plus rollback', () => {
  const sql = readFileSync(migrationUrl, 'utf8')
  const rollback = readFileSync(rollbackUrl, 'utf8')
  const legacy = readFileSync(new URL('../../frontend/supabase/schema_v098_snapshot_safety.sql', import.meta.url), 'utf8')
  assert.match(legacy, /create or replace function public\.persist_v098_settled_round/i)
  assert.doesNotMatch(sql, /create or replace function public\.persist_v098_settled_round/i)
  assert.match(sql, /add column if not exists prediction_issued_at\s+timestamptz/i)
  assert.match(sql, /add column if not exists settlement_status\s+text/i)
  assert.match(sql, /settlement_status[^;]+check[^;]+hit[^;]+miss[^;]+push[^;]+unknown/is)
  assert.match(sql, /create or replace function public\.issue_v09821_prediction/i)
  assert.match(sql, /create or replace function public\.settle_v09821_prediction/i)
  const issuanceRpc = sql.match(/create or replace function public\.issue_v09821_prediction[\s\S]*?\$\$;/i)?.[0] ?? ''
  assert.match(issuanceRpc, /predicted_result, confidence, actual_result, is_hit,/i)
  assert.match(issuanceRpc, /prediction_features, probabilities, resolved_at,/i)
  assert.match(issuanceRpc, /\(p_prediction->>'confidence'\)::integer,\s*null, null,/i)
  assert.match(issuanceRpc, /coalesce\(p_prediction->'probabilities',[^\n]+\),\s*null,/i)
  assert.match(issuanceRpc, /issued_prediction_payload'->>'targetTableId'[\s\S]+table_id/i)
  assert.match(issuanceRpc, /issued_prediction_payload'->>'targetShoe'[\s\S]+shoe_no/i)
  assert.match(issuanceRpc, /issued_prediction_payload'->>'targetRound'[\s\S]+round_no/i)
  assert.match(sql, /on conflict \(source, table_id, shoe_no, round_no, strategy_version\) do nothing/i)
  assert.match(sql, /where id = \(p_settlement->>'prediction_id'\)::uuid/i)
  assert.match(sql, /settlement identity mismatch/i)
  assert.match(sql, /conflicting existing prediction settlement/i)
  assert.match(sql, /resolved_at[^\n]+is null/i)
  assert.match(sql, /is_hit[^\n]+is distinct from[\s\S]+existing\.predicted_result/is)
  assert.doesNotMatch(sql.match(/create or replace function public\.settle_v09821_prediction[\s\S]*?\$\$;/i)?.[0] ?? '', /set[\s\S]*predicted_result\s*=/i)
  assert.match(rollback, /revoke execute on function public\.settle_v09821_prediction/i)
  assert.match(rollback, /revoke execute on function public\.issue_v09821_prediction/i)
})

test('v098.21 dry-run is SELECT-only, reports full identity/original/status, and contains no incident hard-code', () => {
  const sql = readFileSync(dryRunUrl, 'utf8')
  assert.doesNotMatch(sql, /\b(update|insert|delete|merge|truncate)\b/i)
  for (const key of ['source', 'table_id', 'shoe_no', 'round_no', 'strategy_version', 'predicted_result', 'confidence', 'suggested_status']) {
    assert.match(sql, new RegExp(`\\b${key}\\b`, 'i'))
  }
  assert.match(sql, /unknown/i)
  assert.doesNotMatch(sql, /BAG02|14573|\b44\b/i)
})

test('v098.21 writer issuance returns the first durable immutable payload and prediction id', async () => {
  const candidate = buildLivePrediction(table())
  const first = { ...candidate, predictionId: '11111111-1111-1111-1111-111111111111', issuedAt: '2026-07-16T01:00:01.000Z' }
  const requests = []
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) })
      return response({ prediction_id: first.predictionId, prediction_issued_at: first.issuedAt, prediction: first })
    },
  })
  const issued = await client.issuePrediction(candidate)
  assert.equal(issued.predictionId, first.predictionId)
  assert.deepEqual(issued, first)
  assert.match(requests[0].url, /\/rpc\/issue_v09821_prediction$/)
  assert.equal(requests[0].body.p_prediction.actual_result, null)
  assert.equal(requests[0].body.p_prediction.is_hit, null)
  assert.equal(requests[0].body.p_prediction.resolved_at, null)
})

test('v098.21 settlement covers banker/player hit-miss quadrants and tie PUSH without changing the issued direction', () => {
  const baseTable = table()
  const pending = buildLivePrediction(baseTable)
  const round = (rawResult) => ({ tableId: 'BAG01', shoe: 88, round: 21, rawResult, sourceAction: '/api/v1/gametype/*/game/*/room/*/table/*/summary' })
  const bankerRound = round([1, 9, 2, 10, -1, -1, -1, -1, 3, 9])
  const playerRound = round([9, 1, 10, 2, -1, -1, -1, -1, 9, 3])
  const tieRound = round([1, 1, 2, 2, -1, -1, -1, -1, 3, 3])
  for (const [predictedResult, completed, expectedHit] of [
    ['banker', bankerRound, true], ['banker', playerRound, false],
    ['player', playerRound, true], ['player', bankerRound, false],
  ]) {
    const row = buildPredictionResultRow(completed, baseTable, { ...pending, predictedResult })
    assert.equal(row.predicted_result, predictedResult)
    assert.equal(row.is_hit, expectedHit)
  }
  const push = buildPredictionResultRow(tieRound, baseTable, { ...pending, predictedResult: 'banker' })
  assert.equal(push.actual_result, 'tie')
  assert.equal(push.is_hit, false)
})

test('v098.21 writer settles by prediction_id and suppresses an identical duplicate settlement', async () => {
  const requests = []
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) })
      return response({ persisted: true, roadmapDurable: true, predictionDurable: true, prediction_id: '11111111-1111-1111-1111-111111111111' })
    },
  })
  const baseTable = table()
  const pending = { ...buildLivePrediction(baseTable), predictionId: '11111111-1111-1111-1111-111111111111', issuedAt: '2026-07-16T01:00:01.000Z' }
  const completed = { tableId: 'BAG01', shoe: 88, round: 21, rawResult: [1, 9, 2, 10, -1, -1, -1, -1, 3, 9], sourceAction: '/api/v1/gametype/*/game/*/room/*/table/*/summary' }
  await client.persistRound(completed, baseTable, pending)
  const duplicate = await client.persistRound(completed, baseTable, pending)
  assert.equal(duplicate.reason, 'duplicate_round')
  assert.equal(requests.length, 1)
  assert.match(requests[0].url, /\/rpc\/settle_v09821_prediction$/)
  assert.equal(requests[0].body.p_settlement.prediction_id, pending.predictionId)
  assert.equal(requests[0].body.p_settlement.settlement_final, true)
})

test('v098.21 settlement fails closed unless the acknowledgement prediction_id exactly matches the issued prediction', async () => {
  const baseTable = table()
  const pending = { ...buildLivePrediction(baseTable), predictionId: '11111111-1111-1111-1111-111111111111', issuedAt: '2026-07-16T01:00:01.000Z' }
  const completed = { tableId: 'BAG01', shoe: 88, round: 21, rawResult: [1, 9, 2, 10, -1, -1, -1, -1, 3, 9], sourceAction: '/api/v1/gametype/*/game/*/room/*/table/*/summary' }

  for (const prediction_id of [undefined, '22222222-2222-2222-2222-222222222222']) {
    let calls = 0
    const client = createSupabaseIngestionClient({
      url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
      fetchImpl: async () => {
        calls += 1
        return response({ persisted: true, roadmapDurable: true, predictionDurable: true, prediction_id })
      },
    })
    await assert.rejects(client.persistRound(completed, baseTable, pending), /settlement acknowledgement failed/)
    await assert.rejects(client.persistRound(completed, baseTable, pending), /settlement acknowledgement failed/)
    assert.equal(calls, 2, 'a rejected acknowledgement must not mark the round completed')
  }
})

test('v098.21 proxy exposes only DB-issued first payload, survives app/client reconstruction, separates table/shoe identity, and fails closed', async () => {
  const firstByIdentity = new Map()
  let fail = false
  const writer = {
    configured: true,
    async issuePrediction(candidate) {
      if (fail) throw new Error('issuance unavailable')
      const key = [candidate.targetTableId, candidate.targetShoe, candidate.targetRound, candidate.strategyVersion].join(':')
      if (!firstByIdentity.has(key)) firstByIdentity.set(key, { ...candidate, predictionId: `pid-${key}`, issuedAt: '2026-07-16T01:00:01.000Z' })
      return structuredClone(firstByIdentity.get(key))
    },
  }
  const clock = () => Date.parse('2026-07-16T01:00:30.000Z')
  const app1 = createApp({ autoConnect: false, supabaseClient: writer, now: clock })
  app1.state.setTables([table(), table({ tableId: 'BAG02' })])
  const firstTables = JSON.parse((await app1.inject({ url: '/api/tables' })).body)
  assert.equal(firstTables.length, 2)
  assert.ok(firstTables.every((item) => item.prediction?.predictionId))
  const saved = firstTables[0].prediction

  const app2 = createApp({ autoConnect: false, supabaseClient: writer, now: clock })
  app2.state.setTables([table({ bankerCount: 999, playerCount: 0 })])
  const restarted = JSON.parse((await app2.inject({ url: '/api/tables' })).body)[0].prediction
  assert.deepEqual(restarted, saved)

  app2.state.setTables([table({ shoe: 89 })])
  const nextShoe = JSON.parse((await app2.inject({ url: '/api/tables' })).body)[0].prediction
  assert.notEqual(nextShoe.predictionId, saved.predictionId)

  fail = true
  const failed = createApp({ autoConnect: false, supabaseClient: writer, now: clock })
  failed.state.setTables([table({ tableId: 'BAG03' })])
  const failedTable = JSON.parse((await failed.inject({ url: '/api/tables' })).body)[0]
  assert.equal(failedTable.prediction, null)
})

test('v098.21 admin main denominators exclude tie PUSH in SQL and fallback reports', async () => {
  const queries = []
  const rows = [
    { day: '2026-07-16', table_id: 'BAG01', shoe_no: '1', round_no: 1, predicted_result: 'banker', actual_result: 'banker', is_hit: true, settlement_final: true, prediction_features: {} },
    { day: '2026-07-16', table_id: 'BAG01', shoe_no: '1', round_no: 2, predicted_result: 'banker', actual_result: 'player', is_hit: false, settlement_final: true, prediction_features: {} },
    { day: '2026-07-16', table_id: 'BAG01', shoe_no: '1', round_no: 3, predicted_result: 'banker', actual_result: 'tie', is_hit: false, settlement_final: true, prediction_features: {} },
    { day: '2026-07-16', table_id: 'BAG01', shoe_no: '1', round_no: 4, predicted_result: 'player', actual_result: 'player', is_hit: true, settlement_final: true, prediction_features: {} },
    { day: '2026-07-16', table_id: 'BAG01', shoe_no: '1', round_no: 5, predicted_result: 'player', actual_result: 'banker', is_hit: false, settlement_final: true, prediction_features: {} },
  ]
  const pool = { async query(sql) {
    queries.push(String(sql))
    if (queries.length === 1) return { rows: [{ rounds: 5 }] }
    if (queries.length === 2) return { rows: [{ table_id: 'BAG01', rounds: 5, main_total: 4, main_hits: 2, side_actions: 0, side_hits: 0, side_actions_available: false }] }
    return { rows: [{ date: '2026-07-16', rounds: 5, banker_hit_rate: '50.0%', player_hit_rate: '50.0%', side_actions_available: false, tie_hit_rate: 'unavailable', dragon_hit_rate: 'unavailable', pair_hit_rate: 'unavailable', six_hit_rate: 'unavailable' }] }
  } }
  const analytics = await createLicenseAdminClient({ pool }).getDailyAnalytics()
  assert.equal(analytics.tableStats[0].mainHitRate, '50.0%')
  assert.equal(analytics.dailyReports[0].banker_hit_rate, '50.0%')
  assert.equal(analytics.dailyReports[0].player_hit_rate, '50.0%')
  const sql = queries.join('\n')
  assert.match(sql, /actual_result\s+in\s*\(\s*'banker'\s*,\s*'player'\s*\)[^\n]+as main_total/i)
  assert.match(sql, /predicted_result='banker'\s+and actual_result\s+in\s*\(\s*'banker'\s*,\s*'player'\s*\)[^\n]+as banker_total/i)
  assert.match(sql, /predicted_result='player'\s+and actual_result\s+in\s*\(\s*'banker'\s*,\s*'player'\s*\)[^\n]+as player_total/i)
  assert.equal(buildTableStats(rows)[0].mainHitRate, '50.0%')
  assert.equal(buildDailyReports(rows)[0].banker_hit_rate, '50.0%')
  assert.equal(buildDailyReports(rows)[0].player_hit_rate, '50.0%')
})

test('v098.21 settlement SQL preserves every issued field and treats resolved_at as replay metadata', () => {
  const sql = readFileSync(migrationUrl, 'utf8')
  const settlementRpc = sql.match(/create or replace function public\.settle_v09821_prediction[\s\S]*?\$\$;/i)?.[0] ?? ''
  const settlementUpdate = settlementRpc.match(/update public\.daily_prediction_results[\s\S]*?where id/i)?.[0] ?? ''
  assert.doesNotMatch(settlementUpdate, /prediction_features\s*=/i)
  for (const field of ['predicted_result', 'confidence', 'probabilities', 'issued_prediction_payload', 'prediction_issued_at', 'strategy_version']) assert.doesNotMatch(settlementUpdate, new RegExp(`${field}\\s*=`, 'i'))
  const replayConflict = settlementRpc.match(/if existing\.settlement_final is true then[\s\S]*?end if;/i)?.[0] ?? ''
  assert.doesNotMatch(replayConflict, /resolved_at\s+is distinct from/i)
  assert.match(replayConflict, /settlement_source_action\s+is distinct from/i)
  assert.match(replayConflict, /side_actual_results\s+is distinct from/i)
  assert.match(replayConflict, /side_hits\s+is distinct from/i)
})

test('v098.21 rollback preserves evidence and requires app-first order before RPC execute revocation', () => {
  const rollback = readFileSync(rollbackUrl, 'utf8')
  assert.doesNotMatch(rollback, /drop\s+(column|table|function|index)|delete\s+from|truncate/i)
  const appFirst = rollback.search(/app(?:lication)?[- ]first|application rollback/i)
  const revoke = rollback.search(/revoke\s+execute/i)
  assert.ok(appFirst >= 0 && revoke > appFirst)
  const migration = readFileSync(migrationUrl, 'utf8')
  assert.match(migration, /grant execute on function public\.issue_v09821_prediction/i)
  assert.match(migration, /grant execute on function public\.settle_v09821_prediction/i)
})

test('v098.21 readers include new final columns, retain legacy fallback, and exclude pending issuance', async () => {
  const requests = []
  const legacy = { id: 'legacy', table_id: 'BAG01', shoe_no: '88', round_no: 3, strategy_version: 'v098.20_六階段權重門檻整合版', predicted_result: 'banker', actual_result: 'banker', is_hit: true, settlement_final: null, side_hits: null, prediction_features: { prediction_timing: 'pre_result_context', settlement_final: true, side_hits: { tie: false } }, created_at: '2026-07-16T01:00:00Z' }
  const modern = { ...legacy, id: 'modern', round_no: 4, settlement_final: true, side_hits: { tie: true }, prediction_features: { prediction_timing: 'pre_result_context' }, created_at: '2026-07-16T01:01:00Z' }
  const pending = { ...modern, id: 'pending', round_no: 5, actual_result: null, is_hit: null, settlement_final: false }
  const client = createSupabaseIngestionClient({ url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false, fetchImpl: async (url) => { requests.push(new URL(url)); return response([modern, legacy, pending]) } })
  assert.deepEqual((await client.getStablePredictionRows()).map((row) => row.id), ['modern', 'legacy'])
  assert.deepEqual((await client.getRecentPredictionRows()).map((row) => row.id), ['modern', 'legacy'])
  assert.deepEqual((await client.getTableUiSettledPredictions({ tableId: 'BAG01', shoe: 88 })).map((row) => row.round), [4, 3])
  assert.equal(await client.countTodayPredictionRounds(), 2)
  for (const url of requests) {
    assert.match(url.searchParams.get('select') ?? '', /settlement_final/)
    assert.match(url.searchParams.get('select') ?? '', /prediction_features/)
    assert.match(url.searchParams.get('or') ?? '', /settlement_final\.eq\.true/)
    assert.match(url.searchParams.get('or') ?? '', /prediction_features->>settlement_final\.eq\.true/)
  }
})

test('v098.21 fallback analytics use settlement_final columns and side_hits column with legacy fallback', () => {
  const actions = { tie: true, superSix: false, bankerPair: false, playerPair: false, bankerDragon: false, playerDragon: false }
  const allMiss = { tie: false, superSix: false, bankerPair: false, playerPair: false, bankerDragon: false, playerDragon: false }
  const modernHits = { ...allMiss, tie: true }
  const rows = [
    { day: '2026-07-16', table_id: 'BAG01', shoe_no: '1', round_no: 1, predicted_result: 'banker', actual_result: 'banker', is_hit: true, settlement_final: true, side_hits: modernHits, prediction_features: { side_actions: actions, side_hits: allMiss } },
    { day: '2026-07-16', table_id: 'BAG01', shoe_no: '1', round_no: 2, predicted_result: 'banker', actual_result: 'player', is_hit: false, settlement_final: null, side_hits: null, prediction_features: { settlement_final: true, side_actions: actions, side_hits: allMiss } },
    { day: '2026-07-16', table_id: 'BAG01', shoe_no: '1', round_no: 3, predicted_result: 'banker', actual_result: null, is_hit: null, settlement_final: false, side_hits: null, prediction_features: { side_actions: actions, side_hits: modernHits } },
  ]
  const tableStats = buildTableStats(rows)[0]
  assert.equal(tableStats.rounds, 2)
  assert.equal(tableStats.sideHitRate, '50.0%')
  const report = buildDailyReports(rows)[0]
  assert.equal(report.rounds, 2)
  assert.equal(report.tie_hit_rate, '50.0%')
})

test('v098.21 issuance ACK identity is verified and issued prediction can be read exactly after restart', async () => {
  const candidate = buildLivePrediction(table())
  const mismatchClient = createSupabaseIngestionClient({ url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false, fetchImpl: async () => response({ prediction_id: 'pid', prediction_issued_at: '2026-07-16T01:00:00Z', prediction: { ...candidate, predictionId: 'pid', issuedAt: '2026-07-16T01:00:00Z', targetRound: candidate.targetRound + 1 } }) })
  await assert.rejects(mismatchClient.issuePrediction(candidate), /acknowledgement failed/)
  let requestedUrl
  const issued = { ...candidate, predictionId: 'pid', issuedAt: '2026-07-16T01:00:00Z' }
  const readClient = createSupabaseIngestionClient({ url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false, fetchImpl: async (url) => { requestedUrl = new URL(url); return response([{ id: 'pid', prediction_issued_at: issued.issuedAt, issued_prediction_payload: candidate, settlement_final: false }]) } })
  assert.deepEqual(await readClient.readIssuedPrediction({ tableId: 'BAG01', shoe: 88, round: 21, strategyVersion: candidate.strategyVersion }), issued)
  assert.equal(requestedUrl.searchParams.get('table_id'), 'eq.BAG01')
  assert.equal(requestedUrl.searchParams.get('shoe_no'), 'eq.88')
  assert.equal(requestedUrl.searchParams.get('round_no'), 'eq.21')
  assert.equal(requestedUrl.searchParams.get('strategy_version'), `eq.${candidate.strategyVersion}`)
})

test('v098.21 final after restart and beyond display TTL settles exact DB issuance without issuing from post-result table', async () => {
  const issued = { ...buildLivePrediction(table()), predictionId: 'pid-issued', issuedAt: '2026-07-16T01:00:00Z', createdAtMs: Date.parse('2026-07-16T01:00:00Z') }
  let issueCalls = 0
  let readCalls = 0
  const persisted = []
  const writer = { configured: true, issuePrediction: async () => { issueCalls += 1; throw new Error('must not issue from final table') }, readIssuedPrediction: async (identity) => { readCalls += 1; assert.deepEqual(identity, { tableId: 'BAG01', shoe: 88, round: 21, strategyVersion: issued.strategyVersion }); return issued }, persistRound: async (round, currentTable, prediction) => { persisted.push({ round, currentTable, prediction }); return { prediction: { table_id: 'BAG01', shoe_no: '88', round_no: 21, strategy_version: issued.strategyVersion, predicted_result: issued.predictedResult, actual_result: 'banker', is_hit: true } } } }
  const app = createApp({ autoConnect: false, supabaseClient: writer, predictionTtlMs: 1000, now: () => Date.parse('2026-07-16T01:10:00Z') })
  app.state.upsertRoundEvent({ tableId: 'BAG01', shoe: 88, round: 21, winner: 'banker', rawResult: [1, 9, 2, 10, 0, 0, -1, -1, 3, 9], sourceAction: '/api/v1/gametype/*/game/*/room/*/table/*/summary' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(readCalls, 1)
  assert.equal(issueCalls, 0)
  assert.equal(persisted.length, 1)
  assert.equal(persisted[0].prediction.predictionId, issued.predictionId)
})

test('v098.21 missing or failed issuance lookup fails closed without settlement', async () => {
  let persisted = 0
  const writer = {
    configured: true,
    readIssuedPrediction: async () => { throw new Error('issuance read unavailable') },
    persistRound: async () => { persisted += 1 },
  }
  const app = createApp({ autoConnect: false, supabaseClient: writer })
  app.state.upsertRoundEvent({ tableId: 'BAG01', shoe: 88, round: 21, winner: 'banker', rawResult: [1, 9, 2, 10, 0, 0, -1, -1, 3, 9], sourceAction: '/api/v1/gametype/*/game/*/room/*/table/*/summary' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(persisted, 0)
  assert.match(app.state.snapshot().status.persistenceError ?? '', /issuance read unavailable/)
})

test('v098.21 production settlement without predictionId fails closed instead of invoking legacy RPC', async () => {
  const requests = []
  const strategyVersion = buildLivePrediction(table()).strategyVersion
  const client = createSupabaseIngestionClient({ url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: true, fetchImpl: async (url, init) => {
    const endpoint = String(url)
    if (endpoint.includes('ai_strategy_versions') && init?.method === 'PATCH') return response([])
    if (endpoint.includes('ai_strategy_versions') && init?.method === 'POST') return response([])
    if (endpoint.includes('ai_strategy_versions') && init?.method === 'GET') return { ...response([{ version: strategyVersion, status: 'active' }]), json: async () => [{ version: strategyVersion, status: 'active' }] }
    requests.push(endpoint)
    return response({ persisted: true, roadmapDurable: true, predictionDurable: true })
  } })
  await client.ensureInitialStrategy()
  const completed = { tableId: 'BAG01', shoe: 88, round: 21, rawResult: [1, 9, 2, 10, 0, 0, -1, -1, 3, 9], sourceAction: '/api/v1/gametype/*/game/*/room/*/table/*/summary' }
  await assert.rejects(client.persistRound(completed, table(), buildLivePrediction(table())), /prediction identity is required/)
  assert.equal(requests.some((url) => url.includes('persist_v098_settled_round')), false)
})
