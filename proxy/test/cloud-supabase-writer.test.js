import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCloudCaptureStatusRow,
  buildCloudTableSnapshotRow,
  buildCloudRoundEventRow,
  buildCloudStrategyReportRow,
  buildLivePrediction,
  buildStrategyAdjustmentStatsRows,
  createSupabaseIngestionClient,
  resolveBackendReadConnectionString,
} from '../src/supabase-writer.js'

test('formal issued-prediction identity reads use the backend transaction connection without REST', async () => {
  const queries = []
  const prediction = {
    targetTableId: 'BAG01', targetShoe: 8, targetRound: 9,
    strategyVersion: 'v105', predictionTiming: 'pre_result_context',
  }
  const client = createSupabaseIngestionClient({
    url: 'https://example.invalid', serviceKey: 'fixture-key', requestTimeoutMs: 30000,
    fetchImpl: async () => { throw new Error('REST must not be used') },
    strategyPool: { query: async (query) => {
      queries.push(query)
      return { rows: [{
        id: 'prediction-1', source: 'ofalive99', table_id: 'BAG01', shoe_no: '8', round_no: 9,
        strategy_version: 'v105', prediction_issued_at: '2026-07-26T00:00:00.000Z',
        issued_prediction_payload: prediction, settlement_final: false,
      }] }
    } },
  })

  const issued = await client.readIssuedPrediction({ tableId: 'BAG01', shoe: 8, round: 9, strategyVersion: 'v105' })
  assert.equal(issued.predictionId, 'prediction-1')
  assert.equal(queries.length, 1)
  assert.match(queries[0].text, /from public\.daily_prediction_results/i)
  assert.equal(queries[0].query_timeout, 30000)
  assert.deepEqual(queries[0].values, ['ofalive99', 'BAG01', '8', 9, 'v105'])
})

test('backend formal reads use Supabase transaction pooler without rewriting unrelated database URLs', () => {
  const session = 'postgresql://user:secret@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres'
  const transaction = new URL(resolveBackendReadConnectionString(session))
  assert.equal(transaction.port, '6543')
  assert.equal(transaction.hostname, 'aws-1-ap-southeast-1.pooler.supabase.com')
  assert.equal(decodeURIComponent(transaction.password), 'secret')

  const direct = 'postgresql://user:secret@db.example.com:5432/postgres'
  assert.equal(resolveBackendReadConnectionString(direct), direct)
})

test('backend transaction connection survives idle periods and allows one bounded cold connection', () => {
  let config = null
  createSupabaseIngestionClient({
    dbConnectionString: 'postgresql://user:secret@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres',
    strategyPoolFactory: (value) => { config = value; return { query: async () => ({ rows: [] }) } },
  })
  assert.equal(new URL(config.connectionString).port, '6543')
  assert.equal(config.connectionTimeoutMillis, 60000)
  assert.equal(config.idleTimeoutMillis, 0)
  assert.equal(config.max, 4)
})

test('builds cloud capture status row without leaking tokenized URL', () => {
  const row = buildCloudCaptureStatusRow({
    sessionId: 'session-1',
    captureSource: 'cloud_browser',
    status: { connected: true, authenticated: true, tableCount: 9, errorMessage: 'url token=abc123secret failed' },
    metadata: { worker: 'browserless' },
  })

  assert.equal(row.session_id, 'session-1')
  assert.equal(row.capture_source, 'cloud_browser')
  assert.equal(row.connected, true)
  assert.equal(row.authenticated, true)
  assert.equal(row.table_count, 9)
  assert.equal(row.error_message, 'url token=[redacted] failed')
  assert.deepEqual(row.metadata, { worker: 'browserless' })
})

test('builds a fallback snapshot without duplicate table summary storage', () => {
  const row = buildCloudTableSnapshotRow({
    sessionId: 'session-1',
    tables: [{ tableId: 'BAG01', displayName: 'MT百家樂第1桌', shoe: 3, round: 12 }],
    status: { captureSource: 'cloud_browser' },
  })

  assert.equal(row.session_id, 'session-1')
  assert.equal(row.capture_source, 'cloud_browser')
  assert.equal(row.table_count, 1)
  assert.equal(row.tables[0].tableId, 'BAG01')
  assert.deepEqual(row.table_summary, [])
})

