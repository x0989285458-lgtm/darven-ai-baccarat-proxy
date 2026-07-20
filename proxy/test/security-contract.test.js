import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createApp } from '../src/server.js'
import { buildLivePrediction } from '../src/supabase-writer.js'

const NOW = Date.parse('2026-07-13T12:00:00.000Z')
const INGEST_HEADERS = { 'x-worker-key': 'ingest-test-key', 'x-forwarded-proto': 'https' }

function ingestEnvelope(overrides = {}) {
  return {
    protocolVersion: 'v102',
    timestamp: NOW,
    sequence: 7,
    roundKeys: ['BAG01:88:21'],
    snapshot: {
      buildVersion: '102',
      sessionId: 'worker-session-opaque',
      connected: true,
      authenticated: true,
      tables: [{ tableId: 'BAG01', shoe: '88', round: 21 }],
      rounds: [{
        tableId: 'BAG01', shoe: '88', round: 21, winner: 'banker',
        rawResult: [1, 9, 2, 10, -1, -1, -1, -1, 1, 9],
        sourceAction: '/api/v1/gametype/*/game/*/room/*/table/*/summary',
      }],
    },
    ...overrides,
  }
}

function durableWriter(overrides = {}) {
  return {
    configured: true,
    writeCloudCaptureStatus: async () => {},
    writeCloudTableSnapshot: async () => {},
    writeCloudRoundEvent: async () => {},
    ...overrides,
  }
}

async function ingest(app, envelope = ingestEnvelope()) {
  return app.inject({
    method: 'POST',
    url: '/api/cloud-ingest/snapshot',
    headers: INGEST_HEADERS,
    body: JSON.stringify(envelope),
  })
}

test('ingest rejects a missing or mismatched protocol version and marks status degraded', async () => {
  const app = createApp({ autoConnect: false, ingestKey: 'ingest-test-key', now: () => NOW, supabaseClient: durableWriter() })

  const missing = await ingest(app, ingestEnvelope({ protocolVersion: undefined }))
  assert.equal(missing.statusCode, 409)
  assert.equal(JSON.parse(missing.body).error, 'version_mismatch')

  const mismatch = await ingest(app, ingestEnvelope({ protocolVersion: 'v097' }))
  assert.equal(mismatch.statusCode, 409)
  assert.equal(JSON.parse(mismatch.body).error, 'version_mismatch')

  const status = JSON.parse((await app.inject({ url: '/api/status', headers: { 'x-forwarded-proto': 'https' } })).body)
  assert.equal(status.buildVersion, 'v102')
  assert.equal(status.health, 'degraded')
  assert.equal(status.reason, 'version_mismatch')
  assert.equal(status.expectedProtocolVersion, 'v102')
  assert.equal(status.receivedProtocolVersion, 'v097')
})

test('ingest fails closed when the worker snapshot build version is not 098', async () => {
  const app = createApp({ autoConnect: false, ingestKey: 'ingest-test-key', now: () => NOW, supabaseClient: durableWriter() })

  const response = await ingest(app, ingestEnvelope({
    snapshot: { ...ingestEnvelope().snapshot, buildVersion: '097' },
  }))

  assert.equal(response.statusCode, 409)
  assert.equal(JSON.parse(response.body).error, 'version_mismatch')
  assert.equal(app.state.snapshot().status.health, 'degraded')
})

test('ingest validates exact roundKeys before writes and ACKs only the validated keys', async () => {
  let writes = 0
  const app = createApp({
    autoConnect: false,
    ingestKey: 'ingest-test-key',
    now: () => NOW,
    supabaseClient: durableWriter({
      writeCloudTableSnapshot: async () => { writes += 1 },
      writeCloudRoundEvent: async () => { writes += 1 },
    }),
  })

  for (const roundKeys of [undefined, [], ['BAG01:88:22'], ['BAG01:88:21', 'BAG01:88:21']]) {
    const response = await ingest(app, ingestEnvelope({ roundKeys }))
    assert.equal(response.statusCode, 400)
    assert.match(JSON.parse(response.body).error, /roundKeys/)
  }
  assert.equal(writes, 0)

  const accepted = JSON.parse((await ingest(app)).body)
  assert.deepEqual(accepted.acceptedRoundKeys, ['BAG01:88:21'])
})

test('ingest validates completed-round schema before any durable write', async () => {
  let writes = 0
  const writer = durableWriter({
    writeCloudCaptureStatus: async () => { writes += 1 },
    writeCloudTableSnapshot: async () => { writes += 1 },
    writeCloudRoundEvent: async () => { writes += 1 },
  })
  const app = createApp({ autoConnect: false, ingestKey: 'ingest-test-key', now: () => NOW, supabaseClient: writer })
  const invalidRound = { ...ingestEnvelope().snapshot.rounds[0], shoe: '' }

  const response = await ingest(app, ingestEnvelope({ snapshot: { ...ingestEnvelope().snapshot, rounds: [invalidRound] } }))

  assert.equal(response.statusCode, 400)
  assert.match(JSON.parse(response.body).error, /round.*shoe/i)
  assert.equal(writes, 0)
})

