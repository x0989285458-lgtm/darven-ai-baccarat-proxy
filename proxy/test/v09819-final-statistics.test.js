import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createSupabaseIngestionClient } from '../src/supabase-writer.js'

function response(rows) {
  return { ok: true, status: 200, json: async () => rows, text: async () => JSON.stringify(rows) }
}

test('v098.19 migration indexes verified-final prediction history before PostgREST limiting', () => {
  const sql = readFileSync(new URL('../../frontend/supabase/schema_v09819_final_settlement.sql', import.meta.url), 'utf8')
  assert.match(sql, /create\s+index\s+concurrently\s+if\s+not\s+exists\s+idx_daily_prediction_results_final_created_at/i)
  assert.match(sql, /prediction_features\s*->>\s*'settlement_final'/i)
  assert.match(sql, /where\s*\(prediction_features\s*->>\s*'settlement_final'\)\s*=\s*'true'/i)
})

test('v098.19 today prediction fallback count queries only verified final settlements', async () => {
  let requestedUrl
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-service-key',
    fetchImpl: async (url) => { requestedUrl = new URL(url); return response([]) },
  })

  assert.equal(await client.countTodayPredictionRounds(), 0)
  assert.equal(requestedUrl.searchParams.get('prediction_features->>settlement_final'), 'eq.true')
})

test('v098.19 stable report rows quarantine predictions without a verified final settlement marker', async () => {
  let requestedUrl
  const finalRow = { table_id: 'BAG01', prediction_features: { settlement_final: true }, created_at: '2026-07-15T08:03:00Z' }
  const legacyRow = { table_id: 'BAG01', prediction_features: {}, created_at: '2026-07-15T08:02:00Z' }
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-service-key',
    fetchImpl: async (url) => { requestedUrl = new URL(url); return response([finalRow, legacyRow]) },
  })

  assert.deepEqual(await client.getStablePredictionRows({ limit: 100 }), [finalRow])
  assert.equal(requestedUrl.searchParams.get('prediction_features->>settlement_final'), 'eq.true')
})

test('v098.19 recent calibration rows quarantine predictions without a verified final settlement marker', async () => {
  let requestedUrl
  const finalRow = {
    table_id: 'BAG01', shoe_no: '8', round_no: 3,
    strategy_version: 'v098_主信心實際命中校準版', predicted_result: 'banker', actual_result: 'banker', is_hit: true,
    prediction_features: { settlement_final: true }, created_at: '2026-07-15T08:03:00Z',
  }
  const legacyRow = {
    ...finalRow, round_no: 2, actual_result: 'player', is_hit: false,
    prediction_features: {}, created_at: '2026-07-15T08:02:00Z',
  }
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-service-key',
    fetchImpl: async (url) => { requestedUrl = new URL(url); return response([finalRow, legacyRow]) },
  })

  assert.deepEqual(await client.getRecentPredictionRows({ limit: 100 }), [finalRow])
  assert.equal(requestedUrl.searchParams.get('prediction_features->>settlement_final'), 'eq.true')
})
