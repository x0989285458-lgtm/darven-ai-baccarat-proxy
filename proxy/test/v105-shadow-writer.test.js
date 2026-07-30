import test from 'node:test'
import assert from 'node:assert/strict'
import { createSupabaseIngestionClient } from '../src/supabase-writer.js'
import { buildV105ShadowPrediction } from '../src/v105-shadow-contract.js'
import { buildV105FormalPrediction } from '../src/v105-formal-strategy.js'

const table = { tableId: 'BAG01', shoe: 105, round: 20, bankerCount: 12, playerCount: 8, beadPlateRaw: '222221', bigRoadRaw: '222221' }
const candidate = buildV105ShadowPrediction(table)
const formalCandidate = buildV105FormalPrediction(table)

function response(payload) {
  return { ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload }
}

test('v105 shadow writer uses only v105_shadow_v6 RPCs, tables, and zeroed counters', async () => {
  const requests = []
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    fetchImpl: async (url, init = {}) => {
      const parsed = new URL(url)
      requests.push({ parsed, init })
      if (parsed.pathname.endsWith('/rpc/issue_v105_shadow_v6_prediction')) return response({
        prediction_id: 'v105-shadow-pid', prediction_issued_at: '2026-07-27T10:00:00.000Z', prediction: candidate,
      })
      if (parsed.pathname.endsWith('/v105_shadow_v6_sequence_counters')) return response([{ settlement_count: 0 }])
      return response([])
    },
  })
  assert.equal(typeof client.issueV105ShadowPrediction, 'function')
  const issued = await client.issueV105ShadowPrediction(candidate)
  const counters = await client.getV105ShadowCounters()
  assert.equal(issued.strategyVersion, 'v105-shadow-v6-road-pattern')
  assert.equal(counters.settlement_count, 0)
  assert.deepEqual(requests.map(({ parsed }) => parsed.pathname), [
    '/rest/v1/rpc/issue_v105_shadow_v6_prediction',
    '/rest/v1/v105_shadow_v6_sequence_counters',
  ])
  assert.equal(JSON.parse(requests[0].init.body).p_prediction.strategy_version, 'v105-shadow-v6-road-pattern')
})

test('v105 shadow history reader requests and returns only v105-shadow-v6-road-pattern rows', async () => {
  const requests = []
  const own = {
    prediction_id: 'own', strategy_version: 'v105-shadow-v6-road-pattern', prediction_timing: 'pre_result_context',
    prediction_issued_at: '2026-07-27T10:00:00.000Z',
  }
  const old = { ...own, prediction_id: 'old', strategy_version: 'v105-shadow-v1' }
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    fetchImpl: async (url) => { requests.push(new URL(url)); return response([own, old]) },
  })
  assert.equal(typeof client.getV105ShadowHistory, 'function')
  await assert.rejects(client.getV105ShadowHistory(), /compact history/i)
  assert.equal(requests[0].pathname, '/rest/v1/rpc/get_v105_shadow_v6_compact_history')
})

test('a stalled v105 shadow write queue cannot delay formal v105 issuance', async () => {
  let releaseShadow
  const shadowGate = new Promise((resolve) => { releaseShadow = resolve })
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    fetchImpl: async (url) => {
      if (String(url).endsWith('/rpc/issue_v105_shadow_v6_prediction')) {
        await shadowGate
        return response({ prediction_id: 'shadow', prediction_issued_at: '2026-07-27T10:00:00.000Z', prediction: candidate })
      }
      return response({
        prediction_id: 'formal', prediction_issued_at: '2026-07-27T10:00:00.000Z',
        prediction: { ...formalCandidate, predictionId: 'formal', issuedAt: '2026-07-27T10:00:00.000Z' },
      })
    },
  })
  assert.equal(typeof client.issueV105ShadowPrediction, 'function')
  const shadow = client.issueV105ShadowPrediction(candidate)
  const formal = await client.issuePrediction(formalCandidate)
  assert.equal(formal.predictionId, 'formal')
  releaseShadow()
  await shadow
})
