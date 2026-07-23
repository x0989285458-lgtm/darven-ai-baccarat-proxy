import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { buildLivePrediction, buildPredictionResultRow, createSupabaseIngestionClient, ALL_MT_EQUAL_MAIN_WEIGHTS, SIDE_PREDICTION_THRESHOLDS as FORMAL_SIDE_THRESHOLDS } from '../src/supabase-writer.js'
import { createApp, readRequestBody } from '../src/server.js'
import { createLicenseAdminClient } from '../src/license-admin.js'
import { createStableReportSession, FORMAL_MAIN_PREDICTION_WEIGHTS, REPORT_MAIN_WEIGHTS, SIDE_PREDICTION_THRESHOLDS } from '../src/stable-report.js'

const table = {
  tableId: 'BAG01', shoe: 88, round: 20,
  bankerCount: 18, playerCount: 2, tieCount: 1,
  bankerPairCount: 3, playerPairCount: 0,
  beadPlateRaw: '020202020202#020202020202#020202020202',
  bigRoadRaw: '0902,0802,0702#0602,0502,0402',
  bigEyeRaw: '1,1,1', smallRoadRaw: '1,1', cockroachRaw: '1,1',
  nextBankerRaw: { big: '111' }, nextPlayerRaw: { big: '222' },
}

const revealedRound = {
  tableId: 'BAG01', shoe: 88, round: 21, winner: 'banker',
  rawResult: [1, 9, 2, 10, -1, -1, -1, -1, 1, 9],
  sourceAction: '/api/v1/gametype/*/game/*/room/*/table/*/summary',
}

test('settlement preserves the complete matching pre-result prediction snapshot', () => {
  const pending = buildLivePrediction(table)
  const frozen = structuredClone(pending)
  const changedAfterReveal = { ...table, round: 21, bankerCount: 2, playerCount: 19, tieCount: 4, beadPlateRaw: '010101010101' }
  const row = buildPredictionResultRow(revealedRound, changedAfterReveal, pending)

  assert.equal(pending.targetShoe, '88')
  assert.equal(pending.targetRound, 21)
  assert.deepEqual(pending, frozen)
  assert.equal(row.predicted_result, frozen.predictedResult)
  assert.equal(row.confidence, frozen.confidence)
  assert.equal(row.strategy_version, frozen.strategyVersion)
  assert.deepEqual(row.prediction_features.side_predictions, frozen.sidePredictions)
  assert.deepEqual(row.prediction_features.side_actions, frozen.sideActions)
  assert.equal(row.prediction_features.prediction_timing, 'pre_result_context')
})

test('runtime settles each round once with the immutable matching pending prediction', async () => {
  const persisted = []
  const app = createApp({
    autoConnect: false,
    supabaseClient: {
      configured: true,
      ensureInitialStrategy: async () => {},
      persistRound: async (round, settledTable, pending) => persisted.push({ round, settledTable, pending }),
    },
  })
  app.state.setTables([table])
  await app.inject({ url: '/api/tables' })

  app.state.setTables([{ ...table, round: 21, bankerCount: 2, playerCount: 19 }])
  app.state.upsertRoundEvent(revealedRound)
  app.state.upsertRoundEvent(revealedRound)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(persisted.length, 1)
  assert.equal(persisted[0].pending.predictionFeatures.mt_context.bankerCount, table.bankerCount)
  assert.equal(persisted[0].pending.targetRound, revealedRound.round)
})

test('display TTL does not prevent settlement of an already issued pending prediction', async () => {
  let clock = 1_000_000
  const persisted = []
  const app = createApp({
    autoConnect: false,
    now: () => clock,
    predictionTtlMs: 30_000,
    supabaseClient: {
      configured: true,
      ensureInitialStrategy: async () => {},
      persistRound: async (...args) => persisted.push(args),
    },
  })
  app.state.setTables([table])
  clock += 30_001
  app.state.upsertRoundEvent(revealedRound)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(persisted.length, 1)
  assert.equal(persisted[0][2].targetRound, revealedRound.round)
})

