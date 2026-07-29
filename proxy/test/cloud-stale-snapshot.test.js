import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'

const staleTime = new Date(Date.now() - 10 * 60 * 1000).toISOString()

test('api/tables does not serve stale Supabase cloud snapshots when live worker state is empty', async () => {
  const app = createApp({
    autoConnect: false,
    deployMode: 'cloud',
    captureSource: 'cloud_browser',
    supabaseClient: {
      configured: true,
      getLatestCloudTableSnapshot: async () => ({
        snapshot_at: staleTime,
        table_count: 17,
        tables: [{ tableId: 'BAG01', shoe: 14182, round: 35 }],
      }),
    },
  })

  const response = await app.inject({ method: 'GET', url: '/api/tables' })
  assert.deepEqual(JSON.parse(response.body), [])
})

test('api/tables replaces stale non-empty in-memory tables with a fresher durable snapshot', async () => {
  const currentTimeMs = Date.now()
  const freshTime = new Date(currentTimeMs).toISOString()
  let clock = currentTimeMs - 10 * 60 * 1000
  const app = createApp({
    autoConnect: false,
    deployMode: 'cloud',
    captureSource: 'cloud_browser',
    now: () => clock,
    supabaseClient: {
      configured: true,
      getLatestCloudTableSnapshot: async () => ({
        capture_source: 'cloud_browser',
        snapshot_at: freshTime,
        table_count: 1,
        tables: [{ tableId: 'BAG01', shoe: 14182, round: 36, sourceUpdatedAt: freshTime }],
      }),
    },
  })
  app.state.setStatus({ lastMessageAt: staleTime, lastRoundAt: staleTime })
  app.state.setTables([{ tableId: 'BAG01', shoe: 14182, round: 35, sourceUpdatedAt: staleTime }])
  clock = currentTimeMs

  const response = await app.inject({ method: 'GET', url: '/api/tables' })
  const tables = JSON.parse(response.body)
  assert.equal(tables.length, 1)
  assert.equal(tables[0].round, 36)
  assert.equal(tables[0].sourceUpdatedAt, freshTime)
})

test('api/status replaces stale non-empty in-memory capture state with fresher durable status', async () => {
  const freshTime = new Date().toISOString()
  const app = createApp({
    autoConnect: false,
    deployMode: 'cloud',
    captureSource: 'cloud_browser',
    ingestKey: 'worker-key',
    supabaseClient: {
      configured: true,
      getLatestCloudCaptureStatus: async () => ({
        capture_source: 'cloud_browser',
        session_id: 'fresh-session',
        connected: true,
        authenticated: true,
        table_count: 10,
        last_message_at: freshTime,
        last_round_at: freshTime,
      }),
      getLatestCloudTableSnapshot: async () => ({
        capture_source: 'cloud_browser',
        snapshot_at: freshTime,
        table_count: 10,
        tables: [{ tableId: 'BAG01', shoe: 14182, round: 36 }],
      }),
    },
  })
  const staleTables = ['BAG01','BAG02','BAG03','BAG03A','BAG05','BAG06','BAG07','BAG08','BAG09','BAG10']
    .map((tableId) => ({ tableId, shoe: 14182, round: 35, sourceUpdatedAt: staleTime }))
  app.state.setTables(staleTables)
  app.state.setStatus({
    captureSource: 'cloud_browser', captureSessionId: 'stale-session',
    connected: true, authenticated: true, tableCount: 10,
    lastMessageAt: staleTime, lastRoundAt: staleTime,
  })

  const response = await app.inject({ method: 'GET', url: '/api/status' })
  const body = JSON.parse(response.body)
  assert.equal(body.connected, true)
  assert.equal(body.authenticated, true)
  assert.equal(body.tableCount, 10)
  assert.equal(body.lastMessageAt, freshTime)
  assert.equal(body.lastRoundAt, freshTime)
  assert.equal(body.health, 'ok')
  assert.equal(body.degraded, false)
})

test('health fails closed when ten connected tables have no authoritative Final progress', async () => {
  const currentTimeMs = Date.now()
  const app = createApp({
    autoConnect: false,
    deployMode: 'cloud',
    captureSource: 'cloud_browser',
    ingestKey: 'worker-key',
    now: () => currentTimeMs,
  })
  const liveTables = ['BAG01','BAG02','BAG03','BAG03A','BAG05','BAG06','BAG07','BAG08','BAG09','BAG10']
    .map((tableId) => ({ tableId, shoe: 14182, round: 35, sourceUpdatedAt: new Date(currentTimeMs).toISOString() }))
  app.state.setTables(liveTables)
  app.state.setStatus({
    connected: true, authenticated: true, tableCount: 10,
    lastMessageAt: new Date(currentTimeMs).toISOString(),
    lastRoundAt: new Date(currentTimeMs - 10 * 60 * 1000).toISOString(),
  })

  const response = await app.inject({ method: 'GET', url: '/health' })
  const body = JSON.parse(response.body)
  assert.equal(response.statusCode, 503)
  assert.equal(body.health, 'degraded')
  assert.equal(body.degraded, true)
  assert.equal(body.reason, 'capture_progress_stale')
})

