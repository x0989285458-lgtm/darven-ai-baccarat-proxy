import test from 'node:test'
import assert from 'node:assert/strict'
import { createSupabaseIngestionClient } from '../src/supabase-writer.js'

function response(rows) {
  return { ok: true, status: 200, json: async () => rows, text: async () => JSON.stringify(rows) }
}

function rawEvent(round, rawResult, winner, sourceAction = '/api/v1/gametype/*/game/*/room/*/table/*/summary') {
  return { tableId: 'BAG01', shoe: 88, round, winner, rawResult, sourceAction }
}

test('v098.18 settled prediction getter returns only immutable formal same-shoe rows newest first and keeps tie misses', async () => {
  let requestedUrl
  const rows = [
    { table_id: 'BAG01', shoe_no: '88', round_no: 5, strategy_version: 'v100', predicted_result: 'player', actual_result: 'banker', is_hit: false, prediction_features: { prediction_timing: 'pre_result_context' }, created_at: '2026-07-15T05:00:00Z' },
    { table_id: 'BAG01', shoe_no: '88', round_no: 4, strategy_version: 'v100', predicted_result: 'banker', actual_result: 'tie', is_hit: false, prediction_features: { prediction_timing: 'pre_result_context', settlement_final: true }, created_at: '2026-07-15T04:00:00Z' },
    { table_id: 'BAG01', shoe_no: '88', round_no: 3, strategy_version: 'v100', predicted_result: 'player', actual_result: 'player', is_hit: true, prediction_features: { prediction_timing: 'pre_result_context', settlement_final: true }, created_at: '2026-07-15T03:00:00Z' },
    { table_id: 'BAG01', shoe_no: '88', round_no: 2, strategy_version: 'v097_副預測命中校準與門檻降5版', predicted_result: 'banker', actual_result: 'banker', is_hit: true, prediction_features: { prediction_timing: 'pre_result_context', settlement_final: true }, created_at: '2026-07-15T02:00:00Z' },
    { table_id: 'BAG01', shoe_no: '88', round_no: 1, strategy_version: 'v100', predicted_result: 'banker', actual_result: 'banker', is_hit: true, prediction_features: { prediction_timing: 'post_result_context' }, created_at: '2026-07-15T01:00:00Z' },
  ]
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co',
    serviceKey: 'test-service-key',
    fetchImpl: async (url) => { requestedUrl = new URL(url); return response(rows) },
  })

  const actual = await client.getTableUiSettledPredictions({ tableId: 'BAG01', shoe: 88, limit: 10 })

  assert.deepEqual(actual, [
    { round: 4, predictedResult: 'banker', actualResult: 'tie', isHit: false },
    { round: 3, predictedResult: 'player', actualResult: 'player', isHit: true },
  ])
  assert.equal(requestedUrl.pathname, '/rest/v1/daily_prediction_results')
  assert.equal(requestedUrl.searchParams.get('table_id'), 'eq.BAG01')
  assert.equal(requestedUrl.searchParams.get('shoe_no'), 'eq.88')
  assert.equal(requestedUrl.searchParams.get('strategy_version'), 'eq.v100')
  assert.equal(requestedUrl.searchParams.get('order'), 'created_at.desc')
  assert.equal(requestedUrl.searchParams.get('limit'), '100')
})

test('v100 table UI history reads and accepts only v100 settlements', async () => {
  let requestedUrl
  const v100Row = {
    table_id: 'BAG01', shoe_no: '100', round_no: 2, strategy_version: 'v100',
    predicted_result: 'player', actual_result: 'player', is_hit: true, settlement_final: true,
    prediction_features: { prediction_timing: 'pre_result_context', settlement_final: true },
    created_at: '2026-07-18T08:02:00Z',
  }
  const v98Row = {
    ...v100Row, round_no: 1, strategy_version: 'v98', created_at: '2026-07-18T08:01:00Z',
  }
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-service-key',
    fetchImpl: async (url) => { requestedUrl = new URL(url); return response([v100Row, v98Row]) },
  })

  assert.deepEqual(await client.getTableUiSettledPredictions({ tableId: 'BAG01', shoe: 100, limit: 10 }), [
    { round: 2, predictedResult: 'player', actualResult: 'player', isHit: true },
  ])
  assert.equal(requestedUrl.searchParams.get('strategy_version'), 'eq.v100')
})

test('v098.18 settled prediction getter fetches enough rows to return ten valid latest settlements', async () => {
  const invalid = [
    { table_id: 'BAG01', shoe_no: '88', round_no: 12, strategy_version: 'v100', predicted_result: 'banker', actual_result: 'banker', is_hit: true, prediction_features: { prediction_timing: 'post_result_context' }, created_at: '2026-07-15T12:00:00Z' },
    { table_id: 'BAG01', shoe_no: '88', round_no: 11, strategy_version: 'v100', predicted_result: 'player', actual_result: 'player', is_hit: null, prediction_features: { prediction_timing: 'pre_result_context', settlement_final: true }, created_at: '2026-07-15T11:00:00Z' },
  ]
  const valid = Array.from({ length: 10 }, (_, index) => {
    const round = 10 - index
    return { table_id: 'BAG01', shoe_no: '88', round_no: round, strategy_version: 'v100', predicted_result: 'banker', actual_result: 'banker', is_hit: true, prediction_features: { prediction_timing: 'pre_result_context', settlement_final: true }, created_at: `2026-07-15T${String(round).padStart(2, '0')}:00:00Z` }
  })
  let requestedLimit = 0
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co',
    serviceKey: 'test-service-key',
    fetchImpl: async (url) => {
      requestedLimit = Number(new URL(url).searchParams.get('limit'))
      return response([...invalid, ...valid].slice(0, requestedLimit))
    },
  })

  const actual = await client.getTableUiSettledPredictions({ tableId: 'BAG01', shoe: 88, limit: 10 })

  assert.equal(actual.length, 10)
  assert.deepEqual(actual.map((row) => row.round), [10, 9, 8, 7, 6, 5, 4, 3, 2, 1])
  assert.ok(requestedLimit > 10)
})

