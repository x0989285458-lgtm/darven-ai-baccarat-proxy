import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createApp } from '../src/server.js'
import { buildLivePrediction, buildPredictionResultRow, createSupabaseIngestionClient } from '../src/supabase-writer.js'
import { buildDailyReports, buildTableStats, createLicenseAdminClient } from '../src/license-admin.js'


function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload), json: async () => payload }
}

function table(overrides = {}) {
  return { tableId: 'BAG01', shoe: 88, round: 20, sourceUpdatedAt: '2026-07-16T01:00:00.000Z', ...overrides }
}

test('writer issuance returns the first durable immutable payload and prediction id', async () => {
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
  assert.match(requests[0].url, /\/rpc\/issue_v105_prediction$/)
  assert.equal(requests[0].body.p_prediction.actual_result, null)
  assert.equal(requests[0].body.p_prediction.is_hit, null)
  assert.equal(requests[0].body.p_prediction.resolved_at, null)
})

test('direct issuance uses the transaction connection and preserves the exact RPC acknowledgement', async () => {
  const candidate = buildLivePrediction(table())
  const issued = { ...candidate, predictionId: '11111111-1111-1111-1111-111111111111', issuedAt: '2026-07-16T01:00:01.000Z' }
  const acknowledgement = { prediction_id: issued.predictionId, prediction_issued_at: issued.issuedAt, prediction: issued }
  const queries = []
  let fetchCalls = 0
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    fetchImpl: async () => { fetchCalls += 1; throw new Error('REST must not be used') },
    strategyPool: { async query(value) {
      queries.push(value)
      return { rows: [{ issue_v105_prediction: acknowledgement }] }
    } },
  })

  assert.deepEqual(await client.issuePrediction(candidate), issued)
  assert.equal(fetchCalls, 0)
  assert.equal(queries.length, 1)
  assert.match(queries[0].text, /select public\.issue_v105_prediction\(\$1::jsonb\) as issue_v105_prediction/)
  assert.equal(queries[0].values.length, 1)
  assert.equal(queries[0].values[0].table_id, candidate.targetTableId)
  assert.equal(queries[0].values[0].shoe_no, candidate.targetShoe)
  assert.equal(queries[0].values[0].round_no, candidate.targetRound)
  assert.equal(queries[0].values[0].strategy_version, candidate.strategyVersion)
})

test('settlement covers banker/player hit-miss quadrants and tie PUSH without changing the issued direction', () => {
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

test('writer settles by prediction_id and suppresses an identical duplicate settlement', async () => {
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
  assert.match(requests[0].url, /\/rpc\/settle_v105_prediction$/)
  assert.equal(requests[0].body.p_settlement.prediction_id, pending.predictionId)
  assert.equal(requests[0].body.p_settlement.settlement_final, true)
})

test('formal settlement uses the backend transaction connection and preserves the exact RPC acknowledgement', async () => {
  const queries = []
  let fetchCalls = 0
  const predictionId = '11111111-1111-1111-1111-111111111111'
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    fetchImpl: async () => { fetchCalls += 1; throw new Error('REST must not be used') },
    strategyPool: { async query(value) {
      queries.push(value)
      return { rows: [{ settle_v105_prediction: {
        persisted: true, roadmapDurable: true, predictionDurable: true, prediction_id: predictionId,
      } }] }
    } },
  })
  const baseTable = table()
  const pending = { ...buildLivePrediction(baseTable), predictionId, issuedAt: '2026-07-16T01:00:01.000Z' }
  const completed = { tableId: 'BAG01', shoe: 88, round: 21, rawResult: [1, 9, 2, 10, -1, -1, -1, -1, 3, 9], sourceAction: '/api/v1/gametype/*/game/*/room/*/table/*/summary' }
  const result = await client.persistRound(completed, baseTable, pending)
  assert.equal(result.prediction.strategy_version, 'v105')
  assert.equal(fetchCalls, 0)
  assert.equal(queries.length, 1)
  assert.match(queries[0].text, /public\.settle_v105_prediction\(\$1::jsonb, \$2::jsonb\)/)
  assert.equal(queries[0].values[1].prediction_id, predictionId)
})