test('runtime retains a matching pending prediction when persistence fails so the event can retry', async () => {
  let attempts = 0
  const app = createApp({
    autoConnect: false,
    supabaseClient: {
      configured: true,
      ensureInitialStrategy: async () => {},
      persistRound: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('temporary write failure')
      },
    },
  })
  app.state.setTables([table])
  app.state.upsertRoundEvent(revealedRound)
  await new Promise((resolve) => setImmediate(resolve))
  app.state.upsertRoundEvent(revealedRound)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(attempts, 2)
})

test('table snapshots save one pending prediction before the next result arrives', async () => {
  const persisted = []
  const app = createApp({
    autoConnect: false,
    supabaseClient: {
      configured: true,
      ensureInitialStrategy: async () => {},
      persistRound: async (round, settledTable, pending) => persisted.push({ round, settledTable, pending }),
    },
  })

  app.state.setTables([table])
  app.state.upsertRoundEvent(revealedRound)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(persisted.length, 1)
  assert.equal(persisted[0].pending.targetTableId, 'BAG01')
  assert.equal(persisted[0].pending.targetShoe, '88')
  assert.equal(persisted[0].pending.targetRound, 21)
})

test('persistence never creates a prediction result without a matching pending snapshot', async () => {
  const requests = []
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co',
    serviceKey: 'test-only-key',
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), body: JSON.parse(options.body) })
      return { ok: true, status: 201, text: async () => '' }
    },
    retryAttempts: 1,
  })
  const mismatched = { ...buildLivePrediction(table), targetRound: 22 }

  await assert.rejects(client.persistRound(revealedRound, table, mismatched), /prediction target mismatch/)
  assert.deepEqual(requests, [])
})

test('row builder never labels a cross-table prediction as pre-result context', () => {
  const wrongTablePending = buildLivePrediction({ ...table, tableId: 'BAG99' })
  assert.equal(buildPredictionResultRow(revealedRound, table, wrongTablePending), null)
})

test('stable report settles only the matching prediction saved before reveal', () => {
  const session = createStableReportSession({ targetTableCount: 1 })
  const pending = buildLivePrediction(table)
  session.recordSnapshot({ status: { connected: true, authenticated: true, tableCount: 1 }, tables: [table] }, 'before')
  session.recordSnapshot({
    status: { connected: true, authenticated: true, tableCount: 1 },
    tables: [{ ...table, round: 21, bankerCount: 2, playerCount: 19, lastRound: revealedRound }],
  }, 'after')

  const report = session.getReport()
  assert.equal(report.total.rounds, 1)
  assert.equal(report.tables[0].lastPrediction, pending.predictedResult === 'banker' ? '莊' : '閒')
  assert.equal(report.tables[0].lastConfidence, pending.confidence)
  assert.deepEqual(report.tables[0].lastSidePredictions, pending.sidePredictions)
  assert.deepEqual(report.tables[0].lastSideActions, pending.sideActions)
})

test('stable report shares the approved main weights and side thresholds', () => {
  assert.deepEqual(FORMAL_MAIN_PREDICTION_WEIGHTS, ALL_MT_EQUAL_MAIN_WEIGHTS)
  assert.deepEqual(REPORT_MAIN_WEIGHTS, { shoeRoad: 0.30, askRoad: 0.18, recentTrend: 0.17, bankerPlayerStats: 0.13, auxiliaryRoads: 0.12, beadRoad: 0.10 })
  assert.deepEqual(SIDE_PREDICTION_THRESHOLDS, FORMAL_SIDE_THRESHOLDS)
})

