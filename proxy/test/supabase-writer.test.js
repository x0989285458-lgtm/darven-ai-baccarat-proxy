import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildLivePrediction,
  buildRoadmapEventRow,
  createSupabaseIngestionClient,
  deriveBaccaratRoundFacts,
} from '../src/supabase-writer.js'
import { buildPredictionResultRow } from './helpers/prediction-result.js'

const round = {
  tableId: 'BAG03',
  shoe: 912,
  round: 43,
  rawResult: [26, 20, 39, 23, 14, 0, -1, -1, 1, 7],
  winner: 2,
  sourceAction: '/api/v1/gametype/*/game/*/room/*/table/*/summary',
}

const table = {
  tableId: 'BAG03',
  shoe: 912,
  round: 42,
  displayName: 'MT百家樂第3桌',
  tableType: 'BAC',
  beadPlateRaw: '01#12#33',
  bigRoadRaw: '0101,#0202',
  bigEyeRaw: '111',
  smallRoadRaw: '222',
  cockroachRaw: '111',
  nextBankerRaw: '111',
  nextPlayerRaw: '222',
  bankerCount: 15,
  playerCount: 13,
  tieCount: 3,
  bankerPairCount: 2,
  playerPairCount: 1,
}

test('v102 derives card points, draw and natural flags, super six and dragon bonus facts', () => {
  const facts = deriveBaccaratRoundFacts(round)
  assert.deepEqual(facts.playerCardCodes, [26, 39, 14])
  assert.deepEqual(facts.bankerCardCodes, [20, 23, 0])
  assert.deepEqual(facts.playerCardPoints, [0, 0, 1])
  assert.deepEqual(facts.bankerCardPoints, [7, 0, null])
  assert.equal(facts.playerPoint, 1)
  assert.equal(facts.bankerPoint, 7)
  assert.equal(facts.winner, 'banker')
  assert.equal(facts.playerDrew, true)
  assert.equal(facts.bankerDrew, false)
  assert.equal(facts.playerNatural, false)
  assert.equal(facts.bankerNatural, false)
  assert.equal(facts.superSix, false)
  assert.equal(facts.bankerDragon, true)
  assert.equal(facts.playerDragon, false)
})

test('builds Supabase roadmap and prediction rows for short-retention learning data', () => {
  const event = buildRoadmapEventRow(round, table)
  const prediction = buildPredictionResultRow(round, table)

  assert.equal(event.table_id, 'BAG03')
  assert.equal(event.shoe_no, '912')
  assert.equal(event.round_no, 43)
  assert.equal(event.main_result, 'banker')
  assert.deepEqual(event.player_card_points, [0, 0, 1])
  assert.deepEqual(event.banker_card_points, [7, 0, null])
  assert.equal(event.banker_dragon, true)
  assert.equal(event.player_dragon, false)
  assert.equal(event.super_six, false)
  assert.equal(event.raw_event.sourceAction.includes('summary'), true)

  assert.equal(prediction.strategy_version, 'v105')
  assert.ok(['banker', 'player'].includes(prediction.predicted_result))
  assert.equal(prediction.actual_result, 'banker')
  assert.equal(typeof prediction.is_hit, 'boolean')
  assert.equal(typeof prediction.probabilities.banker, 'number')
  assert.equal(typeof prediction.probabilities.player, 'number')
  assert.equal(Object.keys(prediction.feature_weights).includes('neutral_reserve'), true)
  assert.equal(Object.keys(prediction.prediction_features.side_weights.tie).includes('tie_risk'), true)
})

test('Supabase client posts strategy, roadmap event and prediction result with service key headers', async () => {
  const requests = []
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co',
    serviceKey: 'sb_secret_test_key',
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init })
      if (init.method === 'GET') {
        return { ok: true, json: async () => [{ version: buildLivePrediction(table).strategyVersion, status: 'active' }], text: async () => '' }
      }
      return String(url).includes('/rpc/persist_v105_settled_round')
        ? { ok: true, status: 200, text: async () => JSON.stringify({ persisted: true, roadmapDurable: true, predictionDurable: true }) }
        : { ok: true, status: 201, text: async () => '' }
    },
  })

  await client.ensureInitialStrategy()
  await client.persistRound(round, table, buildLivePrediction(table))

  assert.equal(requests.length, 4)
  assert.equal(requests[0].url.includes('/rest/v1/ai_strategy_versions'), true)
  assert.equal(requests[0].init.method, 'PATCH')
  assert.equal(requests[1].url.includes('/rest/v1/ai_strategy_versions'), true)
  assert.equal(requests[1].init.method, 'POST')
  assert.equal(requests[2].url.includes('/rest/v1/ai_strategy_versions'), true)
  assert.equal(requests[2].init.method, 'GET')
  assert.equal(requests[3].url.includes('/rest/v1/rpc/persist_v105_settled_round'), true)
  assert.equal(requests[3].init.headers.Authorization, 'Bearer sb_secret_test_key')
})

