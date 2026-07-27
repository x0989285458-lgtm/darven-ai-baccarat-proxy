import test from 'node:test'
import assert from 'node:assert/strict'
import { createSupabaseIngestionClient } from '../src/supabase-writer.js'
import { buildV105ShadowV7Prediction } from '../src/v105-shadow-v7-contract.js'

const candidate = buildV105ShadowV7Prediction({ tableId: 'BAG01', shoe: 105, round: 20, bankerCount: 12, playerCount: 8, bigRoadRaw: 'B#P' })
const response = (payload) => ({ ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload })

test('V7 writer uses only independent v105_shadow_v7 RPCs, history, and zeroed counter', async () => {
  const requests = []
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    fetchImpl: async (url) => {
      const parsed = new URL(url); requests.push(parsed)
      if (parsed.pathname.endsWith('/rpc/issue_v105_shadow_v7_prediction')) return response({
        prediction_id: 'v7-id', prediction_issued_at: '2026-07-27T10:00:00.000Z', prediction: candidate,
      })
      if (parsed.pathname.endsWith('/v105_shadow_v7_sequence_counters')) return response([{ settlement_count: 0 }])
      return response([])
    },
  })
  assert.equal((await client.issueV105ShadowV7Prediction(candidate)).strategyVersion, 'v105-shadow-v7-ask-road')
  assert.equal((await client.getV105ShadowV7Counters()).settlement_count, 0)
  await client.getV105ShadowV7History()
  assert.deepEqual(requests.map((item) => item.pathname), [
    '/rest/v1/rpc/issue_v105_shadow_v7_prediction',
    '/rest/v1/v105_shadow_v7_sequence_counters',
    '/rest/v1/v105_shadow_v7_history',
  ])
})

test('a stalled V7 queue cannot block formal or V6 writer calls', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    fetchImpl: async (url) => {
      const path = new URL(url).pathname
      if (path.endsWith('/rpc/issue_v105_shadow_v7_prediction')) { await gate; return response({ prediction_id: 'v7', prediction_issued_at: '2026-07-27T10:00:00.000Z', prediction: candidate }) }
      if (path.endsWith('/rpc/issue_v105_shadow_v6_prediction')) {
        const v6 = { ...candidate, strategyVersion: 'v105-shadow-v6-road-pattern', releaseCandidate: 'v105-shadow-v6-road-pattern' }
        return response({ prediction_id: 'v6', prediction_issued_at: '2026-07-27T10:00:00.000Z', prediction: v6 })
      }
      return response({ prediction_id: 'formal' })
    },
  })
  const pending = client.issueV105ShadowV7Prediction(candidate)
  assert.equal((await client.issueV105ShadowPrediction({ ...candidate, strategyVersion: 'v105-shadow-v6-road-pattern', releaseCandidate: 'v105-shadow-v6-road-pattern' })).predictionId, 'v6')
  release(); await pending
})
