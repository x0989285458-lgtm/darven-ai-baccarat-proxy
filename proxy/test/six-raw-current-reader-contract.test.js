import test from 'node:test'
import assert from 'node:assert/strict'
import { createSupabaseIngestionClient } from '../src/supabase-writer.js'

// Six-raw CURRENT reader lane. BAG historical/restore lanes remain unchanged.
const FORMAL_TABLES = ['BAV01', 'BAV02', 'BAV03', 'BAV03A', 'BAV05', 'BAV06']
const TABLE_IDS = FORMAL_TABLES
function response(rows) { return { ok: true, status: 200, json: async () => rows, text: async () => JSON.stringify(rows) } }


// Adapted from cloud-supabase-writer.test.js: v105 formal history hydrates all latest table states in one bounded direct query; original lane retained.
test('six-raw current: v105 formal history hydrates all latest table states in one bounded direct query', async () => {
  const queries = []
  const settled = FORMAL_TABLES.flatMap((tableId) => Array.from({ length: 60 }, (_, index) => ({
    id: `${tableId}-settled-${index}`,
    table_id: tableId,
    strategy_version: 'v104',
    prediction_timing: 'pre_result_context',
    prediction_issued_at: `2026-07-25T00:${String(index).padStart(2, '0')}:00.000Z`,
    settlement_final: true,
  })))
  const latest = FORMAL_TABLES.map((tableId) => ({
    id: `${tableId}-latest`, table_id: tableId, strategy_version: 'v104',
    prediction_timing: 'pre_result_context', prediction_issued_at: '2026-07-26T00:00:00.000Z',
  }))
  const client = createSupabaseIngestionClient({
    strategyPool: { query: async (query) => {
      queries.push(query)
      return { rows: queries.length === 1 ? settled : latest }
    } },
  })

  const rows = await client.getV105FormalHistory({ limit: 1000, requestTimeoutMs: 30000 })
  assert.equal(rows.length, FORMAL_TABLES.length * 61)
  assert.equal(queries.length, 2)
  assert.match(queries[1].text, /cross join lateral/i)
  assert.match(queries[1].text, /order by prediction_issued_at desc\s+limit 1/i)
  assert.deepEqual(queries[1].values, [FORMAL_TABLES, ['v104', 'v105']])
})

// Adapted from cloud-supabase-writer.test.js: v105 formal history accepts an explicitly empty reset and partial v105-only restart history; original lane retained.
test('six-raw current: v105 formal history accepts an explicitly empty reset and partial v105-only restart history', async () => {
  const emptyClient = createSupabaseIngestionClient({
    strategyPool: { query: async () => ({ rows: [] }) },
  })
  assert.deepEqual(await emptyClient.getV105FormalHistory({ requestTimeoutMs: 30000 }), [])

  let queryCount = 0
  const partial = {
    id: 'v105-reset-1', table_id: 'BAV01', strategy_version: 'v105',
    prediction_timing: 'pre_result_context', prediction_issued_at: '2026-07-27T00:00:00.000Z',
    settlement_final: true,
  }
  const partialClient = createSupabaseIngestionClient({
    strategyPool: { query: async () => ({ rows: ++queryCount === 1 ? [partial] : [partial] }) },
  })
  const rows = await partialClient.getV105FormalHistory({ requestTimeoutMs: 30000 })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].prediction_id, partial.id)
  assert.equal(rows[0].table_id, partial.table_id)
  assert.equal(rows[0].strategy_version, 'v105')
})

// Adapted from cloud-supabase-writer.test.js: v105 formal history still fails closed on incomplete predecessor hydration; original lane retained.
test('six-raw current: v105 formal history still fails closed on incomplete predecessor hydration', async () => {
  let queryCount = 0
  const partialV104 = {
    id: 'v104-partial', table_id: 'BAV01', strategy_version: 'v104',
    prediction_timing: 'pre_result_context', prediction_issued_at: '2026-07-26T00:00:00.000Z',
    settlement_final: true,
  }
  const client = createSupabaseIngestionClient({
    strategyPool: { query: async () => ({ rows: ++queryCount === 1 ? [partialV104] : [partialV104] }) },
  })
  await assert.rejects(
    client.getV105FormalHistory({ requestTimeoutMs: 30000 }),
    /requires 60 settled rows for BAV01/,
  )
})

