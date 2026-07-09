import test from 'node:test'
import assert from 'node:assert/strict'
import { createCloudCaptureClient, parseCloudCapturePayload } from '../src/cloud-capture.js'

test('v040 parses cloud worker payload into normalized tables and status', () => {
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

test('v090 cloud capture sends worker admin key header when configured', async () => {
  const state = createFakeState()
  const client = createCloudCaptureClient({
    url: 'https://cloud-worker.example/snapshot',
    state,
    adminKey: 'worker-secret',
    fetchImpl: async (_url, init = {}) => {
      assert.equal(init.headers?.['x-worker-admin-key'], 'worker-secret')
      return { ok: true, status: 200, json: async () => ({ connected: true, authenticated: true, tables: [] }) }
    },
  })
  await client.tick()
})

test('v040 cloud capture tick fetches worker, updates state, and writes Supabase cloud rows', async () => {
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

test('v040 cloud capture records worker HTTP errors without leaking secrets', async () => {
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

test('v052 cloud capture clears stale tables when worker loses authenticated table payload', async () => {
  const state = createFakeState()
  state.setTables([{ tableId: 'BAG01', round: 35 }])
  const client = createCloudCaptureClient({
    url: 'https://cloud-worker.example/snapshot',
    state,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ connected: true, authenticated: false, tables: [], errorMessage: 'MT page is open, but no table payload was detected yet.' }),
    }),
  })

  await client.tick()

  assert.equal(state.snapshot().tables.length, 0)
  assert.equal(state.snapshot().status.connected, true)
  assert.equal(state.snapshot().status.authenticated, false)
  assert.equal(state.snapshot().status.tableCount, 0)
})

test('v052 cloud capture aborts a hung worker request instead of leaving stale state forever', async () => {
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
