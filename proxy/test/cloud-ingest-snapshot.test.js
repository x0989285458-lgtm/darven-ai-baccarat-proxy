import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'

const now = Date.parse('2026-07-12T08:00:00.000Z')
const key = 'test-ingest-key'

function body(overrides = {}) {
  return JSON.stringify({
    protocolVersion: 'v098',
    timestamp: now,
    sequence: 1,
    roundKeys: [],
    snapshot: {
      buildVersion: '098',
      connected: true,
      authenticated: true,
      sessionId: 'vm-worker',
      snapshotAt: new Date(now).toISOString(),
      tables: [{ tableId: 'BAG01', tableType: 'BAC', displayName: '測試桌', round: 9 }],
      rounds: [],
    },
    ...overrides,
  })
}

function createTestApp(extra = {}) {
  return createApp({ autoConnect: false, ingestKey: key, now: () => now, ...extra })
}

test('cloud ingest requires x-worker-key', async () => {
  const response = await createTestApp().inject({ method: 'POST', url: '/api/cloud-ingest/snapshot', body: body() })
  assert.equal(response.statusCode, 401)
})

test('cloud ingest rejects stale timestamps', async () => {
  const response = await createTestApp().inject({
    method: 'POST', url: '/api/cloud-ingest/snapshot', headers: { 'x-worker-key': key },
    body: body({ timestamp: now - 6 * 60 * 1000 }),
  })
  assert.equal(response.statusCode, 409)
  assert.match(JSON.parse(response.body).error, /timestamp/i)
})

test('cloud ingest treats duplicate sequence as idempotent without rewriting', async () => {
  let writes = 0
  const app = createTestApp({ supabaseClient: { configured: true, writeCloudTableSnapshot: async () => { writes += 1 } } })
  const request = { method: 'POST', url: '/api/cloud-ingest/snapshot', headers: { 'x-worker-key': key }, body: body() }
  assert.equal((await app.inject(request)).statusCode, 200)
  const duplicate = await app.inject(request)
  assert.equal(duplicate.statusCode, 200)
  assert.equal(JSON.parse(duplicate.body).duplicate, true)
  assert.equal(writes, 1)
})

test('valid cloud ingest updates tables and uses existing Supabase capture flow', async () => {
  const calls = []
  const app = createTestApp({
    supabaseClient: {
      configured: true,
      writeCloudCaptureStatus: async (value) => calls.push(['status', value]),
      writeCloudTableSnapshot: async (value) => calls.push(['tables', value]),
    },
  })
  const response = await app.inject({ method: 'POST', url: '/api/cloud-ingest/snapshot', headers: { 'x-worker-key': key }, body: body() })
  assert.equal(response.statusCode, 200)
  assert.equal(app.state.snapshot().tables[0].tableId, 'BAG01')
  assert.deepEqual(calls.map(([name]) => name), ['status', 'tables'])
})

test('v098.19 cloud ingest rejects an exact-looking provisional show_poker before any durable write', async () => {
  const writes = []
  const provisional = {
    tableId: 'BAG01', shoe: 14509, round: 7, winner: 'player',
    playerPoint: 5, bankerPoint: 0,
    rawResult: [31, 51, 25, 52, 0, 0, -1, -1, 5, 0],
    sourceAction: '/api/v1/gametype/*/game/*/room/*/table/*/show_poker',
  }
  const app = createTestApp({
    supabaseClient: {
      configured: true,
      writeCloudCaptureStatus: async () => writes.push('status'),
      writeCloudTableSnapshot: async () => writes.push('snapshot'),
      writeCloudRoundEvent: async () => writes.push('round'),
    },
  })
  const response = await app.inject({
    method: 'POST', url: '/api/cloud-ingest/snapshot', headers: { 'x-worker-key': key },
    body: body({
      roundKeys: ['BAG01:14509:7'],
      snapshot: {
        buildVersion: '098', connected: true, authenticated: true,
        sessionId: 'vm-worker', snapshotAt: new Date(now).toISOString(),
        tables: [{ tableId: 'BAG01', tableType: 'BAC', displayName: '測試桌', shoe: 14509, round: 8 }],
        rounds: [provisional],
      },
    }),
  })

  assert.equal(response.statusCode, 400)
  assert.match(JSON.parse(response.body).error, /provisional.*show_poker/i)
  assert.deepEqual(writes, [])
})

test('cloud ingest rejects malformed tables and oversized payloads', async () => {
  const app = createTestApp()
  const headers = { 'x-worker-key': key }
  const malformed = await app.inject({ method: 'POST', url: '/api/cloud-ingest/snapshot', headers, body: body({ snapshot: { buildVersion: '098', tables: {}, rounds: [] } }) })
  assert.equal(malformed.statusCode, 400)
  const oversized = await app.inject({ method: 'POST', url: '/api/cloud-ingest/snapshot', headers, body: `${body()}${' '.repeat(1024 * 1024)}` })
  assert.equal(oversized.statusCode, 413)
})
