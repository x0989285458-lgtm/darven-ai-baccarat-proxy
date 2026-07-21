import test from 'node:test'
import assert from 'node:assert/strict'
import { buildLivePrediction, createSupabaseIngestionClient } from '../src/supabase-writer.js'

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload), json: async () => payload }
}

const candidate = {
  source: 'ofalive99', strategyVersion: 'v104-seven-head-shadow-v2-player-pair-threshold-41', predictionTiming: 'pre_result_context',
  shadowOnly: true, activationEligible: false, memberVisible: false, writesSideActions: false,
  targetTableId: 'BAG08', targetShoe: '104', targetRound: 21,
  predictedResult: 'banker', confidence: 44,
  scoreSources: {}, scoreTotals: { banker: 0.51, player: 0.49 }, featureWeights: {}, diagnostics: {},
  sameSideStreak: 5, independentSupportCount: 1, shoeBiasSuppressed: true, lockRisk: true,
}

test('v104 writer uses only its dedicated issuance RPC and preserves lock diagnostics in immutable payload', async () => {
  const requests = []
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) })
      return response({ prediction_id: 'pid-104', prediction_issued_at: '2026-07-21T10:00:00Z', prediction: candidate })
    },
  })
  const issued = await client.issueV104IterationShadowPrediction(candidate)
  assert.match(requests[0].url, /\/rpc\/issue_v104_iteration_shadow_v2_prediction$/)
  assert.equal(requests[0].body.p_prediction.strategy_version, 'v104-seven-head-shadow-v2-player-pair-threshold-41')
  assert.equal(requests[0].body.p_prediction.same_side_streak, 5)
  assert.equal(requests[0].body.p_prediction.shoe_bias_suppressed, true)
  assert.equal(issued.predictionId, 'pid-104')
})

test('v104 history reads its dedicated view including unsettled issuance rows for restart hydration', async () => {
  const requests = []
  const row = { strategy_version: 'v104-seven-head-shadow-v2-player-pair-threshold-41', prediction_timing: 'pre_result_context', prediction_issued_at: '2026-07-21T10:00:00Z', settlement_final: false }
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    fetchImpl: async (url) => { requests.push(new URL(url)); return response([row]) },
  })
  assert.deepEqual(await client.getV104IterationShadowHistory(), [row])
  assert.match(requests[0].pathname, /\/rest\/v1\/v104_iteration_shadow_v2_history$/)
  assert.equal(requests[0].searchParams.get('strategy_version'), 'eq.v104-seven-head-shadow-v2-player-pair-threshold-41')
  assert.equal(requests[0].searchParams.get('settlement_final'), null)
  assert.equal(requests[0].searchParams.get('order'), 'prediction_issued_at.desc,prediction_id.desc')
  assert.match(requests[0].searchParams.get('select'), /prediction_payload/)
})

test('v104 iteration history paginates beyond the Supabase 1000-row response cap', async () => {
  const requests = []
  const makeRow = (index) => ({ strategy_version: 'v104-seven-head-shadow-v2-player-pair-threshold-41', prediction_timing: 'pre_result_context', prediction_issued_at: `2026-07-21T10:${String(index % 60).padStart(2, '0')}:00Z`, prediction_id: `p-${index}` })
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    fetchImpl: async (url) => {
      const parsed = new URL(url); requests.push(parsed)
      const offset = Number(parsed.searchParams.get('offset') ?? 0)
      return response(offset === 0 ? Array.from({ length: 1000 }, (_, index) => makeRow(index)) : [makeRow(1000)])
    },
  })
  const rows = await client.getV104IterationShadowHistory({ limit: 1001 })
  assert.equal(rows.length, 1001)
  assert.deepEqual(requests.map((url) => url.searchParams.get('offset')), ['0', '1000'])
})

test('v104 sparse head-action range filters action=true in PostgREST before applying the 1000-row limit', async () => {
  const requests = []
  const row = { head_results: { tie: { action: true } }, tie_action_sequence: 1000 }
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    fetchImpl: async (url) => { requests.push(new URL(url)); return response([row]) },
  })
  assert.deepEqual(await client.getV104IterationShadowHeadActionRange({ headKey: 'tie', startAction: 1, endAction: 1000 }), [row])
  assert.equal(requests[0].searchParams.get('head_results->tie->>action'), 'eq.true')
  assert.equal(requests[0].searchParams.get('limit'), '1000')
})