test('independent direct formal settlements use bounded concurrent priority queries and preserve per-item acknowledgements', async () => {
  const queries = []
  let active = 0
  let maxActive = 0
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    strategyPool: { async query(value) {
      queries.push(value)
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 20))
      active -= 1
      return { rows: [{ settle_v105_prediction: {
          persisted: true, roadmapDurable: true, predictionDurable: true,
          prediction_id: value.values[1].prediction_id,
      } }] }
    } },
  })
  const firstTable = table()
  const secondTable = { ...table(), tableId: 'BAG02' }
  const firstPrediction = { ...buildLivePrediction(firstTable), predictionId: '11111111-1111-1111-1111-111111111111' }
  const secondPrediction = { ...buildLivePrediction(secondTable), predictionId: '22222222-2222-2222-2222-222222222222' }
  await Promise.all([
    client.persistRound({ tableId: 'BAG01', shoe: 88, round: 21, rawResult: [1, 9, 2, 10, -1, -1, -1, -1, 3, 9] }, firstTable, firstPrediction),
    client.persistRound({ tableId: 'BAG02', shoe: 88, round: 21, rawResult: [3, 6, 4, 8, -1, -1, -1, -1, 7, 4] }, secondTable, secondPrediction),
  ])
  assert.equal(queries.length, 2)
  assert.equal(maxActive, 2)
  assert.ok(queries.every((query) => /public\.settle_v105_prediction\(\$1::jsonb, \$2::jsonb\)/.test(query.text)))
})

test('settlement fails closed unless the acknowledgement prediction_id exactly matches the issued prediction', async () => {
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

test('proxy exposes only the exact DB-issued screen-round payload, survives reconstruction, separates identity, and fails closed', async () => {
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
    async readIssuedPrediction({ tableId, shoe, round, strategyVersion }) {
      return structuredClone(firstByIdentity.get([tableId, shoe, round, strategyVersion].join(':')) ?? null)
    },
  }
  for (const exactTable of [table({ round: 19 }), table({ tableId: 'BAG02', round: 19 }), table({ shoe: 89, round: 19 })]) {
    const candidate = buildLivePrediction(exactTable)
    const key = [candidate.targetTableId, candidate.targetShoe, candidate.targetRound, candidate.strategyVersion].join(':')
    firstByIdentity.set(key, { ...candidate, predictionId: `pid-${key}`, issuedAt: '2026-07-16T01:00:01.000Z' })
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

test('admin main denominators exclude tie PUSH in SQL and fallback reports', async () => {
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

test('v102 readers require complete current final columns and exclude compatibility and pending rows', async () => {
  const requests = []
  const compatibility = { id: 'compatibility', table_id: 'BAG01', shoe_no: '88', round_no: 3, strategy_version: 'v105', predicted_result: 'banker', actual_result: 'banker', is_hit: true, settlement_final: null, side_hits: null, prediction_issued_at: '2026-07-16T00:59:00Z', prediction_features: { prediction_timing: 'pre_result_context', settlement_final: true, side_hits: { tie: false } }, created_at: '2026-07-16T01:00:00Z' }
  const modern = { ...compatibility, id: 'modern', round_no: 4, settlement_final: true, side_hits: { tie: true }, prediction_features: { prediction_timing: 'pre_result_context' }, created_at: '2026-07-16T01:01:00Z' }
  const pending = { ...modern, id: 'pending', round_no: 5, actual_result: null, is_hit: null, settlement_final: false }
  const client = createSupabaseIngestionClient({ url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false, fetchImpl: async (url) => { requests.push(new URL(url)); return response([modern, compatibility, pending]) } })
  assert.deepEqual((await client.getStablePredictionRows()).map((row) => row.id), ['modern'])
  assert.deepEqual((await client.getRecentPredictionRows()).map((row) => row.id), ['modern'])
  assert.deepEqual((await client.getTableUiSettledPredictions({ tableId: 'BAG01', shoe: 88 })).map((row) => row.round), [4])
  assert.equal(await client.countTodayPredictionRounds(), 1)
  for (const url of requests) {
    if (url.pathname.endsWith('/rpc/get_v105_recent_performance_rows')) {
      assert.equal(url.search, '')
      continue
    }
    assert.match(url.searchParams.get('select') ?? '', /settlement_final/)
    assert.equal(url.searchParams.get('strategy_version'), 'eq.v105')
    assert.equal(url.searchParams.get('settlement_final'), 'eq.true')
    assert.equal(url.searchParams.has('or'), false)
  }
})

test('fallback analytics use settlement_final columns and side_hits column with legacy fallback', () => {
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

test('issuance ACK identity is verified and issued prediction can be read exactly after restart', async () => {
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

test('final after restart and beyond display TTL settles exact DB issuance without issuing from post-result table', async () => {
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

test('missing or failed issuance lookup fails closed without settlement', async () => {
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

test('production settlement without predictionId fails closed instead of invoking legacy RPC', async () => {
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