test('ingest ACK is emitted only after all durable writes and contains accepted round keys', async () => {
  const order = []
  const writer = durableWriter({
    writeCloudCaptureStatus: async () => { order.push('status') },
    writeCloudTableSnapshot: async () => { order.push('snapshot') },
    writeCloudRoundEvent: async () => { order.push('round') },
  })
  const app = createApp({ autoConnect: false, ingestKey: 'ingest-test-key', now: () => NOW, supabaseClient: writer })

  const response = await ingest(app)
  order.push('ack')
  const payload = JSON.parse(response.body)

  assert.equal(response.statusCode, 200)
  assert.deepEqual(order, ['status', 'snapshot', 'round', 'ack'])
  assert.deepEqual(payload, {
    ok: true,
    accepted: true,
    duplicate: false,
    sessionId: 'worker-session-opaque',
    sequence: 7,
    acceptedRoundKeys: ['BAG01:88:21'],
  })
  const status = app.state.snapshot().status
  assert.equal(status.expectedProtocolVersion, 'v102')
  assert.equal(status.receivedProtocolVersion, 'v102')
})

test('ingest never acknowledges or advances sequence when a durable write fails', async () => {
  let attempts = 0
  const app = createApp({
    autoConnect: false,
    ingestKey: 'ingest-test-key',
    now: () => NOW,
    supabaseClient: durableWriter({
      writeCloudRoundEvent: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('durable write failed')
      },
    }),
  })

  const failed = await ingest(app)
  assert.equal(failed.statusCode, 503)
  assert.equal(JSON.parse(failed.body).accepted, false)

  const retried = await ingest(app)
  assert.equal(retried.statusCode, 200)
  assert.equal(JSON.parse(retried.body).duplicate, false)
  assert.equal(attempts, 2)
})

test('ingest fails closed when no durable snapshot writer is configured', async () => {
  const app = createApp({ autoConnect: false, ingestKey: 'ingest-test-key', now: () => NOW, supabaseClient: { configured: false } })

  const response = await ingest(app)

  assert.equal(response.statusCode, 503)
  assert.equal(JSON.parse(response.body).accepted, false)
})

test('member revocation invalidates an existing opaque session on the next request', async () => {
  let active = true
  const licenseAdminClient = {
    validateMemberLogin: async ({ memberAccount }) => active
      ? { ok: true, memberAccount, license: { id: 'license-row-1', status: 'active', expires_on: '2099-01-01' } }
      : { ok: false, memberAccount, license: { id: 'license-row-1', status: 'suspended', expires_on: '2099-01-01' } },
    validateMemberSession: async () => ({ ok: active }),
  }
  const app = createApp({ autoConnect: false, memberAuthRequired: true, licenseAdminClient })
  const login = await app.inject({
    method: 'POST',
    url: '/api/online-license/member-login',
    body: JSON.stringify({ memberAccount: 'Member001', verificationPassword: 'VERIFY001' }),
  })
  const token = JSON.parse(login.body).memberSessionToken

  assert.equal((await app.inject({ url: '/api/tables', headers: { authorization: token } })).statusCode, 401)
  assert.equal((await app.inject({ url: '/api/tables', headers: { authorization: `Bearer ${token}` } })).statusCode, 200)
  active = false
  assert.equal((await app.inject({ url: '/api/tables', headers: { authorization: `Bearer ${token}` } })).statusCode, 401)
})

test('control endpoints accept either dedicated header or Authorization bearer', async () => {
  const options = {
    autoConnect: false,
    controlToken: 'control-test-key',
    cloudBrowserUrl: 'https://worker.example/snapshot',
  }
  const headerApp = createApp(options)
  const bearerApp = createApp(options)

  const header = await headerApp.inject({ method: 'POST', url: '/api/cloud-capture/stop', headers: { 'x-control-token': 'control-test-key' } })
  const bearer = await bearerApp.inject({ method: 'POST', url: '/api/cloud-capture/stop', headers: { authorization: 'Bearer control-test-key' } })

  assert.equal(header.statusCode, 200)
  assert.equal(bearer.statusCode, 200)
})

test('production rejects non-HTTPS requests without redirecting or leaking a Location', async () => {
  const app = createApp({ autoConnect: false, production: true, memberAuthRequired: false })

  const response = await app.inject({ url: '/health', headers: { 'x-forwarded-proto': 'http' } })

  assert.equal(response.statusCode, 426)
  assert.equal(response.headers.location, undefined)
  assert.match(JSON.parse(response.body).error, /https/i)
})

test('pending prediction is not created unless all three target identity columns are complete', async () => {
  const app = createApp({ autoConnect: false })
  app.state.setTables([{ tableId: 'BAG01', shoe: null, round: 20, bankerCount: 10, playerCount: 9 }])

  const tables = JSON.parse((await app.inject({ url: '/api/tables' })).body)

  assert.equal(tables[0].prediction, null)
})

