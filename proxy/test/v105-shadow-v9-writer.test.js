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
    '/rest/v1/rpc/get_v105_shadow_v9_compact_history',
  ])
})

test('a stalled V9 writer does not block formal or V10 writer calls', async () => {
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
      if (path.endsWith('/rpc/issue_v105_shadow_v10_big_road_prediction')) {
        const version = 'v105-shadow-v10-big-road-uncommon-structure'
        return response({ prediction_id: 'v10', prediction_issued_at: '2026-07-29T01:00:00.000Z', prediction: { ...candidate, strategyVersion: version, releaseCandidate: version, structureDiagnostics: {} } })
      }
      return response({ prediction_id: 'formal', prediction_issued_at: '2026-07-29T01:00:00.000Z', prediction: { ...candidate, predictionId: 'formal', issuedAt: '2026-07-29T01:00:00.000Z', strategyVersion: 'v105' } })
    },
  })
  const pendingV9 = client.issueV105ShadowV9Prediction(candidate)
  try {
    const formal = await client.issuePrediction({ ...candidate, strategyVersion: 'v105' })
    const version = 'v105-shadow-v10-big-road-uncommon-structure'
    const v10 = await client.issueV105ShadowV10Prediction({ ...candidate, strategyVersion: version, releaseCandidate: version, structureDiagnostics: {} })
    assert.equal(formal.predictionId, 'formal')
    assert.equal(v10.predictionId, 'v10')
  } finally {
    release()
    await pendingV9
  }
})