test('cloud table snapshot carries an already-issued v104 backend prediction without recomputing it', () => {
  const issuedPrediction = buildLivePrediction({
    tableId: 'BAG01', shoe: 3, round: 12,
    bankerCount: 10, playerCount: 18, tieCount: 2,
    beadPlateRaw: '0101010101020202', bigRoadRaw: '0101,0101,#0202,0202',
  }, {
    strategyVersion: 'v104', buildVersion: 'v104',
  })
  const row = buildCloudTableSnapshotRow({
    sessionId: 'session-1',
    tables: [{
      tableId: 'BAG01',
      displayName: 'MT百家樂第1桌',
      shoe: 3,
      round: 12,
      bankerCount: 10,
      playerCount: 18,
      tieCount: 2,
      beadPlateRaw: '0101010101020202',
      bigRoadRaw: '0101,0101,#0202,0202',
      prediction: { ...issuedPrediction, predictionId: 'issued-v104', issuedAt: '2026-07-21T00:00:00Z' },
    }],
    status: { captureSource: 'cloud_browser' },
  })

  assert.equal(row.tables[0].prediction.source, 'backend')
  assert.equal(row.tables[0].prediction.strategyVersion, 'v104')
  assert.equal(row.tables[0].prediction.predictionId, 'issued-v104')
  assert.match(row.tables[0].prediction.predictedResult, /^(banker|player)$/)
  assert.equal(row.tables[0].prediction.confidence >= 30, true)
  assert.equal(row.tables[0].prediction.confidence <= 70, true)
  assert.deepEqual(row.table_summary, [])
})

test('cloud table snapshot fails closed instead of inventing an unissued v104 prediction', () => {
  const row = buildCloudTableSnapshotRow({
    sessionId: 'session-1',
    tables: [{ tableId: 'BAG01', shoe: 3, round: 12 }],
    status: { captureSource: 'cloud_browser' },
  })
  assert.equal(row.tables[0].prediction, undefined)
})

test('builds cloud round, strategy report, and adjustment stats rows', () => {
  const round = buildCloudRoundEventRow({
    sessionId: 'session-1',
    round: { tableId: 'BAG01', shoe: 3, round: 12, winner: 'banker', receivedAt: '2026-06-30T00:00:00.000Z' },
    table: { displayName: 'MT百家樂第1桌' },
  })
  assert.equal(round.session_id, 'session-1')
  assert.equal(round.table_id, 'BAG01')
  assert.equal(round.main_result, 'banker')

  const report = buildCloudStrategyReportRow({
    report: { version: '039', total: { rounds: 300, hits: 168, misses: 132, pushes: 0, hitRate: 56 } },
    reportPath: 'reports/v039.png',
  })
  assert.equal(report.strategy_version, '039')
  assert.equal(report.rounds, 300)
  assert.equal(report.main_hit_rate, 56)

  const stats = buildStrategyAdjustmentStatsRows({
    reportId: 'report-1',
    stats: {
      normal: { hits: 10, misses: 8, evaluated: 18, hitRate: 55.56 },
      reverseCorrection: { hits: 4, misses: 2, evaluated: 6, hitRate: 66.67 },
    },
  })
  assert.equal(stats.length, 2)
  assert.deepEqual(stats.map((row) => row.strategy_mode), ['normal', 'reverse_correction'])
})