test('api/tables lets a newer durable sequence supersede an older in-memory empty tombstone', async () => {
  const fixedTime = new Date().toISOString()
  const app = createApp({
    autoConnect: false,
    deployMode: 'cloud',
    captureSource: 'cloud_browser',
    now: () => Date.parse(fixedTime),
    supabaseClient: {
      configured: true,
      getLatestCloudTableSnapshot: async () => ({
        session_id: 'vm-1', metadata: { sequence: 6 },
        capture_source: 'cloud_browser', snapshot_at: fixedTime, table_count: 1,
        tables: [{ tableId: 'BAG01', shoe: 14182, round: 36, sourceUpdatedAt: fixedTime }],
      }),
    },
  })
  app.state.setStatus({ captureSessionId: 'vm-1', captureSequence: 5, captureTimestamp: fixedTime })
  app.state.setTables([])

  const response = await app.inject({ method: 'GET', url: '/api/tables' })
  const tables = JSON.parse(response.body)
  assert.equal(tables.length, 1)
  assert.equal(tables[0].round, 36)
})

test('api/tables keeps an empty tombstone over an older durable sequence regardless of wall clock', async () => {
  const app = createApp({
    autoConnect: false, deployMode: 'cloud', captureSource: 'cloud_browser', now: () => Date.parse('2026-07-29T11:30:00.000Z'),
    supabaseClient: {
      configured: true,
      getLatestCloudTableSnapshot: async () => ({
        session_id: 'vm-1', metadata: { sequence: 4 }, snapshot_at: '2099-01-01T00:00:00.000Z',
        table_count: 1, tables: [{ tableId: 'BAG01', shoe: 1, round: 1 }],
      }),
    },
  })
  app.state.setStatus({ captureSessionId: 'vm-1', captureSequence: 5, captureTimestamp: '2026-07-29T11:30:00.000Z' })
  app.state.setTables([])
  assert.deepEqual(JSON.parse((await app.inject({ method: 'GET', url: '/api/tables' })).body), [])
})

test('health cold start reads durable status and fails closed on stale Final progress', async () => {
  const currentTimeMs = Date.now()
  const freshTime = new Date(currentTimeMs).toISOString()
  const oldFinalTime = new Date(currentTimeMs - 10 * 60 * 1000).toISOString()
  const app = createApp({
    autoConnect: false,
    deployMode: 'cloud',
    captureSource: 'cloud_browser',
    ingestKey: 'worker-key',
    now: () => currentTimeMs,
    supabaseClient: {
      configured: true,
      getLatestCloudCaptureStatus: async () => ({
        capture_source: 'cloud_browser', connected: true, authenticated: true, table_count: 10,
        last_message_at: freshTime, last_round_at: oldFinalTime,
      }),
      getLatestCloudTableSnapshot: async () => ({
        capture_source: 'cloud_browser', snapshot_at: freshTime, table_count: 10,
        tables: ['BAG01','BAG02','BAG03','BAG03A','BAG05','BAG06','BAG07','BAG08','BAG09','BAG10'].map((tableId) => ({ tableId })),
      }),
    },
  })

  const response = await app.inject({ method: 'GET', url: '/health' })
  const body = JSON.parse(response.body)
  assert.equal(response.statusCode, 503)
  assert.equal(body.reason, 'capture_progress_stale')
  assert.equal(body.tableCount, undefined)
})

test('health cold start fails closed when durable status cannot be read', async () => {
  const app = createApp({
    autoConnect: false, deployMode: 'cloud', captureSource: 'cloud_browser', ingestKey: 'worker-key',
    supabaseClient: {
      configured: true,
      getLatestCloudCaptureStatus: async () => { throw new Error('db down') },
      getLatestCloudTableSnapshot: async () => { throw new Error('db down') },
    },
  })
  const response = await app.inject({ method: 'GET', url: '/health' })
  const body = JSON.parse(response.body)
  assert.equal(response.statusCode, 503)
  assert.equal(body.degraded, true)
  assert.match(body.reason, /capture_(?:status_)?unavailable/)
})

test('api/status ignores stale cloud snapshot status instead of reporting connected 17 tables', async () => {
  const app = createApp({
    autoConnect: false,
    deployMode: 'cloud',
    captureSource: 'cloud_browser',
    supabaseClient: {
      configured: true,
      getLatestCloudCaptureStatus: async () => ({
        capture_source: 'cloud_browser',
        connected: true,
        authenticated: true,
        table_count: 17,
        last_message_at: staleTime,
      }),
      getLatestCloudTableSnapshot: async () => ({
        snapshot_at: staleTime,
        table_count: 17,
        tables: [{ tableId: 'BAG01', shoe: 14182, round: 35 }],
      }),
    },
  })

  const response = await app.inject({ method: 'GET', url: '/api/status' })
  const body = JSON.parse(response.body)
  assert.notEqual(body.connected, true)
  assert.notEqual(body.authenticated, true)
  assert.notEqual(body.tableCount, 17)
})
