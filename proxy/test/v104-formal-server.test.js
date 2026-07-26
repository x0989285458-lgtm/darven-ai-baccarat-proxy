import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'
import { buildV105FormalPrediction } from '../src/v105-formal-strategy.js'

const table = {
  tableId: 'BAG01', shoe: '88', round: 19,
  sourceUpdatedAt: '2026-07-21T01:00:00.000Z',
  bankerCount: 9, playerCount: 8, tieCount: 1,
  beadPlateRaw: '02#01#02#01#02', bigRoadRaw: 'B#P#B#P#B',
}

test('server routes formal issuance through v104 runtime and records only durable acknowledgements', async () => {
  const built = []
  const acknowledgements = []
  const issued = []
  const formalRuntime = {
    async start() {},
    async buildPrediction(input) {
      built.push(structuredClone(input))
      return buildV105FormalPrediction(input, [], {})
    },
    recordIssuance(prediction) { acknowledgements.push(structuredClone(prediction)) },
    recordSettlement() {},
    snapshot() { return { strategyVersion: 'v105', status: 'ready' } },
  }
  const writer = {
    configured: true,
    async issuePrediction(candidate) {
      issued.push(structuredClone(candidate))
      return { ...candidate, predictionId: 'formal-v105-20', issuedAt: '2026-07-21T01:00:01.000Z' }
    },
    async readIssuedPrediction() { return null },
  }
  const app = createApp({
    autoConnect: false,
    requireVerifiedStrategy: false,
    memberAuthRequired: false,
    supabaseClient: writer,
    v104FormalRuntime: formalRuntime,
  })

  app.state.setTables([table])
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(built.length, 1)
  assert.equal(issued.length, 1)
  assert.equal(issued[0].strategyVersion, 'v105')
  assert.equal(issued[0].targetRound, 20)
  assert.equal(acknowledgements.length, 1)
  assert.equal(acknowledgements[0].predictionId, 'formal-v105-20')
})

test('server hydrates the v104 formal runtime before opening the listener', async () => {
  let started = 0
  const app = createApp({
    autoConnect: false,
    port: 0,
    requireVerifiedStrategy: false,
    memberAuthRequired: false,
    supabaseClient: { configured: false },
    v104FormalRuntime: {
      async start() { started += 1 },
      async buildPrediction(input) { return buildV105FormalPrediction(input, [], {}) },
      recordIssuance() {},
      recordSettlement() {},
      snapshot() { return { strategyVersion: 'v105', status: started ? 'ready' : 'initializing' } },
    },
  })
  await app.start()
  try {
    assert.equal(started, 1)
  } finally {
    await app.stop()
  }
})

test('server passes the dedicated configured v105 hydration timeout to the formal history reader', async () => {
  let observedTimeout
  const writer = {
    configured: true,
    async getV105FormalHistory(options) { observedTimeout = options.requestTimeoutMs; return [] },
    async getRecentPredictionRows() { return [] },
  }
  const app = createApp({
    autoConnect: false,
    port: 0,
    requireVerifiedStrategy: false,
    memberAuthRequired: false,
    supabaseClient: writer,
    v104FormalRequestTimeoutMs: 30000,
    v105FormalHydrationTimeoutMs: 60000,
  })
  await app.start()
  try {
    assert.equal(observedTimeout, 60000)
  } finally {
    await app.stop()
  }
})

test('failed recent performance startup hydration retries on a later table update before formal issuance', async () => {
  let nowMs = Date.parse('2026-07-21T01:00:00.000Z')
  let recentCalls = 0
  let issuanceCalls = 0
  const writer = {
    configured: true,
    getRuntimeStatus() { return { ready: true, degraded: false, activeStrategyVersion: 'v105' } },
    async ensureInitialStrategy() { return { ok: true, activeStrategyVersion: 'v105' } },
    async getRecentPredictionRows() {
      recentCalls += 1
      if (recentCalls === 1) throw new Error('temporary recent history read failure')
      return []
    },
    async reconcilePredictionLifecycle() {},
    async issuePrediction(candidate) {
      issuanceCalls += 1
      return { ...candidate, predictionId: `retry-${issuanceCalls}`, issuedAt: new Date(nowMs).toISOString() }
    },
  }
  const formalRuntime = {
    async start() {},
    async buildPrediction(input) { return buildV105FormalPrediction(input, [], {}) },
    recordIssuance() {}, recordSettlement() {},
    snapshot() { return { strategyVersion: 'v105', status: 'ready' } },
  }
  const app = createApp({
    autoConnect: false, port: 0, production: true, requireVerifiedStrategy: true,
    memberAuthRequired: false, supabaseClient: writer, v104FormalRuntime: formalRuntime,
    recentPerformanceRetryMs: 1000, now: () => nowMs,
  })
  await app.start()
  try {
    assert.equal(recentCalls, 1)
    app.state.setTables([table])
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(issuanceCalls, 0)
    nowMs += 1001
    app.state.setTables([{ ...table, tableId: 'BAG02', sourceUpdatedAt: new Date(nowMs).toISOString() }])
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(recentCalls, 2)
    assert.equal(issuanceCalls, 1)
  } finally {
    await app.stop()
  }
})