test('persistRound returns exact issued identity for durable and same-process duplicate receipts', async () => {
  const issued = {
    ...buildLivePrediction(table),
    predictionId: '11111111-1111-4111-8111-111111111111',
    issuedAt: '2026-08-26T19:00:00.000Z',
  }
  let writes = 0
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co',
    serviceKey: 'sb_secret_test_key',
    requireVerifiedStrategy: false,
    retryAttempts: 1,
    fetchImpl: async (url) => {
      assert.equal(String(url).includes('/rpc/settle_v105_prediction'), true)
      writes += 1
      return { ok: true, status: 200, text: async () => JSON.stringify({
        persisted: true,
        roadmapDurable: true,
        predictionDurable: true,
        prediction_id: issued.predictionId,
      }) }
    },
  })

  const first = await client.persistRound(round, table, issued)
  const duplicate = await client.persistRound(round, table, issued)

  for (const receipt of [first, duplicate]) {
    assert.equal(receipt.prediction.predictionId, issued.predictionId)
    assert.equal(receipt.prediction.table_id, issued.targetTableId)
    assert.equal(receipt.prediction.shoe_no, String(issued.targetShoe))
    assert.equal(receipt.prediction.round_no, issued.targetRound)
    assert.equal(receipt.prediction.strategy_version, issued.strategyVersion)
  }
  assert.equal(duplicate.skipped, true)
  assert.equal(duplicate.reason, 'duplicate_round')
  assert.equal(writes, 1)
})

test('formal lifecycle writes preserve same-table order while using bounded cross-table concurrency', async () => {
  const delayMs = 8
  let active = 0
  let maxActive = 0
  const calls = []
  let candidates = new Map()
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co',
    serviceKey: 'sb_secret_test_key',
    retryAttempts: 1,
    requireVerifiedStrategy: false,
    formalLifecycleConcurrency: 4,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body)
      const reconcile = String(url).includes('/rpc/reconcile_v105_prediction_lifecycle')
      const tableId = reconcile ? body.p_table_id : body.p_prediction.table_id
      const operation = reconcile ? 'reconcile' : 'issue'
      active += 1
      maxActive = Math.max(maxActive, active)
      calls.push(`${tableId}:${operation}:start`)
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      calls.push(`${tableId}:${operation}:end`)
      active -= 1
      if (reconcile) {
        return { ok: true, status: 200, text: async () => JSON.stringify({
          source: body.p_source,
          table_id: tableId,
          current_shoe: body.p_current_shoe,
          current_visible_round: body.p_current_visible_round,
          pending: 0,
          expired_no_final: 0,
          abandoned_shoe_change: 0,
          updated_total: 0,
        }) }
      }
      const predictionId = `pid-${tableId}`
      const issuedAt = '2026-08-26T17:00:00.000Z'
      return { ok: true, status: 200, text: async () => JSON.stringify({
        prediction_id: predictionId,
        prediction_issued_at: issuedAt,
        prediction: { ...candidates.get(tableId), predictionId, issuedAt },
      }) }
    },
  })
  const tables = ['BAG01', 'BAG02', 'BAG03', 'BAG03A', 'BAG05', 'BAG06', 'BAG07', 'BAG08', 'BAG09', 'BAG10']
    .map((tableId, index) => ({ ...table, tableId, shoe: 100, round: index + 1 }))
  candidates = new Map(tables.map((currentTable) => [currentTable.tableId, buildLivePrediction(currentTable)]))

  await Promise.all(tables.map((currentTable) => Promise.all([
    client.reconcilePredictionLifecycle({
      source: 'ofalive99',
      tableId: currentTable.tableId,
      currentShoe: currentTable.shoe,
      currentVisibleRound: currentTable.round,
    }),
    client.issuePrediction(candidates.get(currentTable.tableId)),
  ])))

  assert.ok(maxActive >= 2, `cross-table writes stayed globally serialized: maxActive=${maxActive}`)
  assert.ok(maxActive <= 4, `formal write concurrency exceeded the configured bound: maxActive=${maxActive}`)
  for (const currentTable of tables) {
    const prefix = `${currentTable.tableId}:`
    assert.deepEqual(calls.filter((value) => value.startsWith(prefix)), [
      `${prefix}reconcile:start`,
      `${prefix}reconcile:end`,
      `${prefix}issue:start`,
      `${prefix}issue:end`,
    ])
  }
})

