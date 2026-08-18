import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createSupabaseIngestionClient } from '../src/supabase-writer.js'

function response(rows) {
  return { ok: true, status: 200, json: async () => rows, text: async () => JSON.stringify(rows) }
}

test('v106 today prediction count queries and accepts only v106 final settlements', async () => {
  let requestedUrl
  const v102Row = { id: 'v106-final', strategy_version: 'v106', settlement_final: true, prediction_features: { settlement_final: true } }
  const oldRow = { id: 'v98-final', strategy_version: 'v98', settlement_final: true, prediction_features: { settlement_final: true } }
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-service-key',
    fetchImpl: async (url) => { requestedUrl = new URL(url); return response([v102Row, oldRow]) },
  })

  assert.equal(await client.countTodayPredictionRounds(), 1)
  assert.match(requestedUrl.searchParams.get('select') ?? '', /settlement_final/)
  assert.equal(requestedUrl.searchParams.get('strategy_version'), 'eq.v106')
  assert.equal(requestedUrl.searchParams.get('settlement_final'), 'eq.true')
  assert.equal(requestedUrl.searchParams.has('or'), false)
})

test('v106 stable report reads and accepts only complete v106 final settlements', async () => {
  let requestedUrl
  const finalRow = { table_id: 'BAG01', strategy_version: 'v106', settlement_final: true, prediction_features: { settlement_final: true }, created_at: '2026-07-15T08:03:00Z' }
  const oldVersionRow = { ...finalRow, strategy_version: 'v98', created_at: '2026-07-15T08:02:00Z' }
  const compatibilityRow = { ...finalRow, settlement_final: null, prediction_features: { settlement_final: true }, created_at: '2026-07-15T08:01:00Z' }
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-service-key',
    fetchImpl: async (url) => { requestedUrl = new URL(url); return response([finalRow, oldVersionRow, compatibilityRow]) },
  })

  assert.deepEqual(await client.getStablePredictionRows({ limit: 100 }), [finalRow])
  assert.match(requestedUrl.searchParams.get('select') ?? '', /settlement_final/)
  assert.equal(requestedUrl.searchParams.get('strategy_version'), 'eq.v106')
  assert.equal(requestedUrl.searchParams.get('settlement_final'), 'eq.true')
  assert.equal(requestedUrl.searchParams.has('or'), false)
})

test('recent calibration rows quarantine predictions without a verified final settlement marker', async () => {
  let requestedUrl
  let requestedInit
  const finalRow = {
    table_id: 'BAG01', shoe_no: '8', round_no: 3,
    strategy_version: 'v105', predicted_result: 'banker', actual_result: 'banker', is_hit: true,
    settlement_final: true, prediction_issued_at: '2026-07-15T08:02:00Z',
    prediction_features: { settlement_final: true, prediction_timing: 'pre_result_context' }, created_at: '2026-07-15T08:03:00Z',
  }
  const legacyRow = {
    ...finalRow, round_no: 2, actual_result: 'player', is_hit: false,
    settlement_final: null, prediction_features: { settlement_final: true }, created_at: '2026-07-15T08:02:00Z',
  }
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-service-key',
    fetchImpl: async (url, init) => { requestedUrl = new URL(url); requestedInit = init; return response([finalRow, legacyRow]) },
  })

  assert.deepEqual(await client.getRecentPredictionRows({ limit: 100 }), [finalRow])
  assert.equal(requestedUrl.pathname, '/rest/v1/rpc/get_v105_recent_performance_rows')
  assert.equal(requestedInit.method, 'POST')
  assert.deepEqual(JSON.parse(requestedInit.body), { p_per_table_limit: 60 })
})

test('v102 recent calibration reads and accepts only v102 settlements', async () => {
  let requestedUrl
  let requestedInit
  const v102Row = {
    table_id: 'BAG01', shoe_no: '100', round_no: 2,
    strategy_version: 'v105', predicted_result: 'banker', actual_result: 'banker', is_hit: true,
    settlement_final: true, prediction_issued_at: '2026-07-18T08:01:00Z',
    prediction_features: { settlement_final: true, prediction_timing: 'pre_result_context' }, created_at: '2026-07-18T08:02:00Z',
  }
  const v98Row = {
    ...v102Row, round_no: 1, strategy_version: 'v98', created_at: '2026-07-18T08:01:00Z',
  }
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-service-key',
    fetchImpl: async (url, init) => { requestedUrl = new URL(url); requestedInit = init; return response([v102Row, v98Row]) },
  })

  assert.deepEqual(await client.getRecentPredictionRows({ limit: 100 }), [v102Row])
  assert.equal(requestedUrl.pathname, '/rest/v1/rpc/get_v105_recent_performance_rows')
  assert.equal(requestedInit.method, 'POST')
  assert.deepEqual(JSON.parse(requestedInit.body), { p_per_table_limit: 60 })
})

test('v102 recent calibration rejects post-result or non-issued history', async () => {
  const causal = {
    id: 'causal', table_id: 'BAG01', shoe_no: '100', round_no: 3,
    strategy_version: 'v105', predicted_result: 'banker', actual_result: 'banker', is_hit: true,
    settlement_final: true, prediction_issued_at: '2026-07-18T08:02:00Z',
    prediction_features: { prediction_timing: 'pre_result_context' }, created_at: '2026-07-18T08:03:00Z',
  }
  const postResult = {
    ...causal, id: 'post-result', round_no: 2, prediction_features: { prediction_timing: 'post_result_context' },
  }
  const notIssued = { ...causal, id: 'not-issued', round_no: 1, prediction_issued_at: null }
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-service-key',
    fetchImpl: async () => response([causal, postResult, notIssued]),
  })

  assert.deepEqual((await client.getRecentPredictionRows({ limit: 60 })).map((row) => row.id), ['causal'])
})