test('v098.18 settled prediction getter dedupes identical same-round rows and rejects conflicts', async () => {
  const base = { table_id: 'BAG01', shoe_no: '88', round_no: 7, strategy_version: 'v100', predicted_result: 'banker', actual_result: 'banker', is_hit: true, prediction_features: { prediction_timing: 'pre_result_context', settlement_final: true }, created_at: '2026-07-15T07:00:00Z' }
  const identicalClient = createSupabaseIngestionClient({
    url: 'https://example.supabase.co',
    serviceKey: 'test-service-key',
    fetchImpl: async () => response([base, structuredClone(base)]),
  })
  assert.deepEqual(await identicalClient.getTableUiSettledPredictions({ tableId: 'BAG01', shoe: 88, limit: 10 }), [
    { round: 7, predictedResult: 'banker', actualResult: 'banker', isHit: true },
  ])

  const conflictClient = createSupabaseIngestionClient({
    url: 'https://example.supabase.co',
    serviceKey: 'test-service-key',
    fetchImpl: async () => response([base, { ...base, actual_result: 'player', is_hit: false }]),
  })
  await assert.rejects(
    conflictClient.getTableUiSettledPredictions({ tableId: 'BAG01', shoe: 88, limit: 10 }),
    /conflicting settled prediction round 7/,
  )
})

test('v098.18 real-card getter revalidates exact10, dedupes identical rows, and stops at the first gap', async () => {
  const round1 = rawEvent(1, [11, 25, 7, 19, 0, 0, -1, -1, 4, 6], 'banker')
  const round2 = rawEvent(2, [12, 26, 8, 20, 0, 0, -1, -1, 6, 6], 'tie')
  const invalidRound3 = rawEvent(3, [1, 2, 3], 'player')
  const round4 = rawEvent(4, [13, 27, 9, 21, 0, 0, -1, -1, 8, 7], 'player')
  let requestedUrl
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co',
    serviceKey: 'test-service-key',
    fetchImpl: async (url) => {
      requestedUrl = new URL(url)
      return response([
        { table_id: 'BAG01', shoe_no: '88', round_no: 4, raw_event: round4 },
        { table_id: 'BAG01', shoe_no: '88', round_no: 2, raw_event: round2 },
        { table_id: 'BAG01', shoe_no: '88', round_no: 1, raw_event: round1 },
        { table_id: 'BAG01', shoe_no: '88', round_no: 1, raw_event: structuredClone(round1) },
        { table_id: 'BAG01', shoe_no: '88', round_no: 3, raw_event: invalidRound3 },
      ])
    },
  })

  const actual = await client.getTableUiRealCardRounds({ tableId: 'BAG01', shoe: 88, limit: 100 })

  assert.deepEqual(actual, {
    rounds: [
      { round: 1, result: 'banker', bankerPoint: 6, playerPoint: 4 },
      { round: 2, result: 'tie', bankerPoint: 6, playerPoint: 6 },
    ],
    completeThroughRound: 2,
  })
  assert.equal(requestedUrl.pathname, '/rest/v1/cloud_table_rounds')
  assert.equal(requestedUrl.searchParams.get('table_id'), 'eq.BAG01')
  assert.equal(requestedUrl.searchParams.get('shoe_no'), 'eq.88')
  assert.equal(requestedUrl.searchParams.get('order'), 'round_no.asc')
})

test('v098.19 real-card getter quarantines provisional show_poker and stops before the resulting gap', async () => {
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co',
    serviceKey: 'test-service-key',
    fetchImpl: async () => response([
      { table_id: 'BAG01', shoe_no: '88', round_no: 1, raw_event: rawEvent(1, [11, 25, 7, 19, 0, 0, -1, -1, 4, 6], 'banker') },
      { table_id: 'BAG01', shoe_no: '88', round_no: 2, raw_event: rawEvent(2, [31, 51, 25, 52, 0, 0, -1, -1, 5, 0], 'player', '/api/v1/gametype/*/game/*/room/*/table/*/show_poker') },
      { table_id: 'BAG01', shoe_no: '88', round_no: 3, raw_event: rawEvent(3, [12, 26, 8, 20, 0, 0, -1, -1, 6, 6], 'tie') },
    ]),
  })

  assert.deepEqual(await client.getTableUiRealCardRounds({ tableId: 'BAG01', shoe: 88, limit: 100 }), {
    rounds: [{ round: 1, result: 'banker', bankerPoint: 6, playerPoint: 4 }],
    completeThroughRound: 1,
  })
})

test('v098.18 real-card getter fails closed on conflicting duplicate rounds', async () => {
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co',
    serviceKey: 'test-service-key',
    fetchImpl: async () => response([
      { table_id: 'BAG01', shoe_no: '88', round_no: 1, raw_event: rawEvent(1, [11, 25, 7, 19, 0, 0, -1, -1, 4, 6], 'banker') },
      { table_id: 'BAG01', shoe_no: '88', round_no: 1, raw_event: rawEvent(1, [11, 25, 7, 19, 0, 0, -1, -1, 7, 6], 'player') },
    ]),
  })

  await assert.rejects(
    client.getTableUiRealCardRounds({ tableId: 'BAG01', shoe: 88, limit: 100 }),
    /conflicting real-card round/,
  )
})
