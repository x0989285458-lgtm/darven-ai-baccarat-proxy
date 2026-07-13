import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  buildCompactPredictionResultDbRow,
  buildCompactRoadmapEventDbRow,
  buildLivePrediction,
  buildPredictionResultRow,
  buildRoadmapEventRow,
  createSupabaseIngestionClient,
} from '../src/supabase-writer.js'
import { buildMemoryReportRow, createOnlineCoreClient } from '../src/online-core.js'
import { writeLocalBacktestResult } from '../src/local-backtest-store.js'

const round = {
  tableId: 'BAG03',
  shoe: 912,
  round: 43,
  rawResult: [26, 20, 39, 23, 14, 0, -1, -1, 1, 7],
  winner: 2,
  sourceAction: '/api/v1/gametype/demo/game/demo/room/demo/table/demo/summary',
  cardShoe: {
    deckCount: 8,
    cardsSeenTotal: 28,
    cardsRemainingTotal: 388,
    shoeProgressRatio: 0.0673,
    remainingRankCounts: { A: 30, 2: 29, 3: 28, 4: 27, 5: 26, 6: 25, 7: 24, 8: 23, 9: 22, 10: 21, J: 20, Q: 19, K: 18 },
    remainingPointCounts: { 0: 80, 1: 30, 2: 29, 3: 28, 4: 27, 5: 26, 6: 25, 7: 24, 8: 23, 9: 22 },
  },
}

const table = {
  tableId: 'BAG03',
  displayName: 'MT 3',
  tableType: 'BAC',
  beadPlateRaw: '01#12#33#21#22',
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
  recentHitRate: 0.58,
  recentPredictionCount: 24,
}

test('v091 persistRound posts compact DB rows while full row builders retain complete local features', async () => {
  const requests = []
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co',
    serviceKey: 'sb_secret_test_key',
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) })
      return { ok: true, status: 201, text: async () => '' }
    },
  })

  const fullEvent = buildRoadmapEventRow(round, table)
  const pendingPrediction = buildLivePrediction({ ...table, shoe: round.shoe, round: round.round - 1 })
  const fullPrediction = buildPredictionResultRow(round, table, pendingPrediction)
  assert.ok(fullEvent.raw_event.tableSnapshot)
  assert.ok(fullEvent.road_features.beadPlateRaw)
  assert.ok(fullPrediction.prediction_features.road_features.beadPlateRaw)
  assert.ok(fullPrediction.prediction_features.side_weights.tie)
  assert.ok(fullPrediction.prediction_features.side_prediction_rank_inputs.tie)

  await client.persistRound(round, table, pendingPrediction)
  const atomicBody = requests.find((request) => request.url.includes('/rpc/persist_v098_settled_round')).body
  const eventBody = atomicBody.p_roadmap
  const predictionBody = atomicBody.p_prediction

  assert.deepEqual(eventBody, buildCompactRoadmapEventDbRow(fullEvent))
  assert.equal(eventBody.raw_event.tableSnapshot, undefined)
  assert.equal(eventBody.road_features, undefined)
  assert.deepEqual(eventBody.player_card_codes, [26, 39, 14])
  assert.deepEqual(eventBody.banker_card_codes, [20, 23, 0])
  assert.deepEqual(eventBody.remaining_rank_counts, round.cardShoe.remainingRankCounts)
  assert.deepEqual(eventBody.remaining_point_counts, round.cardShoe.remainingPointCounts)

  const expectedPredictionBody = buildCompactPredictionResultDbRow(fullPrediction)
  expectedPredictionBody.resolved_at = predictionBody.resolved_at
  assert.deepEqual(predictionBody, expectedPredictionBody)
  assert.ok(predictionBody.prediction_features.side_actions)
  assert.ok(predictionBody.prediction_features.side_hits)
  assert.ok(predictionBody.prediction_features.side_predictions)
  assert.ok(predictionBody.prediction_features.side_actual_results)
  assert.ok(predictionBody.prediction_features.side_results)
  assert.ok(predictionBody.prediction_features.point_features)
  assert.ok(predictionBody.prediction_features.table_performance)
  assert.ok(predictionBody.prediction_features.feature_summary)
  assert.equal(predictionBody.prediction_features.side_weights, undefined)
  assert.equal(predictionBody.prediction_features.side_prediction_rank_inputs, undefined)
  assert.equal(predictionBody.prediction_features.road_features, undefined)
  assert.equal(predictionBody.feature_weights, undefined)
  assert.equal(JSON.stringify(predictionBody).includes('beadPlateRaw'), false)
  assert.equal(JSON.stringify(predictionBody).includes('bigRoadRaw'), false)
})

test('v091 compact roadmap row never sends null for not-null JSONB remaining counts', () => {
  const event = buildRoadmapEventRow({ tableId: 'BAG09', shoe: 1, round: 1, winner: 'player' }, { tableId: 'BAG09' })
  const compact = buildCompactRoadmapEventDbRow(event)

  assert.deepEqual(compact.remaining_rank_counts, {})
  assert.deepEqual(compact.remaining_point_counts, { 0: null, 1: null, 2: null, 3: null, 4: null, 5: null, 6: null, 7: null, 8: null, 9: null })
})