test('client writes cloud capture data to Supabase REST tables', async () => {
  const requests = []
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co',
    serviceKey: 'sb_secret_test_key',
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init, body: JSON.parse(init.body) })
      if (String(url).includes('/rpc/persist_latest_cloud_table_snapshot')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ persisted: true, inserted: false }) }
      }
      return { ok: true, status: 201, text: async () => '' }
    },
  })

  await client.writeCloudCaptureStatus({ sessionId: 'session-1', status: { connected: true, tableCount: 9 } })
  await client.writeCloudTableSnapshot({ sessionId: 'session-1', tables: [{ tableId: 'BAG01' }] })
  await client.writeCloudRoundEvent({ sessionId: 'session-1', round: { tableId: 'BAG01', round: 1, winner: 'player' } })
  await client.writeCloudStrategyReport({ report: { version: '039', total: { rounds: 300, hits: 168, misses: 132, hitRate: 56 } } })
  await client.writeStrategyAdjustmentStats({ reportId: 'report-1', stats: { normal: { hits: 1, misses: 1, evaluated: 2, hitRate: 50 } } })

  assert.deepEqual(requests.map((request) => new URL(request.url).pathname), [
    '/rest/v1/cloud_capture_status',
    '/rest/v1/rpc/persist_latest_cloud_table_snapshot',
    '/rest/v1/cloud_table_rounds',
    '/rest/v1/cloud_strategy_reports',
    '/rest/v1/cloud_strategy_adjustment_stats',
  ])
  assert.equal(requests[0].init.headers.Authorization, 'Bearer sb_secret_test_key')
})

test('formal capture status snapshot and round writes share the backend transaction connection', async () => {
  const queries = []
  let fetchCalls = 0
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    fetchImpl: async () => { fetchCalls += 1; throw new Error('REST must not be used') },
    strategyPool: { async query(value) {
      queries.push(value)
      if (/persist_latest_cloud_table_snapshot/.test(value.text)) {
        return { rows: [{ persist_latest_cloud_table_snapshot: { persisted: true } }] }
      }
      return { rows: [] }
    } },
  })
  await client.writeCloudCaptureStatus({ sessionId: 'formal-session', status: { connected: true, authenticated: true, tableCount: 10 } })
  await client.writeCloudTableSnapshot({ sessionId: 'formal-session', tables: [], status: { connected: true, authenticated: true } })
  await client.writeCloudRoundEvent({ sessionId: 'formal-session', round: { tableId: 'BAG01', shoe: 88, round: 21, rawResult: [1, 9, 2, 10, -1, -1, -1, -1, 3, 9] }, table: { tableId: 'BAG01' } })
  assert.equal(fetchCalls, 0)
  assert.equal(queries.length, 3)
  assert.match(queries[0].text, /insert into public\.cloud_capture_status/)
  assert.match(queries[1].text, /public\.persist_latest_cloud_table_snapshot\(\$1::jsonb\)/)
  assert.match(queries[2].text, /insert into public\.cloud_table_rounds/)
})

test('formal round batch uses one backend transaction query for the complete bounded envelope', async () => {
  const queries = []
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    strategyPool: { async query(value) { queries.push(value); return { rows: [] } } },
  })
  const payloads = [1, 2, 3].map((roundNo) => ({
    sessionId: 'formal-session',
    round: { tableId: `BAG0${roundNo}`, shoe: 88, round: roundNo, rawResult: [1, 9, 2, 10, -1, -1, -1, -1, 3, 9] },
    table: { tableId: `BAG0${roundNo}` },
  }))
  const result = await client.writeCloudRoundEvents(payloads)
  assert.equal(result.ok, true)
  assert.equal(result.rows.length, 3)
  assert.equal(queries.length, 1)
  assert.match(queries[0].text, /jsonb_to_recordset\(\$1::jsonb\)/)
  assert.equal(JSON.parse(queries[0].values[0]).length, 3)
})

test('formal Supabase writes abort within the configured request deadline', async () => {
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co',
    serviceKey: 'sb_secret_test_key',
    retryAttempts: 1,
    requestTimeoutMs: 5,
    startupRequestTimeoutMs: 5,
    fetchImpl: async (_url, init = {}) => new Promise((resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('request aborted', 'AbortError')))
    }),
  })

  await assert.rejects(
    Promise.race([
      client.writeCloudCaptureStatus({ sessionId: 'session-timeout', status: { connected: true, tableCount: 10 } }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('formal write remained hung')), 100)),
    ]),
    /abort/i,
  )
})

test('durable ingest writes use their own bounded deadline instead of the short live-read deadline', async () => {
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'sb_secret_test_key', retryAttempts: 1,
    requestTimeoutMs: 5, durableWriteRequestTimeoutMs: 40,
    fetchImpl: async (_url, init = {}) => new Promise((resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('request aborted', 'AbortError')))
    }),
  })
  const started = Date.now()
  await assert.rejects(client.writeCloudCaptureStatus({ sessionId: 'durable-timeout', status: { connected: true, tableCount: 10 } }), /abort/i)
  assert.ok(Date.now() - started >= 30)
})

