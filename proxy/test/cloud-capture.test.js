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

test('uses trusted proxy receive time for progress when a Final envelope arrives', () => {
  const receivedAt = '2026-07-29T10:32:43.180Z'
  const payload = parseCloudCapturePayload({
    connected: true,
    authenticated: true,
    lastMessageAt: '2026-07-29T09:52:59.561Z',
    tables: [{ tableId: 'BAG01', tableType: 'BAC', shoe: 8, round: 12 }],
    rounds: [{
      tableId: 'BAG01', shoe: 8, round: 12, winner: 'banker',
      receivedAt: '2026-07-29T09:52:59.561Z',
    }],
  }, receivedAt)

  assert.equal(payload.status.lastMessageAt, receivedAt)
  assert.equal(payload.status.lastRoundAt, receivedAt)
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
      return { ok: true, status: 200, json: async () => ({ buildVersion: '105', connected: true, authenticated: true, tables: [] }) }
    },
  })
  await client.tick()
})

test('overlapping cloud capture ticks share one in-flight worker snapshot', async () => {
  let resolveFetch
  let fetchCalls = 0
  const client = createCloudCaptureClient({
    url: 'https://cloud-worker.example/snapshot',
    state: createFakeState(),
    fetchImpl: async () => {
      fetchCalls += 1
      return new Promise((resolve) => { resolveFetch = resolve })
    },
  })

  const first = client.tick()
  const second = client.tick()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fetchCalls, 1)
  resolveFetch({
    ok: true,
    status: 200,
    json: async () => ({ buildVersion: '105', connected: true, authenticated: true, sessionId: 'single-flight', tables: [] }),
  })
  const [firstResult, secondResult] = await Promise.all([first, second])
  assert.equal(firstResult.sessionId, 'single-flight')
  assert.equal(secondResult.sessionId, 'single-flight')
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
          buildVersion: '105',
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

test('durable capture failures identify the exact persistence stage', async () => {
  await assert.rejects(
    applyCloudCapturePayload({
      parsed: { sessionId: 'stage-test', status: { connected: true }, tables: [], rounds: [] },
      state: createFakeState(),
      writer: {
        configured: true,
        writeCloudCaptureStatus: async () => { throw new DOMException('request aborted', 'AbortError') },
        writeCloudTableSnapshot: async () => {},
        writeCloudRoundEvent: async () => {},
      },
    }),
    /durable_capture_status: request aborted/,
  )
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
      json: async () => ({ buildVersion: '105', connected: true, authenticated: false, tables: [], errorMessage: 'MT page is open, but no table payload was detected yet.' }),
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
          buildVersion: '105',
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

test('Final rank-ledger work hydrates only identities present in the durable Final batch while preserving all ten live tables', async () => {
  let formalInput = null
  let mounted = null
  const parsed = {
    sessionId: 'bounded-final-rank',
    status: { connected: true, authenticated: true, tableCount: 2 },
    tables: [
      { tableId: 'BAG01', shoe: 7, round: 12 },
      { tableId: 'BAG02', shoe: 9, round: 30 },
    ],
    rounds: [{
      tableId: 'BAG01', shoe: 7, round: 12, winner: 'banker',
      sourceAction: '/api/v1/gametype/*/game/*/room/*/table/*/summary',
      rawResult: [1, 9, 2, 10, -1, -1, -1, -1, 1, 9],
    }],
  }
  const result = await applyCloudCapturePayload({
    parsed,
    writer: { configured: false },
    state: {
      setStatus() {},
      setTables(tables) { mounted = structuredClone(tables) },
      async upsertRoundEvent() { return { ok: true } },
    },
    v100Formal: {
      enabled: true,
      async processSnapshot(input) {
        formalInput = structuredClone(input)
        return { tables: input.tables.map((table) => ({ ...table, v102RankLedger: { status: 'contiguous' } })) }
      },
    },
  })

  assert.deepEqual(formalInput.tables.map((table) => table.tableId), ['BAG01'])
  assert.equal(formalInput.rounds.length, 1)
  assert.deepEqual(mounted.map((table) => table.tableId), ['BAG01', 'BAG02'])
  assert.equal(mounted[0].v102RankLedger.status, 'contiguous')
  assert.equal(mounted[1].v102RankLedger, undefined)
  assert.deepEqual(result.tables.map((table) => table.tableId), ['BAG01', 'BAG02'])
})

test('durable outbox replay settles Finals without publishing its stale status or table snapshot', async () => {
  const state = createFakeState()
  state.setStatus({ connected: true, authenticated: true, lastMessageAt: '2026-08-23T13:30:00.000Z' })
  state.setTables([{ tableId: 'BAG01', shoe: 'LIVE', round: 9 }])

  await applyCloudCapturePayload({
    parsed: {
      sessionId: 'worker',
      status: { connected: false, authenticated: false, lastMessageAt: '2026-08-23T12:30:00.000Z' },
      tables: [],
      rounds: [{ tableId: 'BAG01', shoe: 'OLD', round: 1, winner: 'banker' }],
    },
    state,
    writer: { configured: false },
    v100Formal: { enabled: false },
    persistAncillary: false,
    publishSnapshot: false,
  })

  const snapshot = state.snapshot()
  assert.equal(snapshot.status.connected, true)
  assert.equal(snapshot.status.authenticated, true)
  assert.equal(snapshot.status.tableCount, 1)
  assert.equal(snapshot.tables[0].shoe, 'LIVE')
  assert.equal(snapshot.lastRound, undefined, 'historical replay must not mutate the live round mount')
  assert.equal(snapshot.settledRound.shoe, 'OLD', 'the historical Final must still reach settlement')
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
    settleRoundEvent(round = {}) {
      data.settledRound = round
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