// Adapted from final-statistics.test.js: recent calibration rows quarantine predictions without a verified final settlement marker; original lane retained.
test('six-raw current: recent calibration rows quarantine predictions without a verified final settlement marker', async () => {
  let requestedUrl
  let requestedInit
  const finalRow = {
    table_id: 'BAV01', shoe_no: '8', round_no: 3,
    strategy_version: 'v105', predicted_result: 'banker', actual_result: 'banker', is_hit: true,
    settlement_final: true, prediction_issued_at: '2026-07-15T08:02:00Z',
    prediction_features: { settlement_final: true, prediction_timing: 'pre_result_context' }, created_at: '2026-07-15T08:03:00Z',
  }
  const legacyRow = {
    ...finalRow, round_no: 2, actual_result: 'player', is_hit: false,
    settlement_final: null, prediction_features: { settlement_final: true }, created_at: '2026-07-15T08:02:00Z',
  }
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-service-key',
    fetchImpl: async (url, init) => { requestedUrl = new URL(url); requestedInit = init; return response([finalRow, legacyRow]) },
  })

  assert.deepEqual(await client.getRecentPredictionRows({ limit: 100 }), [finalRow])
  assert.equal(requestedUrl.pathname, '/rest/v1/rpc/get_v105_recent_performance_rows')
  assert.equal(requestedInit.method, 'POST')
  assert.deepEqual(JSON.parse(requestedInit.body), { p_per_table_limit: 60 })
})

// Adapted from final-statistics.test.js: v102 recent calibration reads and accepts only v102 settlements; original lane retained.
test('six-raw current: v102 recent calibration reads and accepts only v102 settlements', async () => {
  let requestedUrl
  let requestedInit
  const v102Row = {
    table_id: 'BAV01', shoe_no: '100', round_no: 2,
    strategy_version: 'v105', predicted_result: 'banker', actual_result: 'banker', is_hit: true,
    settlement_final: true, prediction_issued_at: '2026-07-18T08:01:00Z',
    prediction_features: { settlement_final: true, prediction_timing: 'pre_result_context' }, created_at: '2026-07-18T08:02:00Z',
  }
  const v98Row = {
    ...v102Row, round_no: 1, strategy_version: 'v98', created_at: '2026-07-18T08:01:00Z',
  }
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-service-key',
    fetchImpl: async (url, init) => { requestedUrl = new URL(url); requestedInit = init; return response([v102Row, v98Row]) },
  })

  assert.deepEqual(await client.getRecentPredictionRows({ limit: 100 }), [v102Row])
  assert.equal(requestedUrl.pathname, '/rest/v1/rpc/get_v105_recent_performance_rows')
  assert.equal(requestedInit.method, 'POST')
  assert.deepEqual(JSON.parse(requestedInit.body), { p_per_table_limit: 60 })
})

// Adapted from final-statistics.test.js: v102 recent calibration rejects post-result or non-issued history; original lane retained.
test('six-raw current: v102 recent calibration rejects post-result or non-issued history', async () => {
  const causal = {
    id: 'causal', table_id: 'BAV01', shoe_no: '100', round_no: 3,
    strategy_version: 'v105', predicted_result: 'banker', actual_result: 'banker', is_hit: true,
    settlement_final: true, prediction_issued_at: '2026-07-18T08:02:00Z',
    prediction_features: { prediction_timing: 'pre_result_context' }, created_at: '2026-07-18T08:03:00Z',
  }
  const postResult = {
    ...causal, id: 'post-result', round_no: 2, prediction_features: { prediction_timing: 'post_result_context' },
  }
  const notIssued = { ...causal, id: 'not-issued', round_no: 1, prediction_issued_at: null }
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-service-key',
    fetchImpl: async () => response([causal, postResult, notIssued]),
  })

  assert.deepEqual((await client.getRecentPredictionRows({ limit: 60 })).map((row) => row.id), ['causal'])
})

// Adapted from prediction-integrity.test.js: v102 readers require complete current final columns and exclude compatibility and pending rows; original lane retained.
test('six-raw current: v102 readers require complete current final columns and exclude compatibility and pending rows', async () => {
  const requests = []
  const compatibility = { id: 'compatibility', table_id: 'BAV01', shoe_no: '88', round_no: 3, strategy_version: 'v105', predicted_result: 'banker', actual_result: 'banker', is_hit: true, settlement_final: null, side_hits: null, prediction_issued_at: '2026-07-16T00:59:00Z', prediction_features: { prediction_timing: 'pre_result_context', settlement_final: true, side_hits: { tie: false } }, created_at: '2026-07-16T01:00:00Z' }
  const modern = { ...compatibility, id: 'modern', round_no: 4, settlement_final: true, side_hits: { tie: true }, prediction_features: { prediction_timing: 'pre_result_context' }, created_at: '2026-07-16T01:01:00Z' }
  const pending = { ...modern, id: 'pending', round_no: 5, actual_result: null, is_hit: null, settlement_final: false }
  const client = createSupabaseIngestionClient({ url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false, fetchImpl: async (url) => { requests.push(new URL(url)); return response([modern, compatibility, pending]) } })
  assert.deepEqual((await client.getStablePredictionRows()).map((row) => row.id), ['modern'])
  assert.deepEqual((await client.getRecentPredictionRows()).map((row) => row.id), ['modern'])
  assert.deepEqual((await client.getTableUiSettledPredictions({ tableId: 'BAV01', shoe: 88 })).map((row) => row.round), [4])
  assert.equal(await client.countTodayPredictionRounds(), 1)
  for (const url of requests) {
    if (url.pathname.endsWith('/rpc/get_v105_recent_performance_rows')) {
      assert.equal(url.search, '')
      continue
    }
    assert.match(url.searchParams.get('select') ?? '', /settlement_final/)
    assert.equal(url.searchParams.get('strategy_version'), 'eq.v105')
    assert.equal(url.searchParams.get('settlement_final'), 'eq.true')
    assert.equal(url.searchParams.has('or'), false)
  }
})

