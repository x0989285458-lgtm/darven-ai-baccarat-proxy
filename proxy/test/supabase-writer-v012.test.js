import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildDefaultEqualStrategy,
  buildRoadmapEventRow,
  buildPredictionResultRow,
  createSupabaseIngestionClient,
  deriveBaccaratRoundFacts,
} from '../src/supabase-writer.js'

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

test('v012 builds equal default strategy weights for every judgement feature group', () => {
  const strategy = buildDefaultEqualStrategy()
  assert.equal(strategy.version, 'v012_equal_weight_seed')
  assert.equal(strategy.status, 'active')
  assert.deepEqual(strategy.weights, {
    bead_road: 0.125,
    big_road: 0.125,
    derived_roads: 0.125,
    ask_road: 0.125,
    card_points: 0.125,
    shoe_remaining_points: 0.125,
    pattern_tags: 0.125,
    historical_backtest: 0.125,
  })
})

test('v012 derives card points, draw/natural flags, super six and dragon-bonus booleans from round result', () => {
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

test('v012 builds Supabase roadmap and prediction rows for short-retention learning data', () => {
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

  assert.equal(prediction.strategy_version, 'v050_all_mt_equal_weight')
  assert.equal(prediction.predicted_result, 'banker')
  assert.equal(prediction.actual_result, 'banker')
  assert.equal(prediction.is_hit, true)
  assert.equal(prediction.probabilities.banker >= prediction.probabilities.player, true)
  assert.equal(Object.keys(prediction.feature_weights).includes('next_banker_road'), true)
  assert.equal(Object.keys(prediction.prediction_features.side_weights).includes('tie_risk'), true)
})

test('v012 Supabase client posts strategy, roadmap event and prediction result with service key headers', async () => {
  const requests = []
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co',
    serviceKey: 'sb_secret_test_key',
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init })
      return { ok: true, status: 201, text: async () => '' }
    },
  })

  await client.ensureInitialStrategy()
  await client.persistRound(round, table)

  assert.equal(requests.length, 3)
  assert.equal(requests[0].url.includes('/rest/v1/ai_strategy_versions'), true)
  assert.equal(requests[1].url.includes('/rest/v1/daily_roadmap_events'), true)
  assert.equal(requests[2].url.includes('/rest/v1/daily_prediction_results'), true)
  assert.equal(requests[1].init.headers.Authorization, 'Bearer sb_secret_test_key')
})
