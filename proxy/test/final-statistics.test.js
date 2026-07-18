import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createSupabaseIngestionClient } from '../src/supabase-writer.js'

function response(rows) {
  return { ok: true, status: 200, json: async () => rows, text: async () => JSON.stringify(rows) }
}

test('v100 today prediction count queries and accepts only v100 final settlements', async () => {
  let requestedUrl
  const v100Row = { id: 'v100-final', strategy_version: 'v100', settlement_final: true, prediction_features: { settlement_final: true } }
  const oldRow = { id: 'v98-final', strategy_version: 'v98', settlement_final: true, prediction_features: { settlement_final: true } }
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-service-key',
    fetchImpl: async (url) => { requestedUrl = new URL(url); return response([v100Row, oldRow]) },
  })

  assert.equal(await client.countTodayPredictionRounds(), 1)
  assert.match(requestedUrl.searchParams.get('select') ?? '', /settlement_final/)
  assert.equal(requestedUrl.searchParams.get('strategy_version'), 'eq.v100')
  assert.equal(requestedUrl.searchParams.get('settlement_final'), 'eq.true')
  assert.equal(requestedUrl.searchParams.has('or'), false)
})

test('v100 stable report reads and accepts only complete v100 final settlements', async () => {
  let requestedUrl
  const finalRow = { table_id: 'BAG01', strategy_version: 'v100', settlement_final: true, prediction_features: { settlement_final: true }, created_at: '2026-07-15T08:03:00Z' }
  const oldVersionRow = { ...finalRow, strategy_version: 'v98', created_at: '2026-07-15T08:02:00Z' }
  const compatibilityRow = { ...finalRow, settlement_final: null, prediction_features: { settlement_final: true }, created_at: '2026-07-15T08:01:00Z' }
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-service-key',
    fetchImpl: async (url) => { requestedUrl = new URL(url); return response([finalRow, oldVersionRow, compatibilityRow]) },
  })

  assert.deepEqual(await client.getStablePredictionRows({ limit: 100 }), [finalRow])
  assert.match(requestedUrl.searchParams.get('select') ?? '', /settlement_final/)
  assert.equal(requestedUrl.searchParams.get('strategy_version'), 'eq.v100')
  assert.equal(requestedUrl.searchParams.get('settlement_final'), 'eq.true')
  assert.equal(requestedUrl.searchParams.has('or'), false)
})

test('recent calibration rows quarantine predictions without a verified final settlement marker', async () => {
  let requestedUrl
  const finalRow = {
    table_id: 'BAG01', shoe_no: '8', round_no: 3,
    strategy_version: 'v100', predicted_result: 'banker', actual_result: 'banker', is_hit: true,
    settlement_final: true, prediction_features: { settlement_final: true }, created_at: '2026-07-15T08:03:00Z',
  }
  const legacyRow = {
    ...finalRow, round_no: 2, actual_result: 'player', is_hit: false,
    settlement_final: null, prediction_features: { settlement_final: true }, created_at: '2026-07-15T08:02:00Z',
  }
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-service-key',
    fetchImpl: async (url) => { requestedUrl = new URL(url); return response([finalRow, legacyRow]) },
  })

  assert.deepEqual(await client.getRecentPredictionRows({ limit: 100 }), [finalRow])
  assert.match(requestedUrl.searchParams.get('select') ?? '', /settlement_final/)
  assert.equal(requestedUrl.searchParams.get('strategy_version'), 'eq.v100')
  assert.equal(requestedUrl.searchParams.get('settlement_final'), 'eq.true')
  assert.equal(requestedUrl.searchParams.has('or'), false)
})

test('v100 recent calibration reads and accepts only v100 settlements', async () => {
  let requestedUrl
  const v100Row = {
    table_id: 'BAG01', shoe_no: '100', round_no: 2,
    strategy_version: 'v100', predicted_result: 'banker', actual_result: 'banker', is_hit: true,
    settlement_final: true, prediction_features: { settlement_final: true }, created_at: '2026-07-18T08:02:00Z',
  }
  const v98Row = {
    ...v100Row, round_no: 1, strategy_version: 'v98', created_at: '2026-07-18T08:01:00Z',
  }
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-service-key',
    fetchImpl: async (url) => { requestedUrl = new URL(url); return response([v100Row, v98Row]) },
  })

  assert.deepEqual(await client.getRecentPredictionRows({ limit: 100 }), [v100Row])
  assert.equal(requestedUrl.searchParams.get('strategy_version'), 'eq.v100')
})
