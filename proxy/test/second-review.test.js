import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'
import { createCloudCaptureClient } from '../src/cloud-capture.js'
import { buildLivePrediction, buildPredictionResultRow } from '../src/supabase-writer.js'

const table = {
  tableId: 'BAG01', shoe: 88, round: 20,
  bankerCount: 10, playerCount: 9, tieCount: 1,
  bankerPairCount: 2, playerPairCount: 1,
  beadPlateRaw: '0102', bigRoadRaw: '0102', bigEyeRaw: '12', smallRoadRaw: '21', cockroachRaw: '11',
  nextBankerRaw: '1', nextPlayerRaw: '2',
  sourceUpdatedAt: new Date().toISOString(),
}

async function readSseEvent(reader, timeoutMs = 4500) {
  const decoder = new TextDecoder()
  let text = ''
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timed out waiting for SSE event')), timeoutMs))
  while (!text.includes('\n\n')) {
    const result = await Promise.race([reader.read(), timeout])
    if (result.done) return { event: 'closed', data: null }
    text += decoder.decode(result.value, { stream: true }).replace(/\r\n/g, '\n')
  }
  const block = text.slice(0, text.indexOf('\n\n'))
  const event = block.split('\n').find((line) => line.startsWith('event:'))?.slice(6).trim() ?? 'message'
  const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n')
  return { event, data: data ? JSON.parse(data) : null }
}

test('non-ready or degraded active strategy makes health 503 and suppresses prediction creation and return', async () => {
  for (const runtimeStatus of [
    { ready: false, degraded: false, reason: 'active_strategy_not_verified', activeStrategyVersion: null },
    { ready: true, degraded: true, reason: 'active_strategy_invalid', activeStrategyVersion: null },
  ]) {
    const app = createApp({
      autoConnect: false,
      requireVerifiedStrategy: true,
      supabaseClient: { configured: true, getRuntimeStatus: () => runtimeStatus },
    })
    app.state.setTables([table])

    const health = await app.inject({ url: '/health' })
    const tables = JSON.parse((await app.inject({ url: '/api/tables' })).body)

    assert.equal(health.statusCode, 503)
    assert.equal(tables[0].prediction, null)
  }
})

test('production fails closed when the strategy service is unconfigured', async () => {
  const app = createApp({
    autoConnect: false,
    production: true,
    memberAuthRequired: false,
    ingestKey: 'configured',
    supabaseClient: { configured: false, getRuntimeStatus: () => ({ ready: false, degraded: false }) },
  })
  app.state.setTables([table])

  const health = await app.inject({ url: '/health', headers: { 'x-forwarded-proto': 'https' } })
  const tables = JSON.parse((await app.inject({ url: '/api/tables', headers: { 'x-forwarded-proto': 'https' } })).body)

  assert.equal(health.statusCode, 503)
  assert.equal(tables[0].prediction, null)
})

test('startup verifies the active strategy before accepting live tables', async () => {
  let ready = false
  let ensureCalls = 0
  let futureCandidate = null
  const supabaseClient = {
    configured: true,
    getRuntimeStatus: () => ({ ready, degraded: false, reason: ready ? null : 'active_strategy_not_verified' }),
    ensureInitialStrategy: async () => {
      ensureCalls += 1
      ready = true
    },
    getV105FormalHistory: async () => [],
    issuePrediction: async (candidate) => {
      futureCandidate = candidate
      return { ...candidate, predictionId: 'verified-future', issuedAt: '2026-07-17T01:00:00.000Z' }
    },
    readIssuedPrediction: async ({ round }) => ({ ...futureCandidate, targetRound: round, predictionId: 'verified-screen', issuedAt: '2026-07-17T01:00:00.000Z' }),
  }
  const app = createApp({ autoConnect: false, port: 0, requireVerifiedStrategy: true, supabaseClient })

  await app.start()
  try {
    app.state.setTables([table])
    const tables = JSON.parse((await app.inject({ url: '/api/tables' })).body)

    assert.equal(ensureCalls, 1)
    assert.ok(tables[0].prediction)
  } finally {
    await app.stop()
  }
})

test('startup keeps the service reachable but prediction-degraded when strategy verification is temporarily unavailable', async () => {
  const supabaseClient = {
    configured: true,
    ensureInitialStrategy: async () => { throw new Error('temporary strategy verification timeout') },
    getRuntimeStatus: () => ({ ready: false, degraded: true, reason: 'active_strategy_not_verified' }),
  }
  const app = createApp({ autoConnect: false, port: 0, requireVerifiedStrategy: true, supabaseClient })
  await app.start()
  try {
    const health = await app.inject({ url: '/health' })
    assert.equal(health.statusCode, 503)
    assert.equal(JSON.parse(health.body).runtimeStatus.ready, false)
  } finally {
    await app.stop()
  }
})

test('explicit live empty tables never resurrect a cached cloud prediction', async () => {
  const stale = { ...table, tableId: 'BAG99', sourceUpdatedAt: new Date().toISOString() }
  const app = createApp({
    autoConnect: false,
    requireVerifiedStrategy: false,
    supabaseClient: {
      configured: true,
      getLatestCloudTableSnapshot: async () => ({ snapshot_at: new Date().toISOString(), tables: [stale] }),
    },
  })
  app.state.setTables([table])
  app.state.setTables([])

  const tables = JSON.parse((await app.inject({ url: '/api/tables' })).body)

  assert.deepEqual(tables, [])
})

