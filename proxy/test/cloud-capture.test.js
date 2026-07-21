import test from 'node:test'
import assert from 'node:assert/strict'
import { applyCloudCapturePayload, createCloudCaptureClient, parseCloudCapturePayload } from '../src/cloud-capture.js'

test('parses cloud worker payload into normalized tables and status', () => {
  const payload = parseCloudCapturePayload({
    connected: true,
    authenticated: true,
    tables: [{ tableId: 'BAG01', displayName: 'MT百家樂第1桌', tableType: 'BAC', round: 12 }],
    rounds: [{ tableId: 'BAG01', shoe: 3, round: 12, winner: 'banker' }],
  })

  assert.equal(payload.status.captureSource, 'cloud_browser')
  assert.equal(payload.status.connected, true)
  assert.equal(payload.status.authenticated, true)
  assert.equal(payload.status.tableCount, 1)
  assert.equal(payload.tables[0].tableId, 'BAG01')
  assert.equal(payload.rounds[0].winner, 'banker')
})

test('stamps a trusted proxy receive time when MT tables omit sourceUpdatedAt', () => {
  const receivedAt = '2026-07-14T10:30:00.000Z'
  const payload = parseCloudCapturePayload({
    connected: true,
    authenticated: true,
    tables: [
      { tableId: 'BAG01', tableType: 'BAC', round: 12 },
      { tableId: 'BAG02', tableType: 'BAC', round: 13, sourceUpdatedAt: '2026-07-14T10:29:59.000Z' },
    ],
  }, receivedAt)

  assert.equal(payload.tables[0].sourceUpdatedAt, receivedAt)
  assert.equal(payload.tables[1].sourceUpdatedAt, '2026-07-14T10:29:59.000Z')
})

test('cloud capture sends worker admin key header when configured', async () => {
  const state = createFakeState()
  const client = createCloudCaptureClient({
    url: 'https://cloud-worker.example/snapshot',
    state,
    adminKey: 'worker-secret',
    fetchImpl: async (_url, init = {}) => {
      assert.equal(init.headers?.['x-worker-admin-key'], 'worker-secret')
      return { ok: true, status: 200, json: async () => ({ buildVersion: '104', connected: true, authenticated: true, tables: [] }) }
    },
  })
  await client.tick()
})

test('cloud capture tick fetches worker, updates state, and writes Supabase cloud rows', async () => {
  const writes = []
  const state = createFakeState()
  const client = createCloudCaptureClient({
    url: 'https://cloud-worker.example/snapshot',
    state,
    writer: {
      configured: true,
      writeCloudCaptureStatus: async (payload) => writes.push(['status', payload]),
      writeCloudTableSnapshot: async (payload) => writes.push(['snapshot', payload]),
      writeCloudRoundEvent: async (payload) => writes.push(['round', payload]),
    },
    fetchImpl: async (url) => {
      assert.equal(String(url), 'https://cloud-worker.example/snapshot')
      return {
        ok: true,
        status: 200,
        json: async () => ({
          buildVersion: '104',
          connected: true,
          authenticated: true,
          sessionId: 'cloud-session-1',
          tables: [{ tableId: 'BAG01', displayName: 'MT百家樂第1桌', tableType: 'BAC', round: 12 }],
          rounds: [{ tableId: 'BAG01', shoe: 3, round: 12, winner: 'player' }],
        }),
      }
    },
  })

  await client.tick()

  assert.equal(state.snapshot().status.captureSessionId, 'cloud-session-1')
  assert.equal(state.snapshot().status.tableCount, 1)
  assert.equal(state.snapshot().tables[0].tableId, 'BAG01')
  assert.deepEqual(writes.map(([kind]) => kind), ['status', 'snapshot', 'round'])
  assert.equal(writes[2][1].round.winner, 'player')
})

