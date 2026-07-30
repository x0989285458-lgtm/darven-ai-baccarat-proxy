import test from 'node:test'
import assert from 'node:assert/strict'
import { createSupabaseIngestionClient } from '../src/supabase-writer.js'

const TABLE_IDS = ['BAG01', 'BAG02', 'BAG03', 'BAG03A', 'BAG05', 'BAG06', 'BAG07', 'BAG08', 'BAG09', 'BAG10']
const CASES = [
  { label: 'V6', version: 'v105-shadow-v6-road-pattern', rpc: 'get_v105_shadow_v6_compact_history', method: 'getV105ShadowHistory', issueMethod: 'issueV105ShadowPrediction', readMethod: 'readV105ShadowIssuance', settleMethod: 'settleV105ShadowPrediction', runtime: '../src/v105-shadow-runtime.js', factory: 'createV105ShadowRuntime' },
  { label: 'V7', version: 'v105-shadow-v7-ask-road', rpc: 'get_v105_shadow_v7_compact_history', method: 'getV105ShadowV7History', issueMethod: 'issueV105ShadowV7Prediction', readMethod: 'readV105ShadowV7Issuance', settleMethod: 'settleV105ShadowV7Prediction', runtime: '../src/v105-shadow-v7-runtime.js', factory: 'createV105ShadowV7Runtime' },
  { label: 'V8', version: 'v105-shadow-v8-run-length-ask-road', rpc: 'get_v105_shadow_v8_compact_history', method: 'getV105ShadowV8History', issueMethod: 'issueV105ShadowV8Prediction', readMethod: 'readV105ShadowV8Issuance', settleMethod: 'settleV105ShadowV8Prediction', runtime: '../src/v105-shadow-v8-runtime.js', factory: 'createV105ShadowV8Runtime' },
  { label: 'V9', version: 'v105-shadow-v9-weighted-v7-v8', rpc: 'get_v105_shadow_v9_compact_history', method: 'getV105ShadowV9History', issueMethod: 'issueV105ShadowV9Prediction', readMethod: 'readV105ShadowV9Issuance', settleMethod: 'settleV105ShadowV9Prediction', runtime: '../src/v105-shadow-v9-runtime.js', factory: 'createV105ShadowV9Runtime' },
]
const COMPACT_KEYS = [
  'actual_result', 'prediction_id', 'prediction_issued_at', 'prediction_timing', 'predicted_result',
  'round_no', 'same_side_streak', 'settlement_final', 'shoe_no', 'source', 'strategy_version', 'table_id',
].sort()

function compactRow(version, { tableId = 'BAG01', index = 1, final = true } = {}) {
  return {
    prediction_id: `${version}-${tableId}-${index}`,
    source: 'ofalive99',
    table_id: tableId,
    shoe_no: '105',
    round_no: index,
    strategy_version: version,
    prediction_timing: 'pre_result_context',
    prediction_issued_at: new Date(Date.UTC(2026, 6, 29, 0, 0, index)).toISOString(),
    predicted_result: 'banker',
    same_side_streak: 7,
    actual_result: final ? 'player' : null,
    settlement_final: final,
  }
}

function response(payload) {
  return { ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload }
}

