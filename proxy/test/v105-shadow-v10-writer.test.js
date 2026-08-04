import test from 'node:test'
import assert from 'node:assert/strict'
import { createSupabaseIngestionClient } from '../src/supabase-writer.js'

const VERSION = 'v105-shadow-v10-big-road-uncommon-structure-rank-synchronized'
const candidate = {
  source: 'ofalive99', strategyVersion: VERSION, releaseCandidate: VERSION, formalStrategyVersion: 'v105',
  predictionTiming: 'pre_result_context', shadowOnly: true, activationEligible: false, memberVisible: false,
  writesSideActions: false, targetTableId: 'BAG01', targetShoe: '105', targetRound: 21,
  predictedResult: 'banker', confidence: 50, sameSideStreak: 1,
}
const response = (payload) => ({ ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload })

test('V10 writer independently issues, reads, settles, reads compact history, and reads its zeroed counter', async () => {
  const requests = []
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    fetchImpl: async (url) => {
      const parsed = new URL(url)
      requests.push(parsed.pathname)
      if (parsed.pathname.endsWith('/rpc/issue_v105_shadow_v10_rank_sync_prediction')) {
        return response({ prediction_id: 'v10-id', prediction_issued_at: '2026-08-02T01:00:00.000Z', prediction: candidate })
      }
      if (parsed.pathname.endsWith('/v105_shadow_v10_rank_sync_issuances')) {
        return response([{ id: 'v10-id', source: 'ofalive99', table_id: 'BAG01', shoe_no: '105', round_no: 21, strategy_version: VERSION, prediction_timing: 'pre_result_context', prediction_issued_at: '2026-08-02T01:00:00.000Z', prediction_payload: candidate }])
      }
      if (parsed.pathname.endsWith('/rpc/settle_v105_shadow_v10_rank_sync_prediction')) return response({ prediction_id: 'v10-id', settlement_sequence: 1 })
      if (parsed.pathname.endsWith('/v105_shadow_v10_rank_sync_sequence_counters')) return response([{ settlement_count: 0 }])
      return response([])
    },
  })
  const issued = await client.issueV105ShadowV10Prediction(candidate)
  assert.equal(issued.strategyVersion, VERSION)
  assert.equal((await client.readV105ShadowV10Issuance({ tableId: 'BAG01', shoe: '105', round: 21 })).predictionId, 'v10-id')
  assert.equal((await client.settleV105ShadowV10Prediction({ ...candidate, predictionId: 'v10-id' })).predictionId, 'v10-id')
  assert.equal((await client.getV105ShadowV10Counters()).settlement_count, 0)
  assert.deepEqual(await client.getV105ShadowV10History(), [])
  assert.deepEqual(requests, [
    '/rest/v1/rpc/issue_v105_shadow_v10_rank_sync_prediction',
    '/rest/v1/v105_shadow_v10_rank_sync_issuances',
    '/rest/v1/rpc/settle_v105_shadow_v10_rank_sync_prediction',
    '/rest/v1/v105_shadow_v10_rank_sync_sequence_counters',
    '/rest/v1/rpc/get_v105_shadow_v10_rank_sync_compact_history',
  ])
})

test('a stalled V10 writer queue does not block V9 or formal writer calls', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    fetchImpl: async (url) => {
      const path = new URL(url).pathname
      if (path.endsWith('/rpc/issue_v105_shadow_v10_rank_sync_prediction')) {
        await gate
        return response({ prediction_id: 'v10', prediction_issued_at: '2026-08-02T01:00:00.000Z', prediction: candidate })
      }
      if (path.endsWith('/rpc/issue_v105_shadow_v9_prediction')) {
        const prediction = { ...candidate, strategyVersion: 'v105-shadow-v9-weighted-v7-v8', releaseCandidate: 'v105-shadow-v9-weighted-v7-v8' }
        return response({ prediction_id: 'v9', prediction_issued_at: '2026-08-02T01:00:00.000Z', prediction })
      }
      return response({ prediction_id: 'formal', prediction_issued_at: '2026-08-02T01:00:00.000Z', prediction: { ...candidate, predictionId: 'formal', issuedAt: '2026-08-02T01:00:00.000Z', strategyVersion: 'v105' } })
    },
  })
  const pendingV10 = client.issueV105ShadowV10Prediction(candidate)
  try {
    assert.equal((await client.issuePrediction({ ...candidate, strategyVersion: 'v105' })).predictionId, 'formal')
    assert.equal((await client.issueV105ShadowV9Prediction({ ...candidate, strategyVersion: 'v105-shadow-v9-weighted-v7-v8', releaseCandidate: 'v105-shadow-v9-weighted-v7-v8' })).predictionId, 'v9')
  } finally {
    release()
    await pendingV10
  }
})