test('persists a backlog with bounded parallel round writes', async () => {
  let active = 0
  let maxActive = 0
  let writes = 0
  const parsed = {
    sessionId: 'cloud-session-batch',
    status: { connected: true, authenticated: true },
    tables: [{ tableId: 'BAG01' }],
    rounds: Array.from({ length: 13 }, (_, index) => ({ tableId: 'BAG01', shoe: 9, round: index + 1 })),
  }
  await applyCloudCapturePayload({
    parsed,
    state: createFakeState(),
    writer: {
      configured: true,
      writeCloudCaptureStatus: async () => {},
      writeCloudTableSnapshot: async () => {},
      writeCloudRoundEvent: async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setImmediate(resolve))
        writes += 1
        active -= 1
      },
    },
  })

  assert.equal(writes, 13)
  assert.equal(maxActive, 5)
})

test('cloud capture records worker HTTP errors without leaking secrets', async () => {
  const state = createFakeState()
  const client = createCloudCaptureClient({
    url: 'https://cloud-worker.example/snapshot?token=secret-token-value',
    state,
    fetchImpl: async () => ({ ok: false, status: 403, text: async () => 'blocked token=secret-token-value' }),
  })

  await client.tick()

  assert.equal(state.snapshot().status.connected, false)
  assert.match(state.snapshot().status.errorMessage, /403/)
  assert.doesNotMatch(state.snapshot().status.errorMessage, /secret-token-value/)
})

test('cloud capture clears stale tables when worker loses authenticated table payload', async () => {
  const state = createFakeState()
  state.setTables([{ tableId: 'BAG01', round: 35 }])
  const client = createCloudCaptureClient({
    url: 'https://cloud-worker.example/snapshot',
    state,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ buildVersion: '104', connected: true, authenticated: false, tables: [], errorMessage: 'MT page is open, but no table payload was detected yet.' }),
    }),
  })

  await client.tick()

  assert.equal(state.snapshot().tables.length, 0)
  assert.equal(state.snapshot().status.connected, true)
  assert.equal(state.snapshot().status.authenticated, false)
  assert.equal(state.snapshot().status.tableCount, 0)
})

test('cloud capture aborts a hung worker request instead of leaving stale state forever', async () => {
  const state = createFakeState()
  const client = createCloudCaptureClient({
    url: 'https://cloud-worker.example/snapshot',
    state,
    timeoutMs: 5,
    fetchImpl: async (_url, init = {}) => new Promise((resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted by test signal')))
    }),
  })

  await client.tick()

  assert.equal(state.snapshot().status.connected, false)
  assert.match(state.snapshot().status.errorMessage, /aborted by test signal/)
})


test('cloud capture retries a transient worker snapshot failure and replaces stale tables with fresh data', async () => {
  const state = createFakeState()
  state.setTables([{ tableId: 'BAG01', round: 35 }])
  let attempts = 0
  const client = createCloudCaptureClient({
    url: 'https://cloud-worker.example/snapshot',
    state,
    timeoutMs: 50,
    retryDelayMs: 1,
    fetchImpl: async () => {
      attempts += 1
      if (attempts === 1) throw new Error('temporary worker socket reset')
      return {
        ok: true,
        status: 200,
        json: async () => ({
          buildVersion: '104',
          connected: true,
          authenticated: true,
          sessionId: 'worker-recovered',
          tables: [{ tableId: 'BAG01', displayName: 'MT百家樂第1桌', tableType: 'BAC', round: 36 }],
        }),
      }
    },
  })

  const parsed = await client.tick()

  assert.equal(attempts, 2)
  assert.equal(parsed.sessionId, 'worker-recovered')
  assert.equal(state.snapshot().tables[0].round, 36)
  assert.equal(state.snapshot().status.connected, true)
})

function createFakeState() {
  const data = { status: {}, tables: [] }
  return {
    setStatus(next = {}) {
      data.status = { ...data.status, ...next }
    },
    setTables(tables = []) {
      data.tables = tables
      data.status.tableCount = tables.length
    },
    upsertRoundEvent(round = {}) {
      data.lastRound = round
    },
    recordError(message) {
      data.status.connected = false
      data.status.errorMessage = String(message)
    },
    snapshot() {
      return JSON.parse(JSON.stringify(data))
    },
  }
}