test('v091 memory_test_reports row stores report summary and compact metadata only', () => {
  const row = buildMemoryReportRow({
    strategyVersion: 'v091',
    reportType: 'grid_backtest',
    total: { rounds: 200, hits: 104, misses: 90, pushes: 6, mainEvaluated: 194, hitRate: 53.6, sideActions: 40, sideHits: 12, sideHitRate: 30 },
    tables: [
      { tableId: 'BAG01', displayName: 'MT 1', rounds: 20, hits: 11, misses: 9, lastDiagnostics: { road: 'large' } },
    ],
    events: [{ no: 1, raw: 'large event body' }],
    metadata: {
      source: 'local_grid',
      targetRounds: 200,
      events: [{ no: 1 }],
      report: { raw: true },
      options: { tables: 9, mode: 'grid', nested: { skip: true } },
    },
  }, 'project-1')

  assert.equal(row.raw_summary.total.rounds, 200)
  assert.equal(row.raw_summary.tables.length, 1)
  assert.equal(row.raw_summary.events, undefined)
  assert.equal(row.raw_summary.tables[0].lastDiagnostics, undefined)
  assert.deepEqual(row.metadata, {
    source: 'local_grid',
    targetRounds: 200,
    options: { tables: 9, mode: 'grid' },
  })
})

test('v091 backtest and grid outputs can be stored in tmp/backtests without Supabase', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'baccarat-v091-backtests-'))
  const result = await writeLocalBacktestResult(
    { strategyVersion: 'v091', total: { rounds: 12, hits: 7 } },
    { outDir: dir, prefix: 'grid backtest', now: new Date('2026-07-10T00:00:00.000Z') },
  )
  const saved = JSON.parse(await readFile(result.filePath, 'utf8'))

  assert.equal(result.filePath.endsWith('grid-backtest-2026-07-10T00-00-00-000Z.json'), true)
  assert.equal(saved.storage, 'local_tmp_backtests')
  assert.equal(saved.result.total.rounds, 12)
})

test('v091 online core routes backtest/grid reports to local tmp files instead of memory_test_reports', async () => {
  const requests = []
  const dir = await mkdtemp(join(tmpdir(), 'baccarat-v091-online-backtests-'))
  const cwd = process.cwd()
  process.chdir(dir)
  try {
    const client = createOnlineCoreClient({
      url: 'https://example.supabase.co',
      serviceKey: 'sb_secret_test_key',
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init })
        return { ok: true, status: 201, text: async () => '', json: async () => [] }
      },
    })

    const result = await client.persistTestReport({ reportType: 'grid_backtest', total: { rounds: 99, hits: 52 } })
    const saved = JSON.parse(await readFile(result.filePath, 'utf8'))

    assert.equal(result.ok, true)
    assert.equal(saved.storage, 'local_tmp_backtests')
    assert.equal(saved.result.total.rounds, 99)
    assert.equal(requests.length, 0)
  } finally {
    process.chdir(cwd)
  }
})

test('v092 real MT card array is retained and pair flags use rank instead of baccarat point', () => {
  const row = buildRoadmapEventRow({
    tableId: 'BAG08',
    shoe: 7788,
    round: 21,
    // 閒前兩張 J/Q 都是 0 點但不同 rank，不可誤判閒對；莊 10/10 同 rank 才是莊對。
    rawResult: [11, 10, 12, 23, -1, -1, -1, -1, 0, 0],
    winner: 'tie',
  }, { tableId: 'BAG08' })
  const compact = buildCompactRoadmapEventDbRow(row)

  assert.deepEqual(compact.raw_event.rawResult, [11, 10, 12, 23, -1, -1, -1, -1, 0, 0])
  assert.deepEqual(compact.player_card_codes, [11, 12, 0])
  assert.deepEqual(compact.banker_card_codes, [10, 23, 0])
  assert.deepEqual(compact.player_card_ranks, [11, 12, null])
  assert.deepEqual(compact.banker_card_ranks, [10, 10, null])
  assert.equal(compact.player_pair, false)
  assert.equal(compact.banker_pair, true)
})

test('v092 Supabase writer serializes retries and skips duplicate actual rounds in one process', async () => {
  const requests = []
  let activeRequests = 0
  let maxActiveRequests = 0
  let failOnce = true
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co',
    serviceKey: 'sb_secret_test_key',
    retryDelayMs: 1,
    fetchImpl: async (url, init) => {
      activeRequests += 1
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests)
      await new Promise((resolve) => setTimeout(resolve, 2))
      requests.push({ url: String(url), body: JSON.parse(init.body) })
      activeRequests -= 1
      if (failOnce && String(url).includes('/rpc/persist_v098_settled_round')) {
        failOnce = false
        return { ok: false, status: 503, text: async () => 'temporary unavailable' }
      }
      return { ok: true, status: 201, text: async () => '' }
    },
  })

  await Promise.all([
    client.persistRound(round, table, buildLivePrediction({ ...table, shoe: round.shoe, round: round.round - 1 })),
    client.persistRound({ ...round }, { ...table }, buildLivePrediction({ ...table, shoe: round.shoe, round: round.round - 1 })),
    client.persistRound({ ...round, rawResult: [...round.rawResult] }, { ...table }, buildLivePrediction({ ...table, shoe: round.shoe, round: round.round - 1 })),
  ])

  assert.equal(maxActiveRequests, 1)
  assert.equal(requests.filter((request) => request.url.includes('/rpc/persist_v098_settled_round')).length, 2)
  assert.deepEqual(requests[1].body, requests[0].body)
})