test('v104 durable reports and suggestions paginate beyond the REST 1000-row cap', async () => {
  const requests = []
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    fetchImpl: async (url) => {
      const parsed = new URL(url); requests.push(parsed)
      const offset = Number(parsed.searchParams.get('offset') ?? 0)
      const isReport = parsed.pathname.endsWith('/v104_iteration_shadow_v2_cycle_reports')
      const makeRow = (index) => isReport ? { cycle_number: index + 1 } : { suggestion_id: `s-${index}`, head_key: 'main', action_cycle: index + 1 }
      return response(offset === 0 ? Array.from({ length: 1000 }, (_, index) => makeRow(index)) : [makeRow(1000)])
    },
  })
  assert.equal((await client.getV104IterationShadowCycleReports({ limit: 1001 })).length, 1001)
  assert.equal((await client.getV104IterationShadowSuggestions({ limit: 1001 })).length, 1001)
  assert.deepEqual(requests.map((url) => url.searchParams.get('offset')), ['0', '1000', '0', '1000'])
})

test('v104 history GET is aborted at the network layer', { timeout: 250 }, async () => {
  let aborted = false
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    shadowRequestTimeoutMs: 20,
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('v104 history aborted')) }, { once: true })
    }),
  })
  await assert.rejects(client.getV104IterationShadowHistory(), /aborted/i)
  assert.equal(aborted, true)
})

test('v104 issuance fallback GET is aborted at the network layer', { timeout: 250 }, async () => {
  let aborted = false
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    shadowRequestTimeoutMs: 20,
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('v104 issuance read aborted')) }, { once: true })
    }),
  })
  await assert.rejects(client.readV104IterationShadowIssuance({ source: 'ofalive99', tableId: 'BAG08', shoe: '104', round: 21 }), /aborted/i)
  assert.equal(aborted, true)
})

test('v104 settlement uses only its dedicated RPC and preserves PUSH', async () => {
  const requests = []
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    fetchImpl: async (url, init) => { requests.push({ url: String(url), body: JSON.parse(init.body) }); return response({ prediction_id: 'pid-104', duplicate: false }) },
  })
  await client.settleV104IterationShadowPrediction({
    predictionId: 'pid-104', source: 'ofalive99', tableId: 'BAG08', shoe: '104', round: 21,
    strategyVersion: 'v104-seven-head-shadow-v2-player-pair-threshold-41', predictedResult: 'banker', actualResult: 'tie', isHit: null,
    settlementStatus: 'push', settlementFinal: true, settlementSourceAction: '/summary', resolvedAt: '2026-07-21T10:01:00Z',
  })
  assert.match(requests[0].url, /\/rpc\/settle_v104_iteration_shadow_v2_prediction$/)
  assert.equal(requests[0].body.p_settlement.is_hit, null)
})

test('v104 network timeout aborts without occupying v102 or v103 queues', { timeout: 250 }, async () => {
  let v104Aborted = false
  const active = buildLivePrediction({ tableId: 'BAG08', shoe: 104, round: 20 })
  const activeAck = { prediction_id: 'pid-v102', prediction_issued_at: '2026-07-21T10:00:00Z', prediction: { ...active, predictionId: 'pid-v102', issuedAt: '2026-07-21T10:00:00Z' } }
  const v103 = { ...candidate, strategyVersion: 'v103', predictionId: undefined }
  const v103Ack = { prediction_id: 'pid-v103', prediction_issued_at: '2026-07-21T10:00:00Z', prediction: v103 }
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    retryAttempts: 1, shadowRequestTimeoutMs: 20,
    fetchImpl: async (url, init) => {
      if (String(url).endsWith('/rpc/issue_v104_iteration_shadow_v2_prediction')) return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => { v104Aborted = true; reject(new Error('v104 fetch aborted')) }, { once: true })
      })
      if (String(url).endsWith('/rpc/issue_v103_shadow_prediction')) return response(v103Ack)
      return response(activeAck)
    },
  })
  const hanging = client.issueV104IterationShadowPrediction(candidate)
  await new Promise((resolve) => setImmediate(resolve))
  const results = await Promise.all([
    client.issuePrediction(active).then(() => 'v102'),
    client.issueV103ShadowPrediction(v103).then(() => 'v103'),
  ])
  await assert.rejects(hanging, /aborted/i)
  assert.deepEqual(results, ['v102', 'v103'])
  assert.equal(v104Aborted, true)
})