test('analytics trusts saved side actions, excludes ties from main rate, and gates dragon by main direction', async () => {
  const queries = []
  const pool = { async query(sql) { queries.push(String(sql)); return { rows: [] } } }
  await createLicenseAdminClient({ pool }).getDailyAnalytics()

  const sql = queries.join('\n')
  assert.match(sql, /prediction_features->'side_actions'/)
  assert.match(sql, /prediction_features\s*->>\s*'settlement_final'\s*=\s*'true'/i)
  assert.match(sql, /predicted_result in \('banker','player'\)/i)
  assert.match(sql, /predicted_result='banker'.*side_actions'->>'bankerDragon'/is)
  assert.match(sql, /predicted_result='player'.*side_actions'->>'playerDragon'/is)
})

test('api tables removes actionable prediction after the Render receive-time TTL', async () => {
  let clock = 1_000_000
  const app = createApp({ autoConnect: false, now: () => clock, predictionTtlMs: 30_000 })
  app.state.setTables([table])

  const fresh = JSON.parse((await app.inject({ url: '/api/tables' })).body)
  assert.equal(['banker', 'player'].includes(fresh[0].prediction.predictedResult), true)

  clock += 30_001
  const stale = JSON.parse((await app.inject({ url: '/api/tables' })).body)
  assert.equal(stale[0].prediction, null)
})

test('streaming request reader aborts as soon as the body exceeds 1MB', async () => {
  const req = new EventEmitter()
  let paused = false
  req.pause = () => { paused = true }
  const reading = readRequestBody(req)
  req.emit('data', Buffer.alloc(1024 * 1024))
  req.emit('data', Buffer.from('x'))

  await assert.rejects(reading, (error) => error.statusCode === 413)
  assert.equal(paused, true)
})

test('member login issues a short-lived opaque bearer session required by table data API', async () => {
  let clock = 2_000_000
  const app = createApp({
    autoConnect: false,
    now: () => clock,
    memberAuthRequired: true,
    memberSessionTtlMs: 60_000,
    licenseAdminClient: {
      validateMemberLogin: async () => ({ ok: true, memberAccount: 'User001', license: { code: 'CODE001' } }),
      validateMemberSession: async () => ({ ok: true }),
    },
  })
  app.state.setTables([table])

  const denied = await app.inject({ url: '/api/tables' })
  assert.equal(denied.statusCode, 401)
  const login = await app.inject({ method: 'POST', url: '/api/online-license/member-login', body: JSON.stringify({ memberAccount: 'User001', verificationPassword: 'CODE001' }) })
  const session = JSON.parse(login.body)
  assert.equal(typeof session.memberSessionToken, 'string')
  assert.match(session.sessionExpiresAt, /T/)
  assert.equal(Buffer.from(session.memberSessionToken, 'base64url').toString('utf8').includes('CODE001'), false)

  const allowed = await app.inject({ url: '/api/tables', headers: { authorization: `Bearer ${session.memberSessionToken}` } })
  assert.equal(allowed.statusCode, 200)
  clock += 60_001
  const expired = await app.inject({ url: '/api/tables', headers: { authorization: `Bearer ${session.memberSessionToken}` } })
  assert.equal(expired.statusCode, 401)
})

test('SSE accepts bearer authorization and rejects every query token', async () => {
  const app = createApp({
    autoConnect: false,
    port: 0,
    memberAuthRequired: true,
    licenseAdminClient: {
      validateMemberLogin: async () => ({ ok: true, memberAccount: 'User001', license: { code: 'CODE001' } }),
      validateMemberSession: async () => ({ ok: true }),
    },
  })
  const login = await app.inject({ method: 'POST', url: '/api/online-license/member-login', body: JSON.stringify({ memberAccount: 'User001', verificationPassword: 'CODE001' }) })
  const session = JSON.parse(login.body)
  await app.start()
  const address = app.server.address()
  const controller = new AbortController()
  try {
    const first = await fetch(`http://127.0.0.1:${address.port}/api/tables/stream`, { headers: { authorization: `Bearer ${session.memberSessionToken}` }, signal: controller.signal })
    assert.equal(first.status, 200)
    controller.abort()
    const queryToken = await fetch(`http://127.0.0.1:${address.port}/api/tables/stream?streamTicket=forbidden-query-token`)
    assert.equal(queryToken.status, 400)
  } finally {
    controller.abort()
    await app.stop()
  }

})

test('health and status expose one shared build version', async () => {
  const app = createApp({ autoConnect: false })
  const health = JSON.parse((await app.inject({ url: '/health' })).body)
  const status = JSON.parse((await app.inject({ url: '/api/status' })).body)
  assert.equal(health.version, 'v105')
  assert.equal(status.version, health.version)
})
