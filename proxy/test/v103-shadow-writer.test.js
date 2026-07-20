import test from 'node:test'
import assert from 'node:assert/strict'
import { buildLivePrediction, createSupabaseIngestionClient } from '../src/supabase-writer.js'

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload), json: async () => payload }
}

const candidate = {
  source: 'ofalive99', strategyVersion: 'v103', predictionTiming: 'pre_result_context',
  targetTableId: 'BAG01', targetShoe: '103', targetRound: 21,
  predictedResult: 'banker', confidence: 44,
  scoreSources: {}, scoreTotals: { banker: 0.51, player: 0.49 }, featureWeights: {}, calibration: {},
}

test('v103 writer uses only dedicated issuance RPC and verifies immutable acknowledgement identity', async () => {
  const requests = []
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) })
      return response({ prediction_id: 'pid-103', prediction_issued_at: '2026-07-20T10:00:00Z', prediction: candidate })
    },
  })
  const issued = await client.issueV103ShadowPrediction(candidate)
  assert.match(requests[0].url, /\/rpc\/issue_v103_shadow_prediction$/)
  assert.equal(requests[0].body.p_prediction.strategy_version, 'v103')
  assert.equal(requests[0].body.p_prediction.prediction_timing, 'pre_result_context')
  assert.equal(issued.predictionId, 'pid-103')
  assert.equal(issued.issuedAt, '2026-07-20T10:00:00Z')
})

test('v103 writer reads only complete v103 pre-result Final history from dedicated tables', async () => {
  const requests = []
  const row = { strategy_version: 'v103', prediction_timing: 'pre_result_context', prediction_issued_at: '2026-07-20T10:00:00Z', settlement_final: true }
  const client = createSupabaseIngestionClient({ url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false, fetchImpl: async (url) => { requests.push(new URL(url)); return response([row]) } })
  assert.deepEqual(await client.getV103ShadowHistory(), [row])
  const request = requests[0]
  assert.match(request.pathname, /\/rest\/v1\/v103_shadow_history$/)
  assert.equal(request.searchParams.get('strategy_version'), 'eq.v103')
  assert.equal(request.searchParams.get('prediction_timing'), 'eq.pre_result_context')
  assert.equal(request.searchParams.get('prediction_issued_at'), 'not.is.null')
  assert.equal(request.searchParams.get('settlement_final'), 'eq.true')
  assert.equal(request.searchParams.get('order'), 'resolved_at.desc')
})

test('v103 settlement uses only the dedicated RPC and preserves PUSH as null is_hit', async () => {
  const requests = []
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    fetchImpl: async (url, init) => { requests.push({ url: String(url), body: JSON.parse(init.body) }); return response({ prediction_id: 'pid-103', duplicate: false }) },
  })
  const result = await client.settleV103ShadowPrediction({
    predictionId: 'pid-103', source: 'ofalive99', tableId: 'BAG01', shoe: '103', round: 21,
    strategyVersion: 'v103', predictedResult: 'banker', actualResult: 'tie', isHit: null,
    settlementStatus: 'push', settlementFinal: true, settlementSourceAction: '/show_win', resolvedAt: '2026-07-20T10:01:00Z',
  })
  assert.match(requests[0].url, /\/rpc\/settle_v103_shadow_prediction$/)
  assert.equal(requests[0].body.p_settlement.is_hit, null)
  assert.equal(requests[0].body.p_settlement.settlement_status, 'push')
  assert.equal(result.predictionId, 'pid-103')
})

test('a hanging shadow RPC is aborted at the network layer', { timeout: 100 }, async () => {
  let aborts = 0
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    retryAttempts: 1, shadowRequestTimeoutMs: 10,
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => { aborts += 1; reject(new Error('shadow fetch aborted')) }, { once: true })
    }),
  })
  await assert.rejects(client.issueV103ShadowPrediction(candidate), /aborted/i)
  assert.equal(aborts, 1)
})

test('a hanging shadow RPC never occupies the v102 active write queue', async () => {
  let releaseShadow
  const shadowGate = new Promise((resolve) => { releaseShadow = resolve })
  const active = buildLivePrediction({ tableId: 'BAG01', shoe: 103, round: 20 })
  const activeAck = { prediction_id: 'pid-v102', prediction_issued_at: '2026-07-20T10:00:00Z', prediction: { ...active, predictionId: 'pid-v102', issuedAt: '2026-07-20T10:00:00Z' } }
  const shadowAck = { prediction_id: 'pid-103', prediction_issued_at: '2026-07-20T10:00:00Z', prediction: candidate }
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    fetchImpl: async (url) => {
      if (String(url).endsWith('/rpc/issue_v103_shadow_prediction')) {
        await shadowGate
        return response(shadowAck)
      }
      return response(activeAck)
    },
  })
  const shadowWrite = client.issueV103ShadowPrediction(candidate)
  await new Promise((resolve) => setImmediate(resolve))
  const winner = await Promise.race([
    client.issuePrediction(active).then(() => 'v102'),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 30)),
  ])
  releaseShadow()
  await shadowWrite
  assert.equal(winner, 'v102')
})
