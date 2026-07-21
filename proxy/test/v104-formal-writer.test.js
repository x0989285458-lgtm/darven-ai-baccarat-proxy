import test from 'node:test'
import assert from 'node:assert/strict'
import { createSupabaseIngestionClient } from '../src/supabase-writer.js'

function response(payload) {
  return { ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload }
}

test('v104 formal history reads only formal daily prediction issuances and keeps pending rows for restart streak hydration', async () => {
  let requested = null
  const rows = [
    {
      id: 'v104-formal-1', source: 'ofalive99', table_id: 'BAG01', shoe_no: '88', round_no: 7,
      strategy_version: 'v104', predicted_result: 'banker', prediction_issued_at: '2026-07-21T00:00:00Z',
      issued_prediction_payload: { strategyVersion: 'v104', predictionTiming: 'pre_result_context' },
      prediction_features: { prediction_timing: 'pre_result_context' }, settlement_final: false,
    },
    {
      id: 'old', source: 'ofalive99', table_id: 'BAG01', shoe_no: '88', round_no: 6,
      strategy_version: 'v102', predicted_result: 'player', prediction_issued_at: '2026-07-21T00:00:00Z',
      prediction_features: { prediction_timing: 'pre_result_context' }, settlement_final: true,
    },
  ]
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    fetchImpl: async (url) => { requested = new URL(url); return response(rows) },
  })

  assert.equal(typeof client.getV104FormalHistory, 'function')
  const history = await client.getV104FormalHistory({ limit: 10000 })

  assert.equal(requested.pathname, '/rest/v1/daily_prediction_results')
  assert.equal(requested.searchParams.get('strategy_version'), 'eq.v104')
  assert.equal(requested.searchParams.has('settlement_final'), false, 'pending issuance rows must remain visible')
  assert.doesNotMatch(requested.searchParams.get('select'), /issued_prediction_payload/)
  assert.equal(history.length, 1)
  assert.equal(history[0].prediction_id, 'v104-formal-1')
  assert.equal(history[0].prediction_timing, 'pre_result_context')
  assert.equal(Object.hasOwn(history[0], 'prediction_payload'), false)
})

test('v104 formal history timeout aborts the underlying Supabase GET', async () => {
  let attachedSignal = null
  let aborted = false
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    fetchImpl: async (_url, init = {}) => new Promise((_resolve, reject) => {
      attachedSignal = init.signal ?? null
      attachedSignal?.addEventListener('abort', () => {
        aborted = true
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      }, { once: true })
    }),
  })

  await assert.rejects(() => client.getV104FormalHistory({ limit: 10000, requestTimeoutMs: 20 }), /timeout|abort/i)
  assert.ok(attachedSignal, 'history GET must receive an AbortController signal')
  assert.equal(aborted, true)
})