test('expired prediction tombstones are bounded across long-running tables', async () => {
  let clock = 1_000_000
  const app = createApp({ autoConnect: false, now: () => clock, predictionTtlMs: 1000, maxExpiredPredictionKeys: 1 })
  const tableA = { ...table, tableId: 'BAG01' }
  const tableB = { ...table, tableId: 'BAG02' }

  app.state.setTables([tableA])
  clock += 1001
  assert.equal(JSON.parse((await app.inject({ url: '/api/tables' })).body)[0].prediction, null)
  app.state.setTables([tableB])
  clock += 1001
  assert.equal(JSON.parse((await app.inject({ url: '/api/tables' })).body)[0].prediction, null)
  app.state.setTables([tableA])

  assert.ok(JSON.parse((await app.inject({ url: '/api/tables' })).body)[0].prediction)
})

test('SSE sends table data when prediction TTL expires and when tables become empty', async () => {
  let clock = 1_000_000
  const app = createApp({ autoConnect: false, port: 0, now: () => clock, predictionTtlMs: 1000, supabaseClient: { configured: false } })
  app.state.setTables([table])
  await app.start()
  const controller = new AbortController()
  const reader = (await fetch(`http://127.0.0.1:${app.server.address().port}/api/tables/stream`, { signal: controller.signal })).body.getReader()

  try {
    const fresh = await readSseEvent(reader)
    assert.equal(fresh.event, 'tables')
    assert.ok(fresh.data.tables[0].prediction)

    clock += 1001
    const expired = await readSseEvent(reader)
    assert.equal(expired.event, 'tables')
    assert.equal(expired.data.tables[0].prediction, null)

    app.state.setTables([])
    const empty = await readSseEvent(reader)
    assert.equal(empty.event, 'tables')
    assert.deepEqual(empty.data.tables, [])
  } finally {
    controller.abort()
    await app.stop()
  }
})

test('SSE revalidates member session before every push and emits 401 then closes after revocation', async () => {
  let authorized = true
  const app = createApp({
    autoConnect: false,
    port: 0,
    memberAuthRequired: true,
    licenseAdminClient: {
      validateMemberLogin: async ({ memberAccount } = {}) => ({
        ok: true,
        memberAccount: memberAccount ?? 'Member001',
        license: { id: 'license-1', status: 'active' },
      }),
      validateMemberSession: async () => ({ ok: authorized }),
    },
  })
  const login = JSON.parse((await app.inject({
    method: 'POST',
    url: '/api/online-license/member-login',
    body: JSON.stringify({ memberAccount: 'Member001', verificationPassword: 'VERIFY001' }),
  })).body)
  app.state.setTables([table])
  await app.start()
  const controller = new AbortController()
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/tables/stream`, {
    headers: { authorization: `Bearer ${login.memberSessionToken}` },
    signal: controller.signal,
  })
  const reader = response.body.getReader()

  try {
    assert.equal((await readSseEvent(reader)).event, 'tables')
    authorized = false
    const revoked = await readSseEvent(reader)
    assert.equal(revoked.event, 'unauthorized')
    assert.equal(revoked.data.status, 401)
    assert.equal((await readSseEvent(reader)).event, 'closed')
  } finally {
    controller.abort()
    await app.stop()
  }
})

test('production HTTPS fail-closed also covers the SSE branch', async () => {
  const app = createApp({
    autoConnect: false,
    port: 0,
    production: true,
    memberAuthRequired: false,
    ingestKey: 'configured',
    v104FormalRuntime: { start: async () => {} },
  })
  const controller = new AbortController()
  await app.start()
  try {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/tables/stream`, { signal: controller.signal })
    assert.equal(response.status, 426)
  } finally {
    controller.abort()
    await app.stop()
  }
})

test('production cloud mode requires an HTTPS CLOUD_BROWSER_URL', () => {
  assert.throws(() => createApp({
    autoConnect: false,
    production: true,
    deployMode: 'cloud',
    cloudBrowserUrl: 'http://worker.example/snapshot',
    ingestKey: 'configured',
  }), /CLOUD_BROWSER_URL.*HTTPS/i)
})

test('proxy pull rejects a worker snapshot whose buildVersion is not 098 before apply', async () => {
  let appliedTables = 0
  const statuses = []
  const client = createCloudCaptureClient({
    url: 'https://worker.example/snapshot',
    requestRetries: 1,
    state: {
      setStatus(value) { statuses.push(value) },
      setTables() { appliedTables += 1 },
      upsertRoundEvent() {},
      recordError() {},
    },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ buildVersion: '097', tables: [table], rounds: [] }),
    }),
  })

  const result = await client.tick()

  assert.equal(result, null)
  assert.equal(appliedTables, 0)
  assert.equal(statuses.at(-1).health, 'degraded')
  assert.match(statuses.at(-1).reason, /version_mismatch/)
})

test('settlement ignores external sideActualResults and preserves the approved Dragon Bonus rule', () => {
  const pending = buildLivePrediction(table)
  const maliciousRound = {
    tableId: 'BAG01', shoe: 88, round: 21, winner: 'banker',
    playerPoint: 2, bankerPoint: 7,
    rawResult: [1, 2, 3, 4, -1, -1, -1, -1, 2, 7],
    sideActualResults: {
      tie: true, superSix: true, bankerPair: true, playerPair: true, bankerDragon: true, playerDragon: true,
    },
  }

  const actual = buildPredictionResultRow(maliciousRound, table, pending).prediction_features.side_actual_results

  assert.deepEqual(actual, {
    tie: false, superSix: false, bankerPair: false, playerPair: false, bankerDragon: true, playerDragon: false,
  })
})