for (const item of CASES) {
  test(`${item.label} history reader posts the compact per-table RPC and returns only the compact schema`, async () => {
    const requests = []
    const row = compactRow(item.version)
    const client = createSupabaseIngestionClient({
      url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
      retryAttempts: 1,
      fetchImpl: async (url, init) => {
        requests.push({ url: new URL(url), init })
        return response([row])
      },
    })

    const rows = await client[item.method]({ perTableLimit: 37, requestTimeoutMs: 1234 })

    assert.equal(requests.length, 1)
    assert.equal(requests[0].url.pathname, `/rest/v1/rpc/${item.rpc}`)
    assert.deepEqual(JSON.parse(requests[0].init.body), { p_per_table_limit: 37 })
    assert.ok(requests[0].init.signal instanceof AbortSignal)
    assert.deepEqual(Object.keys(rows[0]).sort(), COMPACT_KEYS)
    assert.equal('prediction_payload' in rows[0], false)
    assert.equal('actual_facts' in rows[0], false)
    assert.equal('head_results' in rows[0], false)
  })

  test(`${item.label} history reader fails closed on out-of-range limits and malformed compact rows`, async () => {
    let calls = 0
    const sameTime = '2026-07-29T00:00:00.000Z'
    const malformedResponses = [
      [{ ...compactRow(item.version), prediction_payload: { huge: true } }],
      [{ ...compactRow(item.version), strategy_version: 'wrong-version' }],
      [{ ...compactRow(item.version, { final: false }), actual_result: 'banker' }],
      [{ ...compactRow(item.version), actual_result: null }],
      [{ ...compactRow(item.version), table_id: 'BAG04' }],
      [
        { ...compactRow(item.version), prediction_id: 'b', prediction_issued_at: sameTime },
        { ...compactRow(item.version), prediction_id: 'a', prediction_issued_at: sameTime },
      ],
    ]
    const client = createSupabaseIngestionClient({
      url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
      retryAttempts: 1,
      fetchImpl: async () => {
        calls += 1
        return response(malformedResponses.shift())
      },
    })

    await assert.rejects(client[item.method]({ perTableLimit: 0 }), /per-table limit/i)
    await assert.rejects(client[item.method]({ perTableLimit: 61 }), /per-table limit/i)
    assert.equal(calls, 0)
    while (malformedResponses.length) {
      await assert.rejects(client[item.method]({ perTableLimit: 60 }), /compact history/i)
    }
    assert.equal(calls, 6)
  })

  test(`${item.label} history reader allows one pending row beside the Final limit and rejects excess or duplicate rows`, async () => {
    const valid = [
      ...Array.from({ length: 60 }, (_, index) => compactRow(item.version, { index: index + 1 })),
      compactRow(item.version, { index: 61, final: false }),
    ]
    let payload = valid
    const client = createSupabaseIngestionClient({
      url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
      retryAttempts: 1, fetchImpl: async () => response(payload),
    })
    assert.equal((await client[item.method]({ perTableLimit: 60 })).length, 61)

    const tooManyForOneTable = Array.from({ length: 61 }, (_, index) => compactRow(item.version, { index: index + 1 }))
    payload = tooManyForOneTable
    await assert.rejects(client[item.method]({ perTableLimit: 60 }), /compact history/i)
    payload = [compactRow(item.version), compactRow(item.version)]
    await assert.rejects(client[item.method]({ perTableLimit: 60 }), /compact history/i)
    payload = [
      compactRow(item.version, { index: 1, final: false }),
      compactRow(item.version, { index: 2, final: false }),
    ]
    await assert.rejects(client[item.method]({ perTableLimit: 60 }), /compact history/i)
  })

  test(`${item.label} runtime hydrates Final compact streaks without cloning payloads or creating pending issuances`, async () => {
    const row = compactRow(item.version, { index: 20 })
    Object.defineProperty(row, 'prediction_payload', {
      enumerable: true,
      get() { throw new Error('large prediction payload must not be read or cloned') },
    })
    const calls = []
    const candidates = []
    const store = {
      configured: true,
      async [item.method](options) { calls.push(options); return [row] },
      async [item.issueMethod](candidate) {
        candidates.push(candidate)
        return { ...candidate, predictionId: `${item.label.toLowerCase()}-new`, issuedAt: '2026-07-29T01:00:00.000Z' }
      },
    }
    const module = await import(item.runtime)
    const runtime = module[item.factory]({ writer: store, requestTimeoutMs: 4321 })

    await runtime.start()
    assert.deepEqual(calls, [{ perTableLimit: 60, requestTimeoutMs: 4321 }])
    assert.equal(runtime.snapshot().historyRows, 1)
    assert.equal(runtime.snapshot().pendingIssuances, 0)
    await runtime.observeTable({ tableId: 'BAG01', shoe: 105, round: 20, bankerCount: 12, playerCount: 8, bigRoadRaw: 'B#P' })
    assert.equal(candidates[0].sameSideStreak, 8)
    assert.equal(runtime.snapshot().historyRows, 2)
    assert.equal(runtime.snapshot().pendingIssuances, 1)
  })

  test(`${item.label} restart restores latest pending issuance context but settles only through exact-read fallback`, async () => {
    const final = compactRow(item.version, { index: 19 })
    final.round_no = 19
    final.same_side_streak = 6
    const pending = compactRow(item.version, { index: 20, final: false })
    pending.round_no = 20
    pending.same_side_streak = 7
    const reads = []
    const settlements = []
    const candidates = []
    const exact = {
      predictionId: pending.prediction_id, issuedAt: pending.prediction_issued_at,
      source: pending.source, strategyVersion: item.version, predictionTiming: pending.prediction_timing,
      targetTableId: pending.table_id, targetShoe: pending.shoe_no, targetRound: pending.round_no,
      predictedResult: pending.predicted_result, sameSideStreak: pending.same_side_streak,
      heads: {
        main: { predictedResult: 'banker', units: 1 },
        tie: { action: false, units: 0 }, superSix: { action: false, units: 0 },
        bankerDragon: { action: false, units: 0 }, playerDragon: { action: false, units: 0 },
        bankerPair: { action: false, units: 0 }, playerPair: { action: false, units: 0 },
      },
    }
    const store = {
      configured: true,
      async [item.method]() { return [final, pending] },
      async [item.readMethod](identity) { reads.push(identity); return exact },
      async [item.settleMethod](settlement) {
        settlements.push(settlement)
        return { predictionId: settlement.predictionId, settlement_sequence: 1 }
      },
      async [item.issueMethod](candidate) {
        candidates.push(candidate)
        return { ...candidate, predictionId: `${item.label.toLowerCase()}-next`, issuedAt: '2026-07-29T00:01:00.000Z' }
      },
    }
    const module = await import(item.runtime)
    const runtime = module[item.factory]({ writer: store })

    await runtime.start()
    assert.deepEqual(runtime.getIssuanceContext('BAG01'), {
      shoe: '105', direction: 'banker', sameSideStreak: 7, round: 20,
    })
    assert.equal(runtime.snapshot().pendingIssuances, 0)
    await runtime.observeTable({ tableId: 'BAG01', shoe: 105, round: 20, bankerCount: 12, playerCount: 8, bigRoadRaw: 'B#P' })
    assert.equal(candidates[0].sameSideStreak, 8)
    await runtime.settleRound({ tableId: 'BAG01', shoe: 105, round: 20, sourceAction: '/show_win', winner: 'banker' })
    assert.equal(reads.length, 1)
    assert.equal(settlements[0].predictionId, pending.prediction_id)
    assert.equal(runtime.snapshot().historyRows, 3)
  })

  test(`${item.label} runtime retains at most 60 Final and one latest pending row per table`, async () => {
    const rows = [
      ...Array.from({ length: 61 }, (_, index) => compactRow(item.version, { index: index + 1 })),
      compactRow(item.version, { index: 62, final: false }),
      compactRow(item.version, { index: 63, final: false }),
    ]
    const store = { configured: true, async [item.method]() { return rows } }
    const module = await import(item.runtime)
    const runtime = module[item.factory]({ writer: store })

    await runtime.start()

    assert.equal(runtime.snapshot().historyRows, 61)
    assert.equal(runtime.snapshot().pendingIssuances, 0)
    assert.deepEqual(runtime.getIssuanceContext('BAG01'), {
      shoe: '105', direction: 'banker', sameSideStreak: 7, round: 63,
    })
  })
}

for (const item of CASES) {
  test(`${item.label} compact history reader accepts at most ten-table 60 Final plus one pending cap`, async () => {
    const rows = TABLE_IDS.flatMap((tableId, tableIndex) => [
      ...Array.from({ length: 60 }, (_, index) => compactRow(item.version, {
        tableId, index: tableIndex * 100 + index + 1,
      })),
      compactRow(item.version, { tableId, index: tableIndex * 100 + 61, final: false }),
    ]).sort((a, b) => Date.parse(a.prediction_issued_at) - Date.parse(b.prediction_issued_at)
      || String(a.prediction_id).localeCompare(String(b.prediction_id)))
    const client = createSupabaseIngestionClient({
      url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
      retryAttempts: 1, fetchImpl: async () => response(rows),
    })
    assert.equal((await client[item.method]({ perTableLimit: 60 })).length, 610)
  })
}