test('formal lifecycle keyed tail continues after a rejected operation', async () => {
  let requests = 0
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'sb_secret_test_key', retryAttempts: 1,
    requireVerifiedStrategy: false, formalLifecycleConcurrency: 2,
    fetchImpl: async (_url, init) => {
      requests += 1
      const body = JSON.parse(init.body)
      if (requests === 1) return { ok: false, status: 500, text: async () => 'temporary failure' }
      return { ok: true, status: 200, text: async () => JSON.stringify({
        source: body.p_source, table_id: body.p_table_id,
        current_shoe: body.p_current_shoe, current_visible_round: body.p_current_visible_round,
        pending: 0, expired_no_final: 0, abandoned_shoe_change: 0, updated_total: 0,
      }) }
    },
  })
  const identity = { source: 'ofalive99', tableId: 'BAG01', currentShoe: 100, currentVisibleRound: 8 }

  await assert.rejects(client.reconcilePredictionLifecycle(identity), /temporary failure/)
  const acknowledgement = await client.reconcilePredictionLifecycle(identity)

  assert.equal(requests, 2)
  assert.equal(acknowledgement.counts.updatedTotal, 0)
})

test('formal lifecycle concurrency remains bounded by direct DB standard and priority budgets', async () => {
  let active = 0
  let reconcileMaxActive = 0
  let issueMaxActive = 0
  let candidates = new Map()
  const strategyPool = {
    async query(query) {
      const isIssue = /issue_v105_prediction/.test(query.text)
      active += 1
      if (isIssue) issueMaxActive = Math.max(issueMaxActive, active)
      else reconcileMaxActive = Math.max(reconcileMaxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 8))
      active -= 1
      if (!isIssue) {
        const [source, tableId, shoe, visibleRound] = query.values
        return { rows: [{ reconcile_v105_prediction_lifecycle: {
          source, table_id: tableId, current_shoe: shoe, current_visible_round: visibleRound,
          pending: 0, expired_no_final: 0, abandoned_shoe_change: 0, updated_total: 0,
        } }] }
      }
      const row = query.values[0]
      const candidate = candidates.get(row.table_id)
      const predictionId = `pid-${row.table_id}`
      const issuedAt = '2026-08-26T17:00:00.000Z'
      return { rows: [{ issue_v105_prediction: {
        prediction_id: predictionId, prediction_issued_at: issuedAt,
        prediction: { ...candidate, predictionId, issuedAt },
      } }] }
    },
  }
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'sb_secret_test_key',
    fetchImpl: async () => { throw new Error('Direct DB test must not use REST') },
    strategyPool, retryAttempts: 1, requireVerifiedStrategy: false, formalLifecycleConcurrency: 4,
    strategyPriorityConcurrency: 3,
  })
  const tables = ['BAG01', 'BAG02', 'BAG03', 'BAG03A', 'BAG05', 'BAG06', 'BAG07', 'BAG08', 'BAG09', 'BAG10']
    .map((tableId, index) => ({ ...table, tableId, shoe: 101, round: index + 1 }))
  candidates = new Map(tables.map((currentTable) => [currentTable.tableId, buildLivePrediction(currentTable)]))

  await Promise.all(tables.map((currentTable) => client.reconcilePredictionLifecycle({
    source: 'ofalive99', tableId: currentTable.tableId,
    currentShoe: currentTable.shoe, currentVisibleRound: currentTable.round,
  })))
  assert.ok(reconcileMaxActive >= 2)
  assert.ok(reconcileMaxActive <= 4, `Direct DB standard work exceeded Formal bound: ${reconcileMaxActive}`)

  await Promise.all(tables.map((currentTable) => client.issuePrediction(candidates.get(currentTable.tableId))))
  assert.ok(issueMaxActive >= 2)
  assert.ok(issueMaxActive <= 3, `Direct DB priority work exceeded reserved priority budget: ${issueMaxActive}`)
})

test('direct DB priority concurrency accepts an explicit bounded value', async () => {
  let active = 0
  let maxActive = 0
  const candidates = new Map()
  const strategyPool = {
    async query(query) {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 8))
      active -= 1
      const row = query.values[0]
      const candidate = candidates.get(row.table_id)
      return { rows: [{ issue_v105_prediction: {
        prediction_id: `pid-${row.table_id}`,
        prediction_issued_at: '2026-08-26T17:00:00.000Z',
        prediction: { ...candidate, predictionId: `pid-${row.table_id}`, issuedAt: '2026-08-26T17:00:00.000Z' },
      } }] }
    },
  }
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'sb_secret_test_key', strategyPool,
    retryAttempts: 1, requireVerifiedStrategy: false, formalLifecycleConcurrency: 9,
    strategyPriorityConcurrency: 6,
  })
  const predictions = Array.from({ length: 9 }, (_, index) => buildLivePrediction({
    ...table, tableId: `BAG${index + 1}`, shoe: 101, round: index + 1,
  }))
  for (const prediction of predictions) candidates.set(prediction.targetTableId, prediction)

  await Promise.all(predictions.map((prediction) => client.issuePrediction(prediction)))
  assert.equal(maxActive, 6)
})

test('direct DB priority concurrency rejects values outside 1 through 8', () => {
  for (const strategyPriorityConcurrency of [0, 9, 10, 1.5, '6']) {
    assert.throws(
      () => createSupabaseIngestionClient({ strategyPriorityConcurrency }),
      /strategy priority concurrency.*1.*8/i,
    )
  }
})
