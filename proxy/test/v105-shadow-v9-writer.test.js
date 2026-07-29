import test from 'node:test'
import assert from 'node:assert/strict'
import { createSupabaseIngestionClient } from '../src/supabase-writer.js'

const VERSION = 'v105-shadow-v9-weighted-v7-v8'
const candidate = { source: 'ofalive99', strategyVersion: VERSION, releaseCandidate: VERSION, formalStrategyVersion: 'v105', predictionTiming: 'pre_result_context', shadowOnly: true, activationEligible: false, memberVisible: false, writesSideActions: false, targetTableId: 'BAG01', targetShoe: '105', targetRound: 21, predictedResult: 'banker' }
const response = (payload) => ({ ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload })

test('V9 writer uses only independent V9 RPCs, history, and a zeroed counter', async () => {
  const requests = []
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    fetchImpl: async (url) => {
      const parsed = new URL(url)
      requests.push(parsed)
      if (parsed.pathname.endsWith('/rpc/issue_v105_shadow_v9_prediction')) return response({ prediction_id: 'v9-id', prediction_issued_at: '2026-07-29T01:00:00.000Z', prediction: candidate })
      if (parsed.pathname.endsWith('/v105_shadow_v9_sequence_counters')) return response([{ settlement_count: 0 }])
      return response([])
    },
  })
  assert.equal((await client.issueV105ShadowV9Prediction(candidate)).strategyVersion, VERSION)
  assert.equal((await client.getV105ShadowV9Counters()).settlement_count, 0)
  await client.getV105ShadowV9History()
  assert.deepEqual(requests.map((request) => request.pathname), [
    '/rest/v1/rpc/issue_v105_shadow_v9_prediction',
    '/rest/v1/v105_shadow_v9_sequence_counters',
    '/rest/v1/v105_shadow_v9_history',
  ])
})

test('a stalled V9 writer does not block formal, V7, or V8 writer calls', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    fetchImpl: async (url) => {
      const path = new URL(url).pathname
      if (path.endsWith('/rpc/issue_v105_shadow_v9_prediction')) {
        await gate
        return response({ prediction_id: 'v9', prediction_issued_at: '2026-07-29T01:00:00.000Z', prediction: candidate })
      }
      if (path.endsWith('/rpc/issue_v105_shadow_v7_prediction')) return response({ prediction_id: 'v7', prediction_issued_at: '2026-07-29T01:00:00.000Z', prediction: { ...candidate, predictionId: 'v7', issuedAt: '2026-07-29T01:00:00.000Z', strategyVersion: 'v105-shadow-v7-ask-road', releaseCandidate: 'v105-shadow-v7-ask-road', askRoadSignal: {} } })
      if (path.endsWith('/rpc/issue_v105_shadow_v8_prediction')) return response({ prediction_id: 'v8', prediction_issued_at: '2026-07-29T01:00:00.000Z', prediction: { ...candidate, predictionId: 'v8', issuedAt: '2026-07-29T01:00:00.000Z', strategyVersion: 'v105-shadow-v8-run-length-ask-road', releaseCandidate: 'v105-shadow-v8-run-length-ask-road', askRoadSignal: {} } })
      return response({ prediction_id: 'formal', prediction_issued_at: '2026-07-29T01:00:00.000Z', prediction: { ...candidate, predictionId: 'formal', issuedAt: '2026-07-29T01:00:00.000Z', strategyVersion: 'v105' } })
    },
  })
  const pendingV9 = client.issueV105ShadowV9Prediction(candidate)
  try {
    const formal = await client.issuePrediction({ ...candidate, strategyVersion: 'v105' })
    const v7 = await client.issueV105ShadowV7Prediction({ ...candidate, strategyVersion: 'v105-shadow-v7-ask-road', releaseCandidate: 'v105-shadow-v7-ask-road' })
    const v8 = await client.issueV105ShadowV8Prediction({ ...candidate, strategyVersion: 'v105-shadow-v8-run-length-ask-road', releaseCandidate: 'v105-shadow-v8-run-length-ask-road' })
    assert.equal(formal.predictionId, 'formal')
    assert.equal(v7.predictionId, 'v7')
    assert.equal(v8.predictionId, 'v8')
  } finally {
    release()
    await pendingV9
  }
})