test('formal Supabase reads abort within the configured request deadline', async () => {
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co',
    serviceKey: 'sb_secret_test_key',
    retryAttempts: 1,
    requestTimeoutMs: 5,
    startupRequestTimeoutMs: 5,
    fetchImpl: async (_url, init = {}) => new Promise((resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('request aborted', 'AbortError')))
    }),
  })

  await assert.rejects(
    Promise.race([
      client.readIssuedPrediction({ tableId: 'BAG01', shoe: 88, round: 20, strategyVersion: 'v105' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('formal read remained hung')), 100)),
    ]),
    /abort/i,
  )
})

test('formal Supabase RPC reads and strategy patches share the configured deadline', async () => {
  const makeClient = () => createSupabaseIngestionClient({
    url: 'https://example.supabase.co',
    serviceKey: 'sb_secret_test_key',
    retryAttempts: 1,
    requestTimeoutMs: 5,
    startupRequestTimeoutMs: 5,
    fetchImpl: async (_url, init = {}) => new Promise((resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('request aborted', 'AbortError')))
    }),
  })

  await assert.rejects(
    Promise.race([
      makeClient().getRecentPredictionRows({ limit: 10 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('formal RPC read remained hung')), 100)),
    ]),
    /abort/i,
  )
  const strategyClient = makeClient()
  await assert.rejects(
    Promise.race([
      strategyClient.ensureInitialStrategy(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('formal strategy patch remained hung')), 100)),
    ]),
    /active strategy verification failed|abort/i,
  )
  assert.equal(strategyClient.getRuntimeStatus().degraded, true)
})

test('startup strategy verification has a wider bounded deadline than live requests', async () => {
  let calls = 0
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co',
    serviceKey: 'sb_secret_test_key',
    retryAttempts: 1,
    requestTimeoutMs: 5,
    startupRequestTimeoutMs: 50,
    fetchImpl: async (_url, init = {}) => {
      calls += 1
      if (calls === 1) await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 15)
        init.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('request aborted', 'AbortError')) })
      })
      const active = calls === 3 ? [{ version: 'v105', status: 'active' }] : []
      return { ok: true, status: 200, text: async () => JSON.stringify(active), json: async () => active }
    },
  })

  const result = await client.ensureInitialStrategy()
  assert.equal(result.ok, true)
  assert.equal(calls, 3)
})

test('startup strategy verification trusts one exact active version from the backend-only database before REST mutation', async () => {
  let fetchCalls = 0
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co',
    serviceKey: 'service-role-test-key',
    requireVerifiedStrategy: true,
    strategyPool: {
      async query() { return { rows: [{ version: 'v105', status: 'active' }] } },
    },
    fetchImpl: async () => { fetchCalls += 1; throw new Error('REST should not be needed') },
  })
  const result = await client.ensureInitialStrategy()
  assert.equal(result.ok, true)
  assert.equal(client.getRuntimeStatus().ready, true)
  assert.equal(fetchCalls, 0)
})

test('client reads latest cloud capture status and table snapshot from Supabase REST', async () => {
  const requests = []
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co',
    serviceKey: 'sb_secret_test_key',
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init })
      if (String(url).includes('cloud_table_snapshots')) {
        return { ok: true, json: async () => [{ session_id: 'local-vpn', tables: [{ tableId: 'BAG01' }] }], text: async () => '' }
      }
      return { ok: true, json: async () => [{ session_id: 'local-vpn', connected: true, table_count: 1 }], text: async () => '' }
    },
  })

  const snapshot = await client.getLatestCloudTableSnapshot()
  const status = await client.getLatestCloudCaptureStatus()

  assert.equal(snapshot.tables[0].tableId, 'BAG01')
  assert.equal(status.connected, true)
  assert.deepEqual(requests.map((request) => new URL(request.url).searchParams.get('order')), ['snapshot_at.desc', 'updated_at.desc'])
  assert.deepEqual(requests.map((request) => new URL(request.url).searchParams.get('table_count')), ['gt.0', 'gt.0'])
})