const COMPACT_KEYS = [
  'actual_result', 'prediction_id', 'prediction_issued_at', 'prediction_timing', 'predicted_result',
  'round_no', 'same_side_streak', 'settlement_final', 'shoe_no', 'source', 'strategy_version', 'table_id',
].sort()

function compactRow(version, { tableId = 'BAV01', index = 1, final = true } = {}) {
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



const item = { label: 'V9', version: 'v105-shadow-v9-weighted-v7-v8', rpc: 'get_v105_shadow_v9_compact_history', method: 'getV105ShadowV9History' }

// Current reader only; original BAG restart/runtime fixtures are retained.
test(`six-raw current: ${item.label} history reader posts the compact per-table RPC and returns only the compact schema`, async () => {
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

// Current reader only; original BAG restart/runtime fixtures are retained.
test(`six-raw current: ${item.label} history reader fails closed on out-of-range limits and malformed compact rows`, async () => {
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

// Current reader only; original BAG restart/runtime fixtures are retained.
test(`six-raw current: ${item.label} history reader allows one pending row beside the Final limit and rejects excess or duplicate rows`, async () => {
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

// Current reader only; original BAG restart/runtime fixtures are retained.
test(`six-raw current: ${item.label} compact history reader accepts at most six-table 60 Final plus one pending cap`, async () => {
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
    assert.equal((await client[item.method]({ perTableLimit: 60 })).length, TABLE_IDS.length * 61)
  })

// Current reader only; original BAG restart/runtime fixtures are retained.
test('six-raw current: Direct DB compact history preserves millisecond ordering from pg Date objects', async () => {
  const version = 'v105-shadow-v9-weighted-v7-v8'
  const first = {
    ...compactRow(version, { index: 1 }),
    prediction_id: 'ad53098a-ab2b-4cda-8e66-854e47561f69',
    prediction_issued_at: new Date('2026-07-29T14:20:23.839Z'),
  }
  const second = {
    ...compactRow(version, { index: 2 }),
    prediction_id: '9f3add63-1845-487a-ad4c-246604cf47c6',
    prediction_issued_at: new Date('2026-07-29T14:20:23.945Z'),
  }
  const strategyPool = { async query() { return { rows: [first, second] } } }
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    strategyPool,
  })

  const rows = await client.getV105ShadowV9History({ perTableLimit: 60 })

  assert.equal(rows.length, 2)
  assert.equal(rows[0].prediction_id, first.prediction_id)
  assert.equal(rows[1].prediction_id, second.prediction_id)
})

// Current reader only; original BAG restart/runtime fixtures are retained.
test('six-raw current: compact history rejects non-Date non-RFC3339 and timezone-less timestamps', async () => {
  const version = 'v105-shadow-v9-weighted-v7-v8'
  for (const invalidTimestamp of [
    0, 1, '2026-07-29T14:20:23', new Date('invalid'),
    '2026-02-30T14:20:23Z', '2026-04-31T14:20:23Z', '2026-02-29T14:20:23Z',
    '2026-07-29T24:00:00Z', '2026-07-29T14:60:00Z', '2026-07-29T14:20:60Z',
    '2026-07-29T14:20:23+24:00', '2026-07-29T14:20:23+12:60',
  ]) {
    const row = { ...compactRow(version), prediction_issued_at: invalidTimestamp }
    const strategyPool = { async query() { return { rows: [row] } } }
    const client = createSupabaseIngestionClient({
      url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
      strategyPool,
    })
    await assert.rejects(client.getV105ShadowV9History({ perTableLimit: 60 }), /compact history/i)
  }
})
