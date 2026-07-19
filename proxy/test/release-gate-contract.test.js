import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createApp } from '../src/server.js'
import { createCloudCaptureClient } from '../src/cloud-capture.js'
import { buildLivePrediction, buildPredictionResultRow, deriveBaccaratRoundFacts } from '../src/supabase-writer.js'

const table = {
  tableId: 'BAG01', shoe: 88, round: 20,
  bankerCount: 10, playerCount: 9, tieCount: 1,
  bankerPairCount: 2, playerPairCount: 1,
  beadPlateRaw: '0102', bigRoadRaw: '0102', bigEyeRaw: '12', smallRoadRaw: '21', cockroachRaw: '11',
  nextBankerRaw: '1', nextPlayerRaw: '2',
  lastRound: { tableId: 'BAG01', shoe: 88, round: 20, winner: 'player', playerPoint: 8, bankerPoint: 3 },
  cardShoe: { remainingRankCounts: { A: 31 }, remainingPointCounts: { 0: 120, 1: 31 }, cardsSeenTotal: 10, cardsRemainingTotal: 406 },
}

const completed = {
  tableId: 'BAG01', shoe: 88, round: 21, winner: 'banker',
  rawResult: [1, 9, 2, 10, -1, -1, -1, -1, 1, 9],
  sourceAction: '/api/v1/gametype/*/game/*/room/*/table/*/summary',
}

test('pending snapshot contains all pre-result probability score MT derived and card features and settlement only appends outcome fields', () => {
  const pending = buildLivePrediction(table)
  const frozen = structuredClone(pending)
  const changedAfterReveal = { ...table, bankerCount: 999, playerCount: 0, beadPlateRaw: '999999', cardShoe: { remainingRankCounts: { K: 1 } } }

  const row = buildPredictionResultRow(completed, changedAfterReveal, pending)

  assert.equal(pending.buildVersion, 'v101')
  assert.ok(pending.probabilities)
  assert.ok(pending.scoreTotals)
  assert.ok(pending.scoreSources)
  for (const key of ['mt_context', 'derived_main_features', 'unified_main_scores', 'road_features', 'card_shoe_features', 'side_card_rank_features', 'side_prediction_rank_inputs']) {
    assert.ok(pending.predictionFeatures?.[key], `missing ${key}`)
  }
  assert.deepEqual(pending, frozen)
  assert.deepEqual(row.probabilities, frozen.probabilities)
  assert.deepEqual(row.prediction_features.mt_context, frozen.predictionFeatures.mt_context)
  assert.deepEqual(row.prediction_features.derived_main_features, frozen.predictionFeatures.derived_main_features)
  assert.deepEqual(row.prediction_features.card_shoe_features, frozen.predictionFeatures.card_shoe_features)
  assert.deepEqual(
    Object.keys(row.prediction_features).filter((key) => !(key in frozen.predictionFeatures)).sort(),
    ['settlement_final', 'settlement_source_action', 'side_actual_results', 'side_hits'],
  )
})

test('expired pending is deleted by API and the same target is tombstoned instead of rebuilt', async () => {
  let clock = 1_000_000
  let writes = 0
  const app = createApp({
    autoConnect: false,
    now: () => clock,
    predictionTtlMs: 30_000,
    supabaseClient: { configured: true, ensureInitialStrategy: async () => {}, persistRound: async () => { writes += 1 } },
  })
  app.state.setTables([table])
  assert.equal(JSON.parse((await app.inject({ url: '/api/tables' })).body)[0].prediction.targetRound, 20)

  clock += 30_001
  assert.equal(JSON.parse((await app.inject({ url: '/api/tables' })).body)[0].prediction, null)
  app.state.setTables([table])
  assert.equal(JSON.parse((await app.inject({ url: '/api/tables' })).body)[0].prediction, null)
  app.state.upsertRoundEvent(completed)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(writes, 0)
})

test('cloud worker fetch rejects redirects', async () => {
  let init
  const client = createCloudCaptureClient({
    url: 'https://worker.example/snapshot',
    state: { setStatus() {}, setTables() {}, upsertRoundEvent() {} },
    requestRetries: 1,
    fetchImpl: async (_url, options) => {
      init = options
      return { ok: true, json: async () => ({ buildVersion: '100', tables: [], rounds: [] }) }
    },
  })

  await client.tick()

  assert.equal(init.redirect, 'error')
})

test('preserves the approved Dragon Bonus actual-result rule', () => {
  assert.equal(deriveBaccaratRoundFacts({ winner: 'banker', playerPoint: 2, bankerPoint: 7 }).bankerDragon, true)
  assert.equal(deriveBaccaratRoundFacts({ winner: 'banker', playerPoint: 4, bankerPoint: 7 }).bankerDragon, false)
  assert.equal(deriveBaccaratRoundFacts({ winner: 'player', playerPoint: 8, bankerPoint: 3 }).playerDragon, true)
  assert.equal(deriveBaccaratRoundFacts({ winner: 'player', playerPoint: 9, bankerPoint: 6 }).playerDragon, false)
})

test('formal stable report uses saved rows and retired live predictors are absent', () => {
  const source = readFileSync(new URL('../scripts/stable-capture-report.mjs', import.meta.url), 'utf8')
  assert.match(source, /buildStableReportFromRows/)
  assert.doesNotMatch(source, /createStableReportSession|evaluateFiveRoadPrediction|buildLivePrediction/)
  assert.match(source, /stable-report\/rows/)
  assert.equal(existsSync(new URL('../scripts/live-200-report.mjs', import.meta.url)), false)
  assert.equal(existsSync(new URL('../scripts/delta-200-report.mjs', import.meta.url)), false)
})