test('pending prediction is deeply frozen before settlement and has exact six-side types', async () => {
  let settledPending = null
  const app = createApp({
    autoConnect: false,
    supabaseClient: {
      configured: true,
      ensureInitialStrategy: async () => {},
      persistRound: async (_round, _table, pending) => { settledPending = pending },
    },
  })
  app.state.setTables([{ tableId: 'BAG01', shoe: 88, round: 20, bankerCount: 10, playerCount: 9 }])
  app.state.upsertRoundEvent({
    tableId: 'BAG01', shoe: 88, round: 21, winner: 'banker',
    rawResult: [1, 9, 2, 10, -1, -1, -1, -1, 1, 9],
    sourceAction: '/api/v1/gametype/*/game/*/room/*/table/*/summary',
  })
  await new Promise((resolve) => setImmediate(resolve))

  const sideKeys = ['bankerDragon', 'bankerPair', 'playerDragon', 'playerPair', 'superSix', 'tie'].sort()
  assert.ok(settledPending)
  assert.equal(Object.isFrozen(settledPending), true)
  assert.equal(Object.isFrozen(settledPending.sidePredictions), true)
  assert.equal(Object.isFrozen(settledPending.sideActions), true)
  assert.deepEqual(Object.keys(settledPending.sidePredictions).sort(), sideKeys)
  assert.deepEqual(Object.keys(settledPending.sideActions).sort(), sideKeys)
  assert.equal(Object.values(settledPending.sidePredictions).every(Number.isFinite), true)
  assert.equal(Object.values(settledPending.sideActions).every((value) => typeof value === 'boolean'), true)
})

test('internal state and public endpoints share build version 098.23', async () => {
  const app = createApp({ autoConnect: false })
  const health = JSON.parse((await app.inject({ url: '/health' })).body)
  const status = JSON.parse((await app.inject({ url: '/api/status' })).body)
  const snapshot = JSON.parse((await app.inject({ url: '/api/snapshot' })).body)

  assert.equal(health.buildVersion, 'v102')
  assert.equal(status.buildVersion, 'v102')
  assert.equal(snapshot.status.version, 'v102')
})

test('every public table and durable prediction carries buildVersion 098.23 and targets the exact screen round', async () => {
  const exact = { ...buildLivePrediction({ tableId: 'BAG01', shoe: 88, round: 19 }), predictionId: 'pid-round-20', issuedAt: new Date(NOW).toISOString() }
  const app = createApp({ autoConnect: false, supabaseClient: {
    configured: true,
    issuePrediction: async (candidate) => ({ ...candidate, predictionId: `pid-${candidate.targetRound}`, issuedAt: new Date(NOW).toISOString() }),
    readIssuedPrediction: async () => exact,
  }, now: () => NOW })
  app.state.setTables([{ tableId: 'BAG01', shoe: 88, round: 20, sourceUpdatedAt: new Date().toISOString() }])

  const tables = JSON.parse((await app.inject({ url: '/api/tables' })).body)

  assert.equal(tables[0].buildVersion, 'v102')
  assert.equal(tables[0].prediction.buildVersion, 'v102')
  assert.equal(tables[0].prediction.targetRound, 20)

  const snapshot = JSON.parse((await app.inject({ url: '/api/snapshot' })).body)
  assert.equal(snapshot.tables[0].buildVersion, 'v102')
  assert.equal(snapshot.tables[0].prediction.buildVersion, 'v102')
})

test('production and cloud ingest without a key returns 503 and reports degraded health', async () => {
  for (const options of [{ production: true }, { deployMode: 'cloud' }]) {
    const app = createApp({ autoConnect: false, ingestKey: '', memberAuthRequired: false, ...options })
    const headers = options.production ? { 'x-forwarded-proto': 'https' } : {}

    const ingestResponse = await app.inject({ method: 'POST', url: '/api/cloud-ingest/snapshot', headers, body: JSON.stringify(ingestEnvelope()) })
    const healthResponse = await app.inject({ url: '/health', headers })
    const health = JSON.parse(healthResponse.body)

    assert.equal(ingestResponse.statusCode, 503)
    assert.equal(healthResponse.statusCode, 503)
    assert.equal(health.health, 'degraded')
    assert.equal(health.reason, 'ingest_key_missing')
  }
})

test('active strategy runtimeStatus is exposed by health and status and degrades health fail-closed', async () => {
  const runtimeStatus = { ready: false, degraded: true, reason: 'active strategy verification failed', activeStrategyVersion: null }
  const app = createApp({ autoConnect: false, requireVerifiedStrategy: true, supabaseClient: { configured: true, getRuntimeStatus: () => runtimeStatus } })

  const healthResponse = await app.inject({ url: '/health' })
  const statusResponse = await app.inject({ url: '/api/status' })
  const health = JSON.parse(healthResponse.body)
  const status = JSON.parse(statusResponse.body)

  assert.equal(healthResponse.statusCode, 503)
  assert.deepEqual(health.runtimeStatus, runtimeStatus)
  assert.deepEqual(status.runtimeStatus, runtimeStatus)
  assert.equal(status.health, 'degraded')
})

test('security upgrade pins PM2 7.0.3', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'))

  assert.equal(pkg.devDependencies.pm2, '7.0.3')
  assert.equal(lock.packages['node_modules/pm2'].version, '7.0.3')
})