test('cloud ingest withholds ACK until v104 Final settlement is durable and returns 503 on failure', async () => {
  let releaseSettlement
  let settlementStarted
  const started = new Promise((resolve) => { settlementStarted = resolve })
  const gate = new Promise((resolve) => { releaseSettlement = resolve })
  const formalRuntime = {
    async start() {},
    async buildPrediction(input) { return buildV105FormalPrediction(input, [], {}) },
    recordIssuance() {}, recordSettlement() {},
    snapshot() { return { strategyVersion: 'v105', status: 'ready' } },
  }
  const writer = {
    configured: true,
    async issuePrediction(candidate) { return { ...candidate, predictionId: 'formal-v105-20', issuedAt: '2026-07-21T01:00:01.000Z' } },
    async readIssuedPrediction() { return null },
    async persistRound() {
      settlementStarted()
      await gate
      throw new Error('settlement write failed')
    },
    async writeCloudCaptureStatus() {},
    async writeCloudTableSnapshot() {},
    async writeCloudRoundEvent() {},
  }
  const app = createApp({
    autoConnect: false, ingestKey: 'worker-key', now: () => 1_000_000,
    requireVerifiedStrategy: false, memberAuthRequired: false,
    supabaseClient: writer, v104FormalRuntime: formalRuntime,
  })
  app.state.setTables([table])
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  const envelope = { protocolVersion: 'v105', timestamp: 1_000_000, sequence: 8, roundKeys: ['BAG01:88:20'], snapshot: {
    buildVersion: '105', sessionId: 'worker-session', connected: true, authenticated: true,
    tables: [{ ...table, round: 20 }],
    rounds: [{ tableId: 'BAG01', shoe: 88, round: 20, winner: 'banker', rawResult: [1, 9, 2, 10, -1, -1, -1, -1, 1, 9], sourceAction: '/api/v1/gametype/*/game/*/room/*/table/*/summary' }],
  } }
  const responsePromise = app.inject({ method: 'POST', url: '/api/cloud-ingest/snapshot', headers: { 'x-worker-key': 'worker-key', 'x-forwarded-proto': 'https' }, body: JSON.stringify(envelope) })
  await started
  const beforeDurable = await Promise.race([responsePromise.then(() => 'responded'), new Promise((resolve) => setTimeout(() => resolve('waiting'), 20))])
  assert.equal(beforeDurable, 'waiting')
  releaseSettlement()
  const response = await responsePromise
  assert.equal(response.statusCode, 503)
  assert.equal(JSON.parse(response.body).accepted, false)
})

test('server links a durable Final settlement back to the original v105 prediction identity', async () => {
  const settlements = []
  const formalRuntime = {
    async start() {},
    async buildPrediction(input) { return buildV105FormalPrediction(input, [], {}) },
    recordIssuance() {},
    recordSettlement(row) { settlements.push(structuredClone(row)) },
    snapshot() { return { strategyVersion: 'v105', status: 'ready' } },
  }
  const writer = {
    configured: true,
    async issuePrediction(candidate) { return { ...candidate, predictionId: 'formal-v105-20', issuedAt: '2026-07-21T01:00:01.000Z' } },
    async readIssuedPrediction() { return null },
    async persistRound() { return { prediction: { strategy_version: 'v105', predicted_result: 'banker', settlement_final: true } } },
    async writeCloudCaptureStatus() {}, async writeCloudTableSnapshot() {}, async writeCloudRoundEvent() {},
  }
  const app = createApp({ autoConnect: false, ingestKey: 'worker-key', now: () => 1_000_000,
    requireVerifiedStrategy: false, memberAuthRequired: false, supabaseClient: writer, v104FormalRuntime: formalRuntime })
  app.state.setTables([table])
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  const envelope = { protocolVersion: 'v105', timestamp: 1_000_000, sequence: 9, roundKeys: ['BAG01:88:20'], snapshot: {
    buildVersion: '105', sessionId: 'worker-session', connected: true, authenticated: true,
    tables: [{ ...table, round: 20 }],
    rounds: [{ tableId: 'BAG01', shoe: 88, round: 20, winner: 'banker', rawResult: [1, 9, 2, 10, -1, -1, -1, -1, 1, 9], sourceAction: '/api/v1/gametype/*/game/*/room/*/table/*/summary' }],
  } }
  const response = await app.inject({ method: 'POST', url: '/api/cloud-ingest/snapshot', headers: { 'x-worker-key': 'worker-key', 'x-forwarded-proto': 'https' }, body: JSON.stringify(envelope) })
  assert.equal(response.statusCode, 200)
  assert.equal(settlements.length, 1)
  assert.equal(settlements[0].predictionId, 'formal-v105-20')
})
