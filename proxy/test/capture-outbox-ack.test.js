import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createApp, resolveCaptureOutboxLeaseDeadlineMs } from '../src/server.js'

const PRODUCTION_TABLE_IDS = ['BAG01', 'BAG02', 'BAG03', 'BAG03A', 'BAG05', 'BAG06', 'BAG07', 'BAG08', 'BAG09', 'BAG10']

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const waitFor = async (predicate, timeoutMs = 1000) => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for test condition')
    await delay(5)
  }
}

function retiredServerShadowTest(name, _legacyContract) {
  test(`${name} [retired by Main33]`, () => {
    const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8')
    assert.equal(server.includes('shadow-process-client'), false)
    assert.equal(server.includes('shadowProcessClient'), false)
  })
}

function envelope() {
  return {
    protocolVersion: 'v105',
    timestamp: 1_000_000,
    sequence: 7,
    roundKeys: ['BAG01:88:21'],
    snapshot: {
      buildVersion: '105',
      sessionId: 'outbox-worker',
      connected: true,
      authenticated: true,
      tables: [{ tableId: 'BAG01', shoe: 88, round: 21 }],
      rounds: [{
        tableId: 'BAG01', shoe: 88, round: 21, winner: 'banker',
        rawResult: [1, 9, 2, 10, -1, -1, -1, -1, 1, 9],
        sourceAction: '/api/v1/gametype/*/game/*/room/*/table/*/summary',
      }],
    },
  }
}

function claimedRow(sequence, overrides = {}) {
  return {
    session_id: 'outbox-worker', sequence, claim_token: `lease-${sequence}`, attempts: 1,
    payload: { work: { ...envelope().snapshot, rounds: [] } },
    ...overrides,
  }
}

test('durable raw capture and outbox ACK do not wait for formal settlement', async () => {
  let releaseSettlement
  const settlementGate = new Promise((resolve) => { releaseSettlement = resolve })
  const order = []
  let claimed = false
  const app = createApp({
    autoConnect: false,
    outboxCoalesceMs: 0,
    ingestKey: 'worker-key',
    now: () => 1_000_000,
    supabaseClient: {
      configured: true,
      async persistCaptureEnvelope() { order.push('raw-outbox'); return { acceptedRoundKeys: ['BAG01:88:21'] } },
      async claimCaptureOutbox() {
        if (claimed) return []
        claimed = true
        return [claimedRow(7, { payload: { work: envelope().snapshot } })]
      },
      async completeCaptureOutbox(identity) {
        assert.deepEqual(identity, { sessionId: 'outbox-worker', sequence: 7, claimToken: 'lease-7', attempt: 1 })
        order.push('outbox-complete')
      },
      async writeCloudCaptureStatus() { order.push('legacy-status') },
      async writeCloudTableSnapshot() { order.push('legacy-snapshot') },
      async writeCloudRoundEvent() { order.push('legacy-round') },
    },
    v100FormalRuntime: {
      enabled: true,
      async processSnapshot({ tables }) {
        order.push('formal-start')
        await settlementGate
        order.push('formal-finish')
        return { tables }
      },
    },
  })

  const request = app.inject({
    method: 'POST',
    url: '/api/cloud-ingest/snapshot',
    headers: { 'x-worker-key': 'worker-key' },
    body: JSON.stringify(envelope()),
  })
  try {
    const response = await Promise.race([
      request,
      delay(50).then(() => ({ statusCode: 599, body: '{"error":"ACK waited for settlement"}' })),
    ])
    assert.equal(response.statusCode, 200)
    assert.deepEqual(JSON.parse(response.body).acceptedRoundKeys, ['BAG01:88:21'])
    assert.equal(order[0], 'raw-outbox')
    assert.equal(order.includes('formal-start'), false, 'HTTP ACK must be created before Formal Outbox work starts')
    await delay(0)
    assert.equal(order.includes('formal-start'), true)
    assert.equal(order.includes('formal-finish'), false)
  } finally {
    releaseSettlement()
    await request
  }
})

for (const disabledValue of [false, 'false']) {
  test(`consumer-disabled ingest preserves durable raw ACK without claiming formal outbox (${JSON.stringify(disabledValue)})`, async () => {
    let claimCalls = 0
    let lifecycleCalls = 0
    let shadowObservationCalls = 0
    const app = createApp({
      autoConnect: false,
      captureOutboxConsumerEnabled: disabledValue,
      captureOutboxPollMs: 10,
      outboxCoalesceMs: 0,
      ingestKey: 'worker-key',
      now: () => 1_000_000,
      v105ShadowV9Runtime: {
        enabled: true,
        async observeTable() { shadowObservationCalls += 1 },
      },
      supabaseClient: {
        configured: true,
        async persistCaptureEnvelope(value) { return { acceptedRoundKeys: value.roundKeys } },
        async claimCaptureOutbox() { claimCalls += 1; return [] },
        async reconcilePredictionLifecycle() { lifecycleCalls += 1 },
        async writeCloudCaptureStatus() {},
        async writeCloudTableSnapshot() {},
        async writeCloudRoundEvent() {},
      },
    })

    const response = await app.inject({
      method: 'POST',
      url: '/api/cloud-ingest/snapshot',
      headers: { 'x-worker-key': 'worker-key' },
      body: JSON.stringify(envelope()),
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(JSON.parse(response.body).acceptedRoundKeys, ['BAG01:88:21'])
    const statusResponse = await app.inject({ method: 'GET', url: '/api/status' })
    const statusBody = JSON.parse(statusResponse.body)
    assert.equal(statusResponse.statusCode, 200)
    assert.equal(statusBody.connected, true)
    assert.equal(statusBody.tableCount, 1)
    await delay(20)
    assert.equal(claimCalls, 0)
    assert.equal(lifecycleCalls, 0, 'external-consumer HTTP parent must not reconcile or issue predictions from snapshot tables')
    assert.equal(shadowObservationCalls, 0, 'external-consumer HTTP parent must not fan snapshot tables into shadow observers')
  })
}

test('consumer-disabled HTTP parent does not start formal or shadow runtimes', async () => {
  const starts = []
  let cloudFetchCalls = 0
  let issuedReads = 0
  let persistedRounds = 0
  let shadowSettlements = 0
  const runtime = (name) => ({
    enabled: true,
    async start() { starts.push(name) },
    async stop() {},
    async settleRound() { shadowSettlements += 1 },
  })
  const app = createApp({
    autoConnect: true,
    host: '127.0.0.1',
    port: 0,
    captureSource: 'cloud_browser',
    cloudBrowserUrl: 'https://worker.invalid/snapshot',
    fetchImpl: async () => {
      cloudFetchCalls += 1
      throw new Error('disabled parent must not fetch cloud capture')
    },
    captureOutboxConsumerEnabled: false,
    v104FormalRuntime: runtime('formal'),
    v105ShadowV9Runtime: runtime('v9'),
    v105ShadowV10Runtime: runtime('v10'),
    supabaseClient: {
      configured: true,
      async readIssuedPrediction() { issuedReads += 1; return null },
      async persistRound() { persistedRounds += 1; return null },
    },
  })
  await app.start()
  try {
    await delay(0)
    app.state.setTables([{ tableId: 'BAG01', shoe: 1, round: 1 }])
    app.state.upsertRoundEvent({
      tableId: 'BAG01', shoe: 1, round: 1, sourceAction: 'summary', winner: 'banker',
      rawResult: [1, 2, 3, 4, -1, -1, -1, -1, 4, 6],
    })
    await delay(10)
    assert.deepEqual(starts, [])
    assert.equal(cloudFetchCalls, 0)
    assert.equal(issuedReads, 0)
    assert.equal(persistedRounds, 0)
    assert.equal(shadowSettlements, 0)
  } finally {
    await app.stop()
  }
})

test('consumer-disabled verified HTTP parent read-only verifies active v105 without starting runtime work', async () => {
  const calls = {
    verifyReadOnly: 0,
    ensure: 0,
    claim: 0,
    formalStart: 0,
    shadowStart: 0,
    predictionRead: 0,
    predictionWrite: 0,
  }
  let runtimeStatus = {
    ready: false,
    degraded: false,
    reason: 'active_strategy_not_verified',
    activeStrategyVersion: null,
  }
  const app = createApp({
    autoConnect: false,
    host: '127.0.0.1',
    port: 0,
    requireVerifiedStrategy: true,
    captureOutboxConsumerEnabled: false,
    supabaseClient: {
      configured: true,
      getRuntimeStatus: () => ({ ...runtimeStatus }),
      async verifyActiveStrategyReadOnly() {
        calls.verifyReadOnly += 1
        runtimeStatus = { ready: true, degraded: false, reason: null, activeStrategyVersion: 'v105' }
        return { ok: true, activeStrategyVersion: 'v105' }
      },
      async ensureInitialStrategy() { calls.ensure += 1 },
      async claimCaptureOutbox() { calls.claim += 1; return [] },
      async readIssuedPrediction() { calls.predictionRead += 1; return null },
      async issuePrediction() { calls.predictionWrite += 1; return null },
      async persistRound() { calls.predictionWrite += 1; return null },
    },
    v104FormalRuntime: {
      enabled: true,
      async start() { calls.formalStart += 1 },
      async stop() {},
    },
    v105ShadowV9Runtime: {
      enabled: true,
      async start() { calls.shadowStart += 1 },
      async stop() {},
    },
    v105ShadowV10Runtime: {
      enabled: true,
      async start() { calls.shadowStart += 1 },
      async stop() {},
    },
  })

  await app.start()
  try {
    const health = await app.inject({ method: 'GET', url: '/health' })
    assert.equal(calls.verifyReadOnly, 1)
    assert.equal(health.statusCode, 200)
    assert.deepEqual(JSON.parse(health.body).runtimeStatus, {
      ready: true,
      degraded: false,
      reason: null,
      activeStrategyVersion: 'v105',
    })
    assert.deepEqual(calls, {
      verifyReadOnly: 1,
      ensure: 0,
      claim: 0,
      formalStart: 0,
      shadowStart: 0,
      predictionRead: 0,
      predictionWrite: 0,
    })
  } finally {
    await app.stop()
  }
})

test('external consumer publishes a finalized screen and issues the next prediction without frontend polling', async () => {
  let claimed = false
  const order = []
  const issued = []
  const snapshot = {
    ...envelope().snapshot,
    tables: [{ tableId: 'BAG01', shoe: 88, round: 21, sourceUpdatedAt: '2026-08-25T16:00:00.000Z', beadPlateRaw: '0102', bigRoadRaw: 'BP' }],
  }
  const app = createApp({
    autoConnect: false,
    captureOutboxConsumerEnabled: true,
    outboxCoalesceMs: 0,
    now: () => 1_000_000,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        if (claimed) return []
        claimed = true
        return [claimedRow(8, { payload: { work: snapshot } })]
      },
      async completeCaptureOutbox() { order.push('complete') },
      async failCaptureOutbox() { assert.fail('valid finalized work must not fail') },
      async getCaptureOutboxHealth() { return { pending: 0, processing: 0, error: 0, dead_letter: 0, next_wakeup_at: null } },
      async readIssuedPrediction() { return null },
      async reconcilePredictionLifecycle() { order.push('reconcile') },
      async issuePrediction(candidate) {
        issued.push(candidate)
        order.push('issue')
        return { ...candidate, predictionId: 'pid-BAG01-88-22', issuedAt: '2026-08-25T16:00:01.000Z' }
      },
    },
    v100FormalRuntime: {
      enabled: true,
      async processSnapshot({ tables }) { return { enabled: true, predictions: [], tables } },
    },
  })

  await app.drainCaptureOutbox()
  await app.waitForServiceWorkIdle()

  assert.equal(issued.length, 1)
  assert.equal(issued[0].targetTableId, 'BAG01')
  assert.equal(issued[0].targetShoe, '88')
  assert.equal(issued[0].targetRound, 22)
  assert.deepEqual(order, ['reconcile', 'issue', 'complete'])
})

test('formal settlement state publication does not enqueue duplicate background prediction work', async () => {
  let claimed = false
  const order = []
  const reconciliations = []
  const issued = []
  const snapshot = {
    ...envelope().snapshot,
    tables: [{ tableId: 'BAG01', shoe: 88, round: 21, sourceUpdatedAt: '2026-08-25T16:00:00.000Z', beadPlateRaw: '0102', bigRoadRaw: 'BP' }],
  }
  let app
  app = createApp({
    autoConnect: false,
    captureOutboxConsumerEnabled: true,
    outboxCoalesceMs: 0,
    now: () => 1_000_000,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        if (claimed) return []
        claimed = true
        return [claimedRow(8, { payload: { work: snapshot } })]
      },
      async completeCaptureOutbox() { order.push('complete') },
      async failCaptureOutbox() { assert.fail('valid finalized work must not fail') },
      async getCaptureOutboxHealth() { return { pending: 0, processing: 0, error: 0, dead_letter: 0, next_wakeup_at: null } },
      async readIssuedPrediction(identity) {
        if (identity.round !== 21) return null
        return {
          predictionId: 'pid-BAG01-88-21',
          targetTableId: 'BAG01',
          targetShoe: '88',
          targetRound: 21,
          strategyVersion: 'v105',
        }
      },
      async persistRound() {
        order.push('settle')
        app.state.setTables(snapshot.tables)
        return {
          prediction: {
            predictionId: 'pid-BAG01-88-21',
            targetTableId: 'BAG01',
            targetShoe: '88',
            targetRound: 21,
            strategyVersion: 'v105',
            prediction_features: { settlement_final: true },
          },
        }
      },
      async reconcilePredictionLifecycle(identity) {
        reconciliations.push(identity)
        order.push('reconcile')
      },
      async issuePrediction(candidate) {
        issued.push(candidate)
        order.push('issue')
        return { ...candidate, predictionId: 'pid-BAG01-88-22', issuedAt: '2026-08-25T16:00:01.000Z' }
      },
    },
    v100FormalRuntime: {
      enabled: true,
      async processSnapshot({ tables }) { return { enabled: true, predictions: [], tables } },
    },
  })

  await app.drainCaptureOutbox()
  await app.waitForServiceWorkIdle()

  assert.equal(reconciliations.length, 1, 'only the explicit finalized identity may reconcile prediction work')
  assert.equal(issued.length, 1)
  assert.deepEqual(order, ['settle', 'reconcile', 'issue', 'complete'])
})

test('concurrent external table update is not dropped while formal settlement suppresses its own publication', async () => {
  let claimed = false
  let releaseSettlement
  let markSettlementStarted
  const settlementStarted = new Promise((resolve) => { markSettlementStarted = resolve })
  const settlementGate = new Promise((resolve) => { releaseSettlement = resolve })
  const reconciledTables = []
  const snapshot = {
    ...envelope().snapshot,
    tables: [{ tableId: 'BAG01', shoe: 88, round: 21, sourceUpdatedAt: '2026-08-25T16:00:00.000Z', beadPlateRaw: '0102', bigRoadRaw: 'BP' }],
  }
  const app = createApp({
    autoConnect: false,
    captureOutboxConsumerEnabled: true,
    outboxCoalesceMs: 0,
    now: () => 1_000_000,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        if (claimed) return []
        claimed = true
        return [claimedRow(8, { payload: { work: snapshot } })]
      },
      async completeCaptureOutbox() {},
      async failCaptureOutbox() { assert.fail('valid concurrent work must not fail') },
      async getCaptureOutboxHealth() { return { pending: 0, processing: 0, error: 0, dead_letter: 0, next_wakeup_at: null } },
      async readIssuedPrediction(identity) {
        if (identity.round !== 21) return null
        return {
          predictionId: 'pid-BAG01-88-21',
          targetTableId: 'BAG01',
          targetShoe: '88',
          targetRound: 21,
          strategyVersion: 'v105',
        }
      },
      async persistRound() {
        markSettlementStarted()
        await settlementGate
        return {
          prediction: {
            predictionId: 'pid-BAG01-88-21',
            targetTableId: 'BAG01',
            targetShoe: '88',
            targetRound: 21,
            strategyVersion: 'v105',
            prediction_features: { settlement_final: true },
          },
        }
      },
      async reconcilePredictionLifecycle(identity) { reconciledTables.push(identity.tableId) },
      async issuePrediction(candidate) {
        return { ...candidate, predictionId: `pid-${candidate.targetTableId}-${candidate.targetRound}`, issuedAt: '2026-08-25T16:00:01.000Z' }
      },
    },
    v100FormalRuntime: {
      enabled: true,
      async processSnapshot({ tables }) { return { enabled: true, predictions: [], tables } },
    },
  })

  const drain = app.drainCaptureOutbox()
  await settlementStarted
  app.state.setTables([{ tableId: 'BAG02', shoe: 99, round: 7, sourceUpdatedAt: '2026-08-25T16:00:00.500Z' }])
  releaseSettlement()
  const result = await drain
  await app.waitForServiceWorkIdle()

  assert.deepEqual(result, { processed: 1, failed: 0 })
  assert.deepEqual(reconciledTables, ['BAG02', 'BAG01'])
})

test('formal completion does not wait for unrelated background service work to become idle', async () => {
  let claimed = false
  let completed = 0
  let releaseBackground
  let markBackgroundStarted
  let markFormalIssued
  const backgroundStarted = new Promise((resolve) => { markBackgroundStarted = resolve })
  const backgroundGate = new Promise((resolve) => { releaseBackground = resolve })
  const formalIssued = new Promise((resolve) => { markFormalIssued = resolve })
  const snapshot = {
    ...envelope().snapshot,
    tables: [{ tableId: 'BAG01', shoe: 88, round: 21, sourceUpdatedAt: '2026-08-25T16:00:00.000Z', beadPlateRaw: '0102', bigRoadRaw: 'BP' }],
  }
  const app = createApp({
    autoConnect: false,
    captureOutboxConsumerEnabled: true,
    outboxCoalesceMs: 0,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        if (claimed) return []
        claimed = true
        return [claimedRow(8, { payload: { work: snapshot } })]
      },
      async completeCaptureOutbox() { completed += 1 },
      async failCaptureOutbox() { assert.fail('unrelated background work must not fail the exact lease') },
      async getCaptureOutboxHealth() { return { pending: 0, processing: 0, error: 0, dead_letter: 0, next_wakeup_at: null } },
      async readIssuedPrediction(identity) {
        if (identity.tableId !== 'BAG01' || identity.round !== 21) return null
        return {
          predictionId: 'pid-BAG01-88-21',
          targetTableId: 'BAG01',
          targetShoe: '88',
          targetRound: 21,
          strategyVersion: 'v105',
        }
      },
      async persistRound() {
        return {
          prediction: {
            predictionId: 'pid-BAG01-88-21',
            targetTableId: 'BAG01',
            targetShoe: '88',
            targetRound: 21,
            strategyVersion: 'v105',
            prediction_features: { settlement_final: true },
          },
        }
      },
      async reconcilePredictionLifecycle(identity) {
        if (identity.tableId === 'BAG02') {
          markBackgroundStarted()
          await backgroundGate
        }
      },
      async issuePrediction(candidate) {
        if (candidate.targetTableId === 'BAG01') markFormalIssued()
        return { ...candidate, predictionId: `pid-${candidate.targetTableId}-${candidate.targetRound}`, issuedAt: '2026-08-25T16:00:01.000Z' }
      },
    },
    v100FormalRuntime: {
      enabled: true,
      async processSnapshot({ tables }) { return { enabled: true, predictions: [], tables } },
    },
  })

  app.state.setTables([{ tableId: 'BAG02', shoe: 99, round: 7, sourceUpdatedAt: '2026-08-25T16:00:00.500Z' }])
  await backgroundStarted
  const drain = app.drainCaptureOutbox()
  let completedBeforeBackgroundRelease
  try {
    await formalIssued
    await new Promise((resolve) => setImmediate(resolve))
    completedBeforeBackgroundRelease = completed
  } finally {
    releaseBackground()
    await drain
    await app.waitForServiceWorkIdle()
  }

  assert.equal(completedBeforeBackgroundRelease, 1, 'exact lease must complete after its own prediction work settles')
})

test('formal apply failure restores background prediction scheduling', async () => {
  let claimed = false
  let failed = 0
  let reconciled = 0
  const app = createApp({
    autoConnect: false,
    captureOutboxConsumerEnabled: true,
    outboxCoalesceMs: 0,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        if (claimed) return []
        claimed = true
        return [claimedRow(8, { payload: { work: envelope().snapshot } })]
      },
      async completeCaptureOutbox() { assert.fail('failed formal apply must not complete') },
      async failCaptureOutbox() { failed += 1; return { failed: true, isolated: true } },
      async readIssuedPrediction() { return null },
      async reconcilePredictionLifecycle() { reconciled += 1 },
    },
    v100FormalRuntime: {
      enabled: true,
      async processSnapshot() { throw new Error('formal apply failure') },
    },
  })

  const result = await app.drainCaptureOutbox()
  app.state.setTables([{ tableId: 'BAG01', shoe: 88, round: 22 }])
  await app.waitForServiceWorkIdle()

  assert.deepEqual(result, { processed: 0, failed: 1 })
  assert.equal(failed, 1)
  assert.equal(reconciled, 1, 'normal table updates must schedule prediction work after formal failure')
})

test('external consumer completes an idempotent replay when exact next issuance exists after its acknowledgement was lost', async () => {
  let claimed = false
  let completed = 0
  let failed = 0
  let issueCalls = 0
  let durablePrediction = null
  const snapshot = {
    ...envelope().snapshot,
    tables: [{ tableId: 'BAG01', shoe: 88, round: 21, sourceUpdatedAt: '2026-08-25T16:00:00.000Z', beadPlateRaw: '0102', bigRoadRaw: 'BP' }],
  }
  const app = createApp({
    autoConnect: false,
    captureOutboxConsumerEnabled: true,
    outboxCoalesceMs: 0,
    now: () => 1_000_000,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        if (claimed) return []
        claimed = true
        return [claimedRow(8, { payload: { work: snapshot } })]
      },
      async completeCaptureOutbox() { completed += 1 },
      async failCaptureOutbox() { failed += 1 },
      async getCaptureOutboxHealth() { return { pending: 0, processing: 0, error: 0, dead_letter: 0, next_wakeup_at: null } },
      async reconcilePredictionLifecycle() {},
      async issuePrediction(candidate) {
        issueCalls += 1
        durablePrediction = { ...candidate, predictionId: 'pid-BAG01-88-22', issuedAt: '2026-08-25T16:00:01.000Z' }
        throw new Error('durable issuance acknowledgement was lost')
      },
      async readIssuedPrediction(identity) {
        if (identity.round === 21) return null
        assert.deepEqual(identity, { tableId: 'BAG01', shoe: 88, round: 22, strategyVersion: 'v105' })
        return durablePrediction
      },
    },
    v100FormalRuntime: {
      enabled: true,
      async processSnapshot({ tables }) { return { enabled: true, predictions: [], tables } },
    },
  })

  await app.drainCaptureOutbox()
  await app.waitForServiceWorkIdle()

  assert.equal(issueCalls, 1)
  assert.equal(completed, 1)
  assert.equal(failed, 0)
})

test('external consumer retains the exact outbox lease when next prediction issuance fails', async () => {
  let claimed = false
  let completed = 0
  let failed = 0
  const snapshot = {
    ...envelope().snapshot,
    tables: [{ tableId: 'BAG01', shoe: 88, round: 21, sourceUpdatedAt: '2026-08-25T16:00:00.000Z', beadPlateRaw: '0102', bigRoadRaw: 'BP' }],
  }
  const app = createApp({
    autoConnect: false,
    captureOutboxConsumerEnabled: true,
    outboxCoalesceMs: 0,
    now: () => 1_000_000,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        if (claimed) return []
        claimed = true
        return [claimedRow(8, { payload: { work: snapshot } })]
      },
      async completeCaptureOutbox() { completed += 1 },
      async failCaptureOutbox() { failed += 1 },
      async getCaptureOutboxHealth() { return { pending: 0, processing: 0, error: 0, dead_letter: 0, next_wakeup_at: null } },
      async readIssuedPrediction() { return null },
      async reconcilePredictionLifecycle() {},
      async issuePrediction() { throw new Error('temporary issuance failure') },
    },
    v100FormalRuntime: {
      enabled: true,
      async processSnapshot({ tables }) { return { enabled: true, predictions: [], tables } },
    },
  })

  await app.drainCaptureOutbox()
  await app.waitForServiceWorkIdle()

  assert.equal(completed, 0)
  assert.equal(failed, 1)
  assert.match(app.state.snapshot().status.persistenceError, /prediction issuance failed before outbox acknowledgement/)
})

test('external consumer acknowledges durable stale Final work without requiring an obsolete screen prediction', async () => {
  let claimed = false
  let completed = 0
  let failed = 0
  const issuedTargets = []
  const staleSnapshot = {
    ...envelope().snapshot,
    tables: [{ tableId: 'BAG01', shoe: 88, round: 21, sourceUpdatedAt: '2026-08-25T16:00:00.000Z', beadPlateRaw: '0102', bigRoadRaw: 'BP' }],
  }
  const app = createApp({
    autoConnect: false,
    captureOutboxConsumerEnabled: true,
    outboxCoalesceMs: 0,
    now: () => 1_000_000,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        if (claimed) return []
        claimed = true
        return [claimedRow(8, { payload: { work: staleSnapshot } })]
      },
      async completeCaptureOutbox() { completed += 1 },
      async failCaptureOutbox() { failed += 1 },
      async getCaptureOutboxHealth() { return { pending: 0, processing: 0, error: 0, dead_letter: 0, next_wakeup_at: null } },
      async reconcilePredictionLifecycle() {},
      async readIssuedPrediction() { return null },
      async issuePrediction(candidate) {
        issuedTargets.push(candidate.targetRound)
        if (candidate.targetRound === 26) {
          return { ...candidate, predictionId: 'pid-current-26', issuedAt: '2026-08-25T16:00:01.000Z' }
        }
        return null
      },
    },
    v100FormalRuntime: {
      enabled: true,
      async processSnapshot({ tables }) { return { enabled: true, predictions: [], tables } },
    },
  })

  app.state.setTables([{
    tableId: 'BAG01', shoe: 88, round: 25, sourceUpdatedAt: '2026-08-25T16:00:05.000Z',
    beadPlateRaw: '0102010201', bigRoadRaw: 'BPBPB',
  }, {
    tableId: 'BAG02', shoe: 99, round: 12, sourceUpdatedAt: '2026-08-25T16:00:05.000Z',
    beadPlateRaw: '02010102', bigRoadRaw: 'PBPB',
  }])
  await app.waitForServiceWorkIdle()
  await app.drainCaptureOutbox()
  await app.waitForCaptureOutboxIdle()

  assert.equal(completed, 1)
  assert.equal(failed, 0)
  assert.deepEqual(issuedTargets.sort((left, right) => left - right), [13, 26], 'only current-screen predictions may be issued')
  assert.deepEqual(
    app.state.snapshot().tables.map((table) => [table.tableId, table.round]),
    [['BAG01', 25], ['BAG02', 12]],
    'partial stale work must preserve every unrelated live table',
  )
})

test('external consumer refreshes the fresh durable screen before stale cross-shoe backlog and only issues the current target', async () => {
  let claimed = false
  let completed = 0
  let failed = 0
  const issuedTargets = []
  const nowMs = Date.now()
  const currentSnapshotAt = new Date(nowMs - 1_000).toISOString()
  const staleSnapshot = {
    ...envelope().snapshot,
    tables: [{ tableId: 'BAG01', shoe: 88, round: 21, sourceUpdatedAt: '2026-08-25T16:00:00.000Z', beadPlateRaw: '0102', bigRoadRaw: 'BP' }],
  }
  const currentTable = {
    tableId: 'BAG01', shoe: 89, round: 3, sourceUpdatedAt: currentSnapshotAt,
    beadPlateRaw: '010201', bigRoadRaw: 'BPB',
  }
  const app = createApp({
    autoConnect: false,
    captureOutboxConsumerEnabled: true,
    outboxCoalesceMs: 0,
    now: () => nowMs,
    supabaseClient: {
      configured: true,
      async getLatestCloudTableSnapshot() {
        return {
          session_id: 'worker-current',
          snapshot_at: currentSnapshotAt,
          capture_source: 'cloud_browser',
          tables: [currentTable],
        }
      },
      async claimCaptureOutbox() {
        if (claimed) return []
        claimed = true
        return [claimedRow(8, { payload: { work: staleSnapshot } })]
      },
      async completeCaptureOutbox() { completed += 1 },
      async failCaptureOutbox() { failed += 1 },
      async getCaptureOutboxHealth() { return { pending: 0, processing: 0, error: 0, dead_letter: 0, next_wakeup_at: null } },
      async reconcilePredictionLifecycle() {},
      async readIssuedPrediction() { return null },
      async issuePrediction(candidate) {
        issuedTargets.push([String(candidate.targetShoe), Number(candidate.targetRound)])
        if (String(candidate.targetShoe) === '89' && Number(candidate.targetRound) === 4) {
          return { ...candidate, predictionId: 'pid-current-89-4', issuedAt: '2026-08-25T16:00:09.500Z' }
        }
        return null
      },
    },
    v100FormalRuntime: {
      enabled: true,
      async processSnapshot({ tables }) { return { enabled: true, predictions: [], tables } },
    },
  })

  await app.drainCaptureOutbox()
  await app.waitForCaptureOutboxIdle()

  assert.equal(completed, 1)
  assert.equal(failed, 0)
  assert.deepEqual(issuedTargets, [['89', 4]])
  assert.deepEqual(app.state.snapshot().tables.map((table) => [String(table.shoe), Number(table.round)]), [['89', 3]])
})

test('production consumer refuses to claim backlog without a fresh complete ten-table snapshot', async () => {
  let claims = 0
  const snapshotAt = new Date(Date.now() - 1_000).toISOString()
  const app = createApp({
    autoConnect: false,
    production: true,
    requireVerifiedStrategy: false,
    memberAuthRequired: false,
    captureOutboxConsumerEnabled: true,
    outboxCoalesceMs: 0,
    supabaseClient: {
      configured: true,
      async getLatestCloudTableSnapshot() {
        return {
          session_id: 'worker-incomplete',
          snapshot_at: snapshotAt,
          capture_source: 'cloud_browser',
          tables: [{ tableId: 'BAG01', shoe: 89, round: 3, sourceUpdatedAt: snapshotAt }],
        }
      },
      async claimCaptureOutbox() { claims += 1; return [] },
      async getCaptureOutboxHealth() { return { pending: 1, processing: 0, error: 0, dead_letter: 0, next_wakeup_at: null } },
    },
    v100FormalRuntime: { enabled: true, async processSnapshot({ tables }) { return { tables } } },
  })

  await assert.rejects(app.drainCaptureOutbox(), /fresh complete cloud snapshot/)
  assert.equal(claims, 0)
  await app.stop()
})

test('production consumer rejects a ten-row snapshot that duplicates one table identity', async () => {
  let claims = 0
  const snapshotAt = new Date(Date.now() - 1_000).toISOString()
  const app = createApp({
    autoConnect: false,
    production: true,
    requireVerifiedStrategy: false,
    memberAuthRequired: false,
    captureOutboxConsumerEnabled: true,
    outboxCoalesceMs: 0,
    supabaseClient: {
      configured: true,
      async getLatestCloudTableSnapshot() {
        return {
          session_id: 'worker-duplicate',
          snapshot_at: snapshotAt,
          capture_source: 'cloud_browser',
          tables: Array.from({ length: 10 }, (_, index) => ({
            tableId: 'BAG01', shoe: 89, round: 3 + index, sourceUpdatedAt: snapshotAt,
          })),
        }
      },
      async claimCaptureOutbox() { claims += 1; return [] },
      async getCaptureOutboxHealth() { return { pending: 1, processing: 0, error: 0, dead_letter: 0, next_wakeup_at: null } },
    },
    v100FormalRuntime: { enabled: true, async processSnapshot({ tables }) { return { tables } } },
  })

  await assert.rejects(app.drainCaptureOutbox(), /fresh complete cloud snapshot/)
  assert.equal(claims, 0)
  await app.stop()
})

test('production consumer rejects an expired local fallback snapshot before claiming backlog', async () => {
  let claims = 0
  const previousMaxAge = process.env.CLOUD_SNAPSHOT_MAX_AGE_MS
  process.env.CLOUD_SNAPSHOT_MAX_AGE_MS = '600000'
  const expiredAt = new Date(Date.now() - 5 * 60_000).toISOString()
  const app = createApp({
    autoConnect: false,
    production: true,
    requireVerifiedStrategy: false,
    memberAuthRequired: false,
    captureOutboxConsumerEnabled: true,
    outboxCoalesceMs: 0,
    supabaseClient: {
      configured: true,
      async getLatestCloudTableSnapshot() {
        return {
          session_id: 'local-expired',
          snapshot_at: expiredAt,
          capture_source: 'local_chrome',
          tables: PRODUCTION_TABLE_IDS.map((tableId) => ({ tableId, shoe: 89, round: 3, sourceUpdatedAt: expiredAt })),
        }
      },
      async claimCaptureOutbox() { claims += 1; return [] },
      async getCaptureOutboxHealth() { return { pending: 1, processing: 0, error: 0, dead_letter: 0, next_wakeup_at: null } },
    },
    v100FormalRuntime: { enabled: true, async processSnapshot({ tables }) { return { tables } } },
  })
  if (previousMaxAge == null) delete process.env.CLOUD_SNAPSHOT_MAX_AGE_MS
  else process.env.CLOUD_SNAPSHOT_MAX_AGE_MS = previousMaxAge

  await assert.rejects(app.drainCaptureOutbox(), /fresh complete cloud snapshot/)
  assert.equal(claims, 0)
  await app.stop()
})

test('production consumer rejects a far-future snapshot before claiming backlog', async () => {
  let claims = 0
  const futureAt = new Date(Date.now() + 10 * 60_000).toISOString()
  const app = createApp({
    autoConnect: false,
    production: true,
    requireVerifiedStrategy: false,
    memberAuthRequired: false,
    captureOutboxConsumerEnabled: true,
    outboxCoalesceMs: 0,
    supabaseClient: {
      configured: true,
      async getLatestCloudTableSnapshot() {
        return {
          session_id: 'cloud-future',
          snapshot_at: futureAt,
          capture_source: 'cloud_browser',
          tables: PRODUCTION_TABLE_IDS.map((tableId) => ({ tableId, shoe: 89, round: 3, sourceUpdatedAt: futureAt })),
        }
      },
      async claimCaptureOutbox() { claims += 1; return [] },
      async getCaptureOutboxHealth() { return { pending: 1, processing: 0, error: 0, dead_letter: 0, next_wakeup_at: null } },
    },
    v100FormalRuntime: { enabled: true, async processSnapshot({ tables }) { return { tables } } },
  })

  await assert.rejects(app.drainCaptureOutbox(), /fresh complete cloud snapshot/)
  assert.equal(claims, 0)
  await app.stop()
})

test('production consumer claims only after a fresh exact ten-table snapshot', async () => {
  let claims = 0
  const snapshotAt = new Date(Date.now() - 1_000).toISOString()
  const app = createApp({
    autoConnect: false,
    production: true,
    requireVerifiedStrategy: false,
    memberAuthRequired: false,
    captureOutboxConsumerEnabled: true,
    outboxCoalesceMs: 0,
    supabaseClient: {
      configured: true,
      async getLatestCloudTableSnapshot() {
        return {
          session_id: 'cloud-current',
          snapshot_at: snapshotAt,
          capture_source: 'cloud_browser',
          tables: PRODUCTION_TABLE_IDS.map((tableId) => ({ tableId, shoe: 89, round: 3, sourceUpdatedAt: snapshotAt })),
        }
      },
      async claimCaptureOutbox() { claims += 1; return [] },
      async getCaptureOutboxHealth() { return { pending: 0, processing: 0, error: 0, dead_letter: 0, next_wakeup_at: null } },
    },
    v100FormalRuntime: { enabled: true, async processSnapshot({ tables }) { return { tables } } },
  })

  await app.drainCaptureOutbox()
  assert.equal(claims, 1)
  await app.stop()
})

test('production consumer restores all latest ten-table predictions before claiming historical backlog', async () => {
  let claims = 0
  const issuedTables = new Set()
  const snapshotAt = new Date(Date.now() - 1_000).toISOString()
  const tables = PRODUCTION_TABLE_IDS.map((tableId) => ({
    tableId, shoe: 90, round: 7, sourceUpdatedAt: snapshotAt,
    beadPlateRaw: '01020102010102', bigRoadRaw: 'BPBPBPB',
  }))
  const app = createApp({
    autoConnect: false,
    production: true,
    requireVerifiedStrategy: true,
    memberAuthRequired: false,
    captureOutboxConsumerEnabled: true,
    outboxCoalesceMs: 0,
    supabaseClient: {
      configured: true,
      getRuntimeStatus() { return { ready: true, degraded: false } },
      async getLatestCloudTableSnapshot() {
        return { session_id: 'cloud-current', snapshot_at: snapshotAt, capture_source: 'cloud_browser', tables }
      },
      async reconcilePredictionLifecycle() {},
      async issuePrediction(candidate) {
        issuedTables.add(candidate.targetTableId)
        return { ...candidate, predictionId: `pid-${candidate.targetTableId}`, issuedAt: snapshotAt }
      },
      async claimCaptureOutbox() {
        claims += 1
        assert.deepEqual([...issuedTables].sort(), [...PRODUCTION_TABLE_IDS].sort())
        return []
      },
      async getCaptureOutboxHealth() { return { pending: 0, processing: 0, error: 0, dead_letter: 0, next_wakeup_at: null } },
    },
    v104FormalRuntime: {
      async start() {},
      snapshot() { return { status: 'ready' } },
      latestIssuance() { return null },
      async buildPrediction(table) {
        return {
          targetTableId: table.tableId, targetShoe: String(table.shoe), targetRound: Number(table.round) + 1,
          strategyVersion: 'v105', predictionTiming: 'pre_result_context', predictedResult: 'banker', sameSideStreak: 2,
          sidePredictions: { tie: 10, superSix: 10, bankerPair: 10, playerPair: 10, bankerDragon: 10, playerDragon: 10 },
          sideActions: { tie: false, superSix: false, bankerPair: false, playerPair: false, bankerDragon: false, playerDragon: false },
        }
      },
      recordIssuance() {},
      recordSettlement() {},
    },
    v100FormalRuntime: { enabled: true, async processSnapshot({ tables: current }) { return { tables: current } } },
  })

  await app.waitForServiceWorkIdle()
  await app.drainCaptureOutbox()
  assert.equal(claims, 1)
  assert.equal(issuedTables.size, 10)
  await app.stop()
})

test('latest prediction refresh advances while a claimed backlog batch is still completing', async () => {
  let currentRound = 7
  let claimed = false
  let completeStarted
  let completeFailed
  let releaseComplete
  const completeStartedGate = new Promise((resolve, reject) => { completeStarted = resolve; completeFailed = reject })
  const completeGate = new Promise((resolve) => { releaseComplete = resolve })
  const issuedTargets = []
  const snapshotAt = () => new Date(Date.now() - 500).toISOString()
  const currentTables = () => PRODUCTION_TABLE_IDS.map((tableId) => ({
    tableId, shoe: 94, round: currentRound, sourceUpdatedAt: snapshotAt(),
    beadPlateRaw: '01020102010102', bigRoadRaw: 'BPBPBPB',
  }))
  const app = createApp({
    autoConnect: false,
    production: true,
    requireVerifiedStrategy: true,
    memberAuthRequired: false,
    captureOutboxConsumerEnabled: true,
    outboxCoalesceMs: 0,
    latestPredictionRefreshMs: 10,
    port: 0,
    supabaseClient: {
      configured: true,
      getRuntimeStatus() { return { ready: true, degraded: false } },
      async getLatestCloudTableSnapshot() {
        return { session_id: 'cloud-live-refresh', snapshot_at: snapshotAt(), capture_source: 'cloud_browser', tables: currentTables() }
      },
      async reconcilePredictionLifecycle() {},
      async readIssuedPrediction() { return null },
      async issuePrediction(candidate) {
        issuedTargets.push(`${candidate.targetTableId}:${candidate.targetRound}`)
        return { ...candidate, predictionId: `pid-${candidate.targetTableId}-${candidate.targetRound}`, issuedAt: snapshotAt() }
      },
      async claimCaptureOutbox({ limit }) {
        assert.equal(limit, 30)
        if (claimed) return []
        claimed = true
        return Array.from({ length: 30 }, (_, index) => {
          const tableId = PRODUCTION_TABLE_IDS[index % PRODUCTION_TABLE_IDS.length]
          const finalRound = 5 + Math.floor(index / PRODUCTION_TABLE_IDS.length)
          return claimedRow(68 + index, {
            payload: {
              work: {
                ...envelope().snapshot,
                tables: [{ ...currentTables().find((table) => table.tableId === tableId), round: finalRound }],
                rounds: [{ ...envelope().snapshot.rounds[0], tableId, shoe: 94, round: finalRound }],
              },
            },
          })
        })
      },
      async completeCaptureOutboxBatch({ claims }) {
        assert.equal(claims.length, 30)
        completeStarted()
        await completeGate
        return { completed: true, count: claims.length }
      },
      async failCaptureOutboxBatch({ error }) { completeFailed(new Error(String(error))); return { failed: true, count: 30 } },
      async getCaptureOutboxHealth() { return { pending: 0, processing: 30, error: 0, dead_letter: 0, next_wakeup_at: null } },
    },
    v104FormalRuntime: {
      async start() {},
      snapshot() { return { status: 'ready' } },
      latestIssuance() { return null },
      async buildPrediction(table) {
        return {
          targetTableId: table.tableId, targetShoe: String(table.shoe), targetRound: Number(table.round) + 1,
          strategyVersion: 'v105', predictionTiming: 'pre_result_context', predictedResult: 'banker', sameSideStreak: 2,
          sidePredictions: { tie: 10, superSix: 10, bankerPair: 10, playerPair: 10, bankerDragon: 10, playerDragon: 10 },
          sideActions: { tie: false, superSix: false, bankerPair: false, playerPair: false, bankerDragon: false, playerDragon: false },
        }
      },
      recordIssuance() {},
      recordSettlement() {},
    },
    v100FormalRuntime: { enabled: true, async processSnapshot({ tables }) { return { tables } } },
  })

  await app.start()
  try {
    await completeStartedGate
    currentRound = 8
    await waitFor(() => issuedTargets.includes('BAG01:9'), 2_000)
    await delay(50)
    assert.equal(issuedTargets.filter((identity) => identity === 'BAG01:9').length, 1)
  } finally {
    releaseComplete()
    await app.waitForCaptureOutboxIdle()
    await app.stop()
  }
})

test('latest prediction refresh persists success per changed table and retries only the failed table', async () => {
  const rounds = new Map(PRODUCTION_TABLE_IDS.map((tableId) => [tableId, 7]))
  const issuedTargets = []
  let clockMs = Date.now()
  let failBag01Target9 = false
  const snapshotAt = () => new Date(Date.now() - 500).toISOString()
  const currentTables = () => PRODUCTION_TABLE_IDS.map((tableId) => ({
    tableId, shoe: 95, round: rounds.get(tableId), sourceUpdatedAt: snapshotAt(),
    beadPlateRaw: '01020102010102', bigRoadRaw: 'BPBPBPB',
  }))
  const app = createApp({
    autoConnect: false,
    now: () => clockMs,
    production: true,
    requireVerifiedStrategy: true,
    memberAuthRequired: false,
    captureOutboxConsumerEnabled: true,
    supabaseClient: {
      configured: true,
      getRuntimeStatus() { return { ready: true, degraded: false } },
      async getLatestCloudTableSnapshot() {
        return { session_id: 'cloud-per-table-refresh', snapshot_at: snapshotAt(), capture_source: 'cloud_browser', tables: currentTables() }
      },
      async reconcilePredictionLifecycle() {},
      async readIssuedPrediction() { return null },
      async issuePrediction(candidate) {
        if (failBag01Target9 && candidate.targetTableId === 'BAG01' && candidate.targetRound === 9) {
          failBag01Target9 = false
          throw new Error('BAG01 transient issuance failure')
        }
        issuedTargets.push(`${candidate.targetTableId}:${candidate.targetRound}`)
        return { ...candidate, predictionId: `pid-${candidate.targetTableId}-${candidate.targetRound}`, issuedAt: snapshotAt() }
      },
    },
    v104FormalRuntime: {
      async start() {},
      snapshot() { return { status: 'ready' } },
      latestIssuance() { return null },
      async buildPrediction(table) {
        return {
          targetTableId: table.tableId, targetShoe: String(table.shoe), targetRound: Number(table.round) + 1,
          strategyVersion: 'v105', predictionTiming: 'pre_result_context', predictedResult: 'banker', sameSideStreak: 2,
          sidePredictions: { tie: 10, superSix: 10, bankerPair: 10, playerPair: 10, bankerDragon: 10, playerDragon: 10 },
          sideActions: { tie: false, superSix: false, bankerPair: false, playerPair: false, bankerDragon: false, playerDragon: false },
        }
      },
      recordIssuance() {},
      recordSettlement() {},
    },
    v100FormalRuntime: { enabled: true, async processSnapshot({ tables }) { return { tables } } },
  })

  try {
    await app.refreshLatestDurablePredictions()
    assert.equal(issuedTargets.filter((identity) => identity.endsWith(':8')).length, 10)

    rounds.set('BAG01', 8)
    rounds.set('BAG02', 8)
    failBag01Target9 = true
    await assert.rejects(app.refreshLatestDurablePredictions(), /latest actionable|BAG01 transient issuance failure/)
    assert.equal(issuedTargets.filter((identity) => identity === 'BAG02:9').length, 1)
    assert.equal(issuedTargets.filter((identity) => identity === 'BAG01:9').length, 0)

    clockMs += 10_001
    await app.refreshLatestDurablePredictions()
    assert.equal(issuedTargets.filter((identity) => identity === 'BAG01:9').length, 1)
    assert.equal(issuedTargets.filter((identity) => identity === 'BAG02:9').length, 1)
    assert.equal(issuedTargets.filter((identity) => identity.endsWith(':8')).length, 10)
  } finally {
    await app.stop()
  }
})

test('production consumer does not block backlog claim for zero-history new-shoe tables', async () => {
  let claims = 0
  let issues = 0
  const snapshotAt = new Date(Date.now() - 1_000).toISOString()
  const app = createApp({
    autoConnect: false,
    production: true,
    requireVerifiedStrategy: true,
    memberAuthRequired: false,
    captureOutboxConsumerEnabled: true,
    outboxCoalesceMs: 0,
    supabaseClient: {
      configured: true,
      getRuntimeStatus() { return { ready: true, degraded: false } },
      async getLatestCloudTableSnapshot() {
        return {
          session_id: 'cloud-new-shoes', snapshot_at: snapshotAt, capture_source: 'cloud_browser',
          tables: PRODUCTION_TABLE_IDS.map((tableId) => ({ tableId, shoe: 91, round: 0, sourceUpdatedAt: snapshotAt })),
        }
      },
      async issuePrediction() { issues += 1; return null },
      async claimCaptureOutbox() { claims += 1; return [] },
      async getCaptureOutboxHealth() { return { pending: 0, processing: 0, error: 0, dead_letter: 0, next_wakeup_at: null } },
    },
    v100FormalRuntime: { enabled: true, async processSnapshot({ tables }) { return { tables } } },
  })

  await app.drainCaptureOutbox()
  assert.equal(claims, 1)
  assert.equal(issues, 0)
  await app.stop()
})

test('production consumer preserves a newer same-shoe live screen when durable cloud snapshot rows lag behind', async () => {
  let claims = 0
  const snapshotAt = new Date(Date.now() - 1_000).toISOString()
  const app = createApp({
    autoConnect: false,
    production: true,
    requireVerifiedStrategy: false,
    memberAuthRequired: false,
    captureOutboxConsumerEnabled: true,
    outboxCoalesceMs: 0,
    supabaseClient: {
      configured: true,
      async getLatestCloudTableSnapshot() {
        return {
          session_id: 'lagging-durable-screen', snapshot_at: snapshotAt, capture_source: 'cloud_browser',
          tables: PRODUCTION_TABLE_IDS.map((tableId) => ({ tableId, shoe: 92, round: tableId === 'BAG10' ? 5 : 13, sourceUpdatedAt: snapshotAt })),
        }
      },
      async claimCaptureOutbox() { claims += 1; return [] },
      async getCaptureOutboxHealth() { return { pending: 0, processing: 0, error: 0, dead_letter: 0, next_wakeup_at: null } },
    },
    v100FormalRuntime: { enabled: true, async processSnapshot({ tables: current }) { return { tables: current } } },
  })
  app.state.setTables(PRODUCTION_TABLE_IDS.map((tableId) => ({
    tableId, shoe: 92, round: 13, sourceUpdatedAt: snapshotAt,
  })))
  await app.waitForServiceWorkIdle()

  await app.drainCaptureOutbox()

  assert.equal(claims, 1)
  assert.equal(app.state.snapshot().tables.find((table) => table.tableId === 'BAG10')?.round, 13)
  await app.stop()
})

test('same-round durable refresh updates the public payload without regressing the screen identity', async () => {
  const snapshotAt = new Date().toISOString()
  const app = createApp({
    autoConnect: false,
    production: true,
    requireVerifiedStrategy: false,
    captureOutboxConsumerEnabled: true,
    supabaseClient: {
      configured: true,
      async getLatestCloudTableSnapshot() {
        return {
          session_id: 'same-round-payload-refresh', snapshot_at: snapshotAt, capture_source: 'cloud_browser',
          tables: PRODUCTION_TABLE_IDS.map((tableId) => ({
            tableId, shoe: 92, round: 13, beadPlateRaw: tableId === 'BAG10' ? '0102' : '', sourceUpdatedAt: snapshotAt,
          })),
        }
      },
      async claimCaptureOutbox() { return [] },
      async getCaptureOutboxHealth() { return { pending: 0, processing: 0, error: 0, dead_letter: 0, next_wakeup_at: null } },
    },
    v100FormalRuntime: { enabled: true, async processSnapshot({ tables: current }) { return { tables: current } } },
  })
  app.state.setTables(PRODUCTION_TABLE_IDS.map((tableId) => ({
    tableId, shoe: 92, round: 13, beadPlateRaw: '', sourceUpdatedAt: snapshotAt,
  })))
  await app.waitForServiceWorkIdle()

  await app.refreshLatestDurablePredictions()

  const bag10 = app.state.snapshot().tables.find((table) => table.tableId === 'BAG10')
  assert.equal(bag10?.round, 13)
  assert.equal(bag10?.beadPlateRaw, '0102')
  await app.stop()
})

test('lagging same-shoe refresh does not renew a retained local screen after the source stops advancing', async () => {
  let nowMs = Date.parse('2026-09-01T01:00:00.000Z')
  let bag09Round = 13
  const snapshotAt = new Date(nowMs).toISOString()
  const app = createApp({
    autoConnect: false,
    now: () => nowMs,
    production: true,
    requireVerifiedStrategy: false,
    memberAuthRequired: false,
    captureOutboxConsumerEnabled: true,
    supabaseClient: {
      configured: true,
      async getLatestCloudTableSnapshot() {
        return {
          session_id: 'stopped-live-source', snapshot_at: new Date().toISOString(), capture_source: 'cloud_browser',
          tables: PRODUCTION_TABLE_IDS.map((tableId) => ({
            tableId, shoe: 92,
            round: tableId === 'BAG10' ? 5 : tableId === 'BAG09' ? bag09Round : 13,
            sourceUpdatedAt: snapshotAt,
          })),
        }
      },
      async claimCaptureOutbox() { return [] },
      async getCaptureOutboxHealth() { return { pending: 0, processing: 0, error: 0, dead_letter: 0, next_wakeup_at: null } },
    },
    v100FormalRuntime: { enabled: true, async processSnapshot({ tables: current }) { return { tables: current } } },
  })
  app.state.setTables(PRODUCTION_TABLE_IDS.map((tableId) => ({
    tableId, shoe: 92, round: 13, sourceUpdatedAt: snapshotAt,
  })))
  await app.waitForServiceWorkIdle()
  for (let index = 0; index < 3; index += 1) {
    nowMs += 60_000
    bag09Round += 1
    await app.refreshLatestDurablePredictions()
  }
  const response = await app.inject({ url: '/api/tables', headers: { 'x-forwarded-proto': 'https' } })
  const tables = JSON.parse(response.body)

  assert.equal(response.statusCode, 200)
  assert.equal(tables.find((table) => table.tableId === 'BAG10')?.round, 5)
  assert.equal(tables.find((table) => table.tableId === 'BAG09')?.round, 16)
  await app.stop()
})

test('fresh local new-shoe screen allows backlog claim while durable snapshot is one shoe behind, then fails closed after local TTL', async () => {
  let claims = 0
  let durableShoe = 92
  let nowMs = Date.parse('2026-09-01T02:00:00.000Z')
  const snapshotAt = new Date().toISOString()
  const app = createApp({
    autoConnect: false,
    now: () => nowMs,
    production: true,
    requireVerifiedStrategy: false,
    memberAuthRequired: false,
    captureOutboxConsumerEnabled: true,
    outboxCoalesceMs: 0,
    supabaseClient: {
      configured: true,
      async getLatestCloudTableSnapshot() {
        return {
          session_id: 'cross-shoe-durable-lag', snapshot_at: snapshotAt, capture_source: 'cloud_browser',
          tables: PRODUCTION_TABLE_IDS.map((tableId) => ({ tableId, shoe: durableShoe, round: 60, sourceUpdatedAt: snapshotAt })),
        }
      },
      async claimCaptureOutbox() { claims += 1; return [] },
      async getCaptureOutboxHealth() { return { pending: 0, processing: 0, error: 0, dead_letter: 0, next_wakeup_at: null } },
    },
    v100FormalRuntime: { enabled: true, async processSnapshot({ tables: current }) { return { tables: current } } },
  })
  app.state.setTables(PRODUCTION_TABLE_IDS.map((tableId) => ({
    tableId, shoe: 93, round: 1, sourceUpdatedAt: snapshotAt,
  })))
  await app.waitForServiceWorkIdle()

  await app.drainCaptureOutbox()
  assert.equal(claims, 1)
  assert.equal(app.state.snapshot().tables.find((table) => table.tableId === 'BAG10')?.shoe, 93)

  durableShoe = 90
  await assert.rejects(app.drainCaptureOutbox(), /shoe regression is not refreshable/)
  assert.equal(claims, 1)

  durableShoe = 92
  nowMs += 120_001
  await assert.rejects(app.drainCaptureOutbox(), /shoe regression is not refreshable/)
  assert.equal(claims, 1)
  await app.stop()
})

test('fresh live shoe one treats durable shoe 999 as exactly one shoe behind without rolling state backward', async () => {
  let claims = 0
  let nowMs = Date.parse('2026-09-01T02:00:00.000Z')
  const snapshotAt = new Date().toISOString()
  const app = createApp({
    autoConnect: false,
    now: () => nowMs,
    production: true,
    requireVerifiedStrategy: false,
    memberAuthRequired: false,
    captureOutboxConsumerEnabled: true,
    outboxCoalesceMs: 0,
    supabaseClient: {
      configured: true,
      async getLatestCloudTableSnapshot() {
        return {
          session_id: 'cross-shoe-wrap-durable-lag', snapshot_at: snapshotAt, capture_source: 'cloud_browser',
          tables: PRODUCTION_TABLE_IDS.map((tableId) => ({ tableId, shoe: 999, round: 60, sourceUpdatedAt: snapshotAt })),
        }
      },
      async claimCaptureOutbox() { claims += 1; return [] },
      async getCaptureOutboxHealth() { return { pending: 0, processing: 0, error: 0, dead_letter: 0, next_wakeup_at: null } },
    },
    v100FormalRuntime: { enabled: true, async processSnapshot({ tables: current }) { return { tables: current } } },
  })
  app.state.setTables(PRODUCTION_TABLE_IDS.map((tableId) => ({
    tableId, shoe: 1, round: 1, sourceUpdatedAt: snapshotAt,
  })))
  await app.waitForServiceWorkIdle()

  await app.drainCaptureOutbox()
  assert.equal(claims, 1)
  assert.equal(app.state.snapshot().tables.find((table) => table.tableId === 'BAG10')?.shoe, 1)

  nowMs += 120_001
  await assert.rejects(app.drainCaptureOutbox(), /shoe regression is not refreshable/)
  assert.equal(claims, 1)
  await app.stop()
})

test('numeric distance cannot reinterpret live shoe 600 and durable shoe 1 as a provider wrap', async () => {
  let claims = 0
  const snapshotAt = new Date().toISOString()
  const app = createApp({
    autoConnect: false,
    production: true,
    requireVerifiedStrategy: false,
    memberAuthRequired: false,
    captureOutboxConsumerEnabled: true,
    outboxCoalesceMs: 0,
    supabaseClient: {
      configured: true,
      async getLatestCloudTableSnapshot() {
        return {
          session_id: 'not-a-provider-wrap', snapshot_at: snapshotAt, capture_source: 'cloud_browser',
          tables: PRODUCTION_TABLE_IDS.map((tableId) => ({ tableId, shoe: 1, round: 1, sourceUpdatedAt: snapshotAt })),
        }
      },
      async claimCaptureOutbox() { claims += 1; return [] },
      async getCaptureOutboxHealth() { return { pending: 0, processing: 0, error: 0, dead_letter: 0, next_wakeup_at: null } },
    },
    v100FormalRuntime: { enabled: true, async processSnapshot({ tables: current }) { return { tables: current } } },
  })
  app.state.setTables(PRODUCTION_TABLE_IDS.map((tableId) => ({
    tableId, shoe: 600, round: 20, sourceUpdatedAt: snapshotAt,
  })))
  await app.waitForServiceWorkIdle()

  await assert.rejects(app.drainCaptureOutbox(), /shoe regression is not refreshable/)
  assert.equal(claims, 0)
  assert.equal(app.state.snapshot().tables.find((table) => table.tableId === 'BAG10')?.shoe, 600)
  await app.stop()
})

test('historical durable shoe 1 cannot masquerade as a new wrap while live shoe 999 is current', async () => {
  let claims = 0
  const snapshotAt = new Date().toISOString()
  const app = createApp({
    autoConnect: false,
    production: true,
    requireVerifiedStrategy: false,
    memberAuthRequired: false,
    captureOutboxConsumerEnabled: true,
    outboxCoalesceMs: 0,
    supabaseClient: {
      configured: true,
      async getLatestCloudTableSnapshot() {
        return {
          session_id: 'historical-shoe-one-replay', snapshot_at: snapshotAt, capture_source: 'cloud_browser',
          tables: PRODUCTION_TABLE_IDS.map((tableId) => ({ tableId, shoe: 1, round: 1, sourceUpdatedAt: snapshotAt })),
        }
      },
      async claimCaptureOutbox() { claims += 1; return [] },
      async getCaptureOutboxHealth() { return { pending: 0, processing: 0, error: 0, dead_letter: 0, next_wakeup_at: null } },
    },
    v100FormalRuntime: { enabled: true, async processSnapshot({ tables: current }) { return { tables: current } } },
  })
  app.state.setTables(PRODUCTION_TABLE_IDS.map((tableId) => ({
    tableId, shoe: 999, round: 60, sourceUpdatedAt: snapshotAt,
  })))
  await app.waitForServiceWorkIdle()

  await assert.rejects(app.drainCaptureOutbox(), /shoe regression is not refreshable/)
  assert.equal(claims, 0)
  assert.equal(app.state.snapshot().tables.find((table) => table.tableId === 'BAG10')?.shoe, 999)
  await app.stop()
})

test('durable forward shoe cannot borrow an older live-source timestamp to tolerate a later rollback', async () => {
  let claims = 0
  let durableShoe = 93
  const snapshotAt = new Date().toISOString()
  const app = createApp({
    autoConnect: false,
    production: true,
    requireVerifiedStrategy: false,
    memberAuthRequired: false,
    captureOutboxConsumerEnabled: true,
    outboxCoalesceMs: 0,
    supabaseClient: {
      configured: true,
      async getLatestCloudTableSnapshot() {
        return {
          session_id: 'durable-forward-then-rollback', snapshot_at: snapshotAt, capture_source: 'cloud_browser',
          tables: PRODUCTION_TABLE_IDS.map((tableId) => ({ tableId, shoe: durableShoe, round: 1, sourceUpdatedAt: snapshotAt })),
        }
      },
      async claimCaptureOutbox() { claims += 1; return [] },
      async getCaptureOutboxHealth() { return { pending: 0, processing: 0, error: 0, dead_letter: 0, next_wakeup_at: null } },
    },
    v100FormalRuntime: { enabled: true, async processSnapshot({ tables: current }) { return { tables: current } } },
  })
  app.state.setTables(PRODUCTION_TABLE_IDS.map((tableId) => ({ tableId, shoe: 92, round: 60, sourceUpdatedAt: snapshotAt })))
  await app.waitForServiceWorkIdle()

  await app.refreshLatestDurablePredictions()
  assert.equal(app.state.snapshot().tables.find((table) => table.tableId === 'BAG10')?.shoe, 93)

  durableShoe = 92
  await assert.rejects(app.drainCaptureOutbox(), /shoe regression is not refreshable/)
  assert.equal(claims, 0)
  await app.stop()
})

for (const invalidCase of [
  { name: 'null round', round: null, primeRound: null },
  { name: 'negative round', round: -1, primeRound: null },
  { name: 'cross-shoe regression', shoe: 91, round: 8, primeShoe: 92, primeRound: 7 },
  { name: 'large cross-shoe regression', shoe: '9007199254740993', round: 8, primeShoe: '9007199254740994', primeRound: 7 },
]) {
  test(`production consumer rejects ${invalidCase.name} before backlog claim`, async () => {
    let claims = 0
    let nowMs = Date.now()
    const snapshotAt = new Date(nowMs - 1_000).toISOString()
    const tables = PRODUCTION_TABLE_IDS.map((tableId) => ({
      tableId, shoe: invalidCase.shoe ?? 92, round: tableId === 'BAG10' ? invalidCase.round : 7, sourceUpdatedAt: snapshotAt,
    }))
    const app = createApp({
      autoConnect: false,
      now: () => nowMs,
      production: true,
      requireVerifiedStrategy: false,
      memberAuthRequired: false,
      captureOutboxConsumerEnabled: true,
      outboxCoalesceMs: 0,
      supabaseClient: {
        configured: true,
        async getLatestCloudTableSnapshot() {
          return { session_id: `invalid-${invalidCase.name}`, snapshot_at: snapshotAt, capture_source: 'cloud_browser', tables }
        },
        async claimCaptureOutbox() { claims += 1; return [] },
        async getCaptureOutboxHealth() { return { pending: 0, processing: 0, error: 0, dead_letter: 0, next_wakeup_at: null } },
      },
      v100FormalRuntime: { enabled: true, async processSnapshot({ tables: current }) { return { tables: current } } },
    })
    if (invalidCase.primeRound != null) {
      app.state.setTables(PRODUCTION_TABLE_IDS.map((tableId) => ({
        tableId, shoe: invalidCase.primeShoe ?? 92, round: invalidCase.primeRound, sourceUpdatedAt: snapshotAt,
      })))
      await app.waitForServiceWorkIdle()
      nowMs += 120_001
    }

    await assert.rejects(app.drainCaptureOutbox(), /round must be a non-negative integer|round regression is not claimable|shoe regression is not refreshable/)
    assert.equal(claims, 0)
    await app.stop()
  })
}

test('production consumer rejects durable non-v105 latest predictions before backlog claim', async () => {
  let claims = 0
  const snapshotAt = new Date(Date.now() - 1_000).toISOString()
  const tables = PRODUCTION_TABLE_IDS.map((tableId) => ({
    tableId, shoe: 93, round: 7, sourceUpdatedAt: snapshotAt,
    beadPlateRaw: '01020102010102', bigRoadRaw: 'BPBPBPB',
  }))
  const app = createApp({
    autoConnect: false,
    production: true,
    requireVerifiedStrategy: true,
    memberAuthRequired: false,
    captureOutboxConsumerEnabled: true,
    outboxCoalesceMs: 0,
    supabaseClient: {
      configured: true,
      getRuntimeStatus() { return { ready: true, degraded: false } },
      async getLatestCloudTableSnapshot() {
        return { session_id: 'wrong-strategy', snapshot_at: snapshotAt, capture_source: 'cloud_browser', tables }
      },
      async reconcilePredictionLifecycle() {},
      async issuePrediction(candidate) {
        return { ...candidate, predictionId: `pid-${candidate.targetTableId}`, issuedAt: snapshotAt }
      },
      async claimCaptureOutbox() { claims += 1; return [] },
      async getCaptureOutboxHealth() { return { pending: 0, processing: 0, error: 0, dead_letter: 0, next_wakeup_at: null } },
    },
    v104FormalRuntime: {
      async start() {},
      snapshot() { return { status: 'ready' } },
      latestIssuance() { return null },
      async buildPrediction(table) {
        return {
          targetTableId: table.tableId, targetShoe: String(table.shoe), targetRound: Number(table.round) + 1,
          strategyVersion: 'v104', predictionTiming: 'pre_result_context', predictedResult: 'banker', sameSideStreak: 2,
          sidePredictions: { tie: 10, superSix: 10, bankerPair: 10, playerPair: 10, bankerDragon: 10, playerDragon: 10 },
          sideActions: { tie: false, superSix: false, bankerPair: false, playerPair: false, bankerDragon: false, playerDragon: false },
        }
      },
      recordIssuance() {},
      recordSettlement() {},
    },
    v100FormalRuntime: { enabled: true, async processSnapshot({ tables: current }) { return { tables: current } } },
  })

  await app.waitForServiceWorkIdle()
  await assert.rejects(app.drainCaptureOutbox(), /durable v105 predictions/)
  assert.equal(claims, 0)
  await app.stop()
})

test('external consumer rejects a hydrated later-round issuance that is not the current screen target', async () => {
  let claimed = false
  let completed = 0
  let failed = 0
  let issued = 0
  const exactReads = []
  const staleSnapshot = {
    ...envelope().snapshot,
    tables: [{ tableId: 'BAG01', shoe: 88, round: 21, sourceUpdatedAt: '2026-08-25T16:00:00.000Z', beadPlateRaw: '0102', bigRoadRaw: 'BP' }],
  }
  const hydratedIssuance = {
    predictionId: 'pid-ahead-30',
    targetTableId: 'BAG01',
    targetShoe: '88',
    targetRound: 30,
    strategyVersion: 'v105',
    predictionTiming: 'pre_result_context',
    predictedResult: 'banker',
    sameSideStreak: 2,
    issuedAt: '2026-08-25T16:00:20.000Z',
  }
  const app = createApp({
    autoConnect: false,
    captureOutboxConsumerEnabled: true,
    outboxCoalesceMs: 0,
    now: () => 1_000_000,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        if (claimed) return []
        claimed = true
        return [claimedRow(8, { payload: { work: staleSnapshot } })]
      },
      async completeCaptureOutbox() { completed += 1 },
      async failCaptureOutbox() { failed += 1 },
      async getCaptureOutboxHealth() { return { pending: 0, processing: 0, error: 0, dead_letter: 0, next_wakeup_at: null } },
      async reconcilePredictionLifecycle() {},
      async readIssuedPrediction(identity) {
        exactReads.push(identity)
        if (Number(identity.round) === 30) return hydratedIssuance
        return null
      },
      async issuePrediction() { issued += 1; assert.fail('a hydrated newer issuance must not be reissued') },
    },
    v104FormalRuntime: {
      async start() {},
      snapshot() { return { status: 'ready' } },
      latestIssuance(tableId) { return tableId === 'BAG01' ? hydratedIssuance : null },
      async buildPrediction() { assert.fail('a backward candidate must not be built') },
      recordIssuance() {},
      recordSettlement() {},
    },
    v100FormalRuntime: {
      enabled: true,
      async processSnapshot({ tables }) { return { enabled: true, predictions: [], tables } },
    },
  })

  app.state.setTables([{
    tableId: 'BAG01', shoe: 88, round: 25, sourceUpdatedAt: '2026-08-25T16:00:05.000Z',
    beadPlateRaw: '0102010201', bigRoadRaw: 'BPBPB',
  }])
  await app.waitForServiceWorkIdle()
  await app.drainCaptureOutbox()
  await app.waitForCaptureOutboxIdle()

  assert.equal(completed, 0)
  assert.equal(failed, 1)
  assert.equal(issued, 0)
  assert.equal(exactReads.some((identity) => Number(identity.round) === 30), false)
  assert.match(app.state.snapshot().status.persistenceError, /backward candidate must not be built|prediction issuance failed before outbox acknowledgement/)
})

test('external consumer rejects a non-current hydrated issuance before inspecting its durable id', async () => {
  let claimed = false
  let failed = 0
  const hydratedIssuance = {
    predictionId: 'pid-ahead-30', targetTableId: 'BAG01', targetShoe: '88', targetRound: 30,
    strategyVersion: 'v105', predictionTiming: 'pre_result_context', predictedResult: 'banker', sameSideStreak: 2,
  }
  const staleSnapshot = {
    ...envelope().snapshot,
    tables: [{ tableId: 'BAG01', shoe: 88, round: 21, sourceUpdatedAt: '2026-08-25T16:00:00.000Z', beadPlateRaw: '0102', bigRoadRaw: 'BP' }],
  }
  const app = createApp({
    autoConnect: false,
    captureOutboxConsumerEnabled: true,
    outboxCoalesceMs: 0,
    now: () => 1_000_000,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        if (claimed) return []
        claimed = true
        return [claimedRow(8, { payload: { work: staleSnapshot } })]
      },
      async completeCaptureOutbox() { assert.fail('mismatched exact coverage must not complete') },
      async failCaptureOutbox() { failed += 1 },
      async getCaptureOutboxHealth() { return { pending: 0, processing: 0, error: 0, dead_letter: 0, next_wakeup_at: null } },
      async readIssuedPrediction(identity) {
        if (Number(identity.round) === 30) return { ...hydratedIssuance, predictionId: 'pid-wrong-30' }
        return null
      },
    },
    v104FormalRuntime: {
      async start() {},
      snapshot() { return { status: 'ready' } },
      latestIssuance() { return hydratedIssuance },
      async buildPrediction() { assert.fail('a backward candidate must not be built') },
      recordIssuance() {},
      recordSettlement() {},
    },
    v100FormalRuntime: {
      enabled: true,
      async processSnapshot({ tables }) { return { enabled: true, predictions: [], tables } },
    },
  })

  await app.drainCaptureOutbox()
  await app.waitForCaptureOutboxIdle()

  assert.equal(failed, 1)
  assert.match(app.state.snapshot().status.persistenceError, /backward candidate must not be built/)
})

test('external consumer retains stale Final lease when the newer same-shoe screen prediction is unavailable', async () => {
  let claimed = false
  let completed = 0
  let failed = 0
  const issuedTargets = []
  const staleSnapshot = {
    ...envelope().snapshot,
    tables: [{ tableId: 'BAG01', shoe: 88, round: 21, sourceUpdatedAt: '2026-08-25T16:00:00.000Z', beadPlateRaw: '0102', bigRoadRaw: 'BP' }],
  }
  const app = createApp({
    autoConnect: false,
    captureOutboxConsumerEnabled: true,
    outboxCoalesceMs: 0,
    now: () => 1_000_000,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        if (claimed) return []
        claimed = true
        return [claimedRow(8, { payload: { work: staleSnapshot } })]
      },
      async completeCaptureOutbox() { completed += 1 },
      async failCaptureOutbox() { failed += 1 },
      async getCaptureOutboxHealth() { return { pending: 0, processing: 0, error: 0, dead_letter: 0, next_wakeup_at: null } },
      async reconcilePredictionLifecycle() {},
      async readIssuedPrediction() { return null },
      async issuePrediction(candidate) { issuedTargets.push(candidate.targetRound); return null },
    },
    v100FormalRuntime: {
      enabled: true,
      async processSnapshot({ tables }) { return { enabled: true, predictions: [], tables } },
    },
  })

  app.state.setTables([{
    tableId: 'BAG01', shoe: 88, round: 25, sourceUpdatedAt: '2026-08-25T16:00:05.000Z',
    beadPlateRaw: '0102010201', bigRoadRaw: 'BPBPB',
  }])
  await app.waitForServiceWorkIdle()
  await app.drainCaptureOutbox()
  await app.waitForCaptureOutboxIdle()

  assert.equal(completed, 0)
  assert.equal(failed, 1)
  assert.equal(issuedTargets.includes(22), false, 'obsolete round-22 prediction must never be issued')
  assert.equal(issuedTargets.every((round) => round === 26), true)
})

test('external consumer retains stale Final lease when the same-shoe screen advances during prediction verification', async () => {
  let claimed = false
  let completed = 0
  let failed = 0
  let formalStarted = false
  let advanced = false
  const candidates = new Map()
  let app
  const staleSnapshot = {
    ...envelope().snapshot,
    tables: [{ tableId: 'BAG01', shoe: 88, round: 21, sourceUpdatedAt: '2026-08-25T16:00:00.000Z', beadPlateRaw: '0102', bigRoadRaw: 'BP' }],
  }
  app = createApp({
    autoConnect: false,
    captureOutboxConsumerEnabled: true,
    outboxCoalesceMs: 0,
    now: () => 1_000_000,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        if (claimed) return []
        claimed = true
        return [claimedRow(8, { payload: { work: staleSnapshot } })]
      },
      async completeCaptureOutbox() { completed += 1 },
      async failCaptureOutbox() { failed += 1 },
      async getCaptureOutboxHealth() { return { pending: 0, processing: 0, error: 0, dead_letter: 0, next_wakeup_at: null } },
      async reconcilePredictionLifecycle() {},
      async issuePrediction(candidate) { candidates.set(candidate.targetRound, candidate); return null },
      async readIssuedPrediction({ round }) {
        if (!formalStarted || round !== 26 || advanced) return null
        advanced = true
        app.state.setTables([{
          tableId: 'BAG01', shoe: 88, round: 26, sourceUpdatedAt: '2026-08-25T16:00:06.000Z',
          beadPlateRaw: '010201020101', bigRoadRaw: 'BPBPBP',
        }])
        return { ...candidates.get(26), predictionId: 'stale-screen-26', issuedAt: '2026-08-25T16:00:05.500Z' }
      },
    },
    v100FormalRuntime: {
      enabled: true,
      async processSnapshot({ tables }) { formalStarted = true; return { enabled: true, predictions: [], tables } },
    },
  })

  app.state.setTables([{
    tableId: 'BAG01', shoe: 88, round: 25, sourceUpdatedAt: '2026-08-25T16:00:05.000Z',
    beadPlateRaw: '0102010201', bigRoadRaw: 'BPBPB',
  }])
  await app.waitForServiceWorkIdle()
  await app.drainCaptureOutbox()
  await app.waitForCaptureOutboxIdle()
  await app.waitForServiceWorkIdle()

  assert.equal(completed, 0)
  assert.equal(failed, 1)
  assert.equal(app.state.snapshot().tables[0].round, 26)
  assert.equal(candidates.has(27), true, 'the latest screen must require target round 27')
})

test('external consumer retains the exact outbox lease when prediction reconciliation fails', async () => {
  let claimed = false
  let completed = 0
  let failed = 0
  let issued = 0
  const snapshot = {
    ...envelope().snapshot,
    tables: [{ tableId: 'BAG01', shoe: 88, round: 21, sourceUpdatedAt: '2026-08-25T16:00:00.000Z', beadPlateRaw: '0102', bigRoadRaw: 'BP' }],
  }
  const app = createApp({
    autoConnect: false,
    captureOutboxConsumerEnabled: true,
    outboxCoalesceMs: 0,
    now: () => 1_000_000,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        if (claimed) return []
        claimed = true
        return [claimedRow(8, { payload: { work: snapshot } })]
      },
      async completeCaptureOutbox() { completed += 1 },
      async failCaptureOutbox() { failed += 1 },
      async getCaptureOutboxHealth() { return { pending: 0, processing: 0, error: 0, dead_letter: 0, next_wakeup_at: null } },
      async readIssuedPrediction() { return null },
      async reconcilePredictionLifecycle() { throw new Error('temporary reconciliation failure') },
      async issuePrediction() { issued += 1; return null },
    },
    v100FormalRuntime: {
      enabled: true,
      async processSnapshot({ tables }) { return { enabled: true, predictions: [], tables } },
    },
  })

  await app.drainCaptureOutbox()
  await app.waitForServiceWorkIdle()

  assert.equal(issued, 0)
  assert.equal(completed, 0)
  assert.equal(failed, 1)
  assert.match(app.state.snapshot().status.persistenceError, /temporary reconciliation failure/)
})

test('external consumer settles every cross-table prediction sibling before failure ACK', async () => {
  let claimed = false
  let siblingFinished = false
  let failureAckBeforeSibling = null
  let failed = 0
  const base = envelope().snapshot
  const firstRound = base.rounds[0]
  const snapshot = {
    ...base,
    tables: [
      { tableId: 'BAG01', shoe: 88, round: 21, sourceUpdatedAt: '2026-08-25T16:00:00.000Z', beadPlateRaw: '0102', bigRoadRaw: 'BP' },
      { tableId: 'BAG02', shoe: 99, round: 7, sourceUpdatedAt: '2026-08-25T16:00:00.000Z', beadPlateRaw: '0102', bigRoadRaw: 'PB' },
    ],
    rounds: [
      { ...firstRound, tableId: 'BAG01', shoe: 88, round: 21 },
      { ...firstRound, tableId: 'BAG02', shoe: 99, round: 7 },
    ],
  }
  const app = createApp({
    autoConnect: false,
    captureOutboxConsumerEnabled: true,
    outboxCoalesceMs: 0,
    now: () => 1_000_000,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        if (claimed) return []
        claimed = true
        return [claimedRow(8, { payload: { work: snapshot } })]
      },
      async completeCaptureOutbox() { assert.fail('failed sibling batch must not complete') },
      async failCaptureOutbox() {
        failureAckBeforeSibling = !siblingFinished
        failed += 1
      },
      async getCaptureOutboxHealth() { return { pending: 0, processing: 0, error: 0, dead_letter: 0, next_wakeup_at: null } },
      async readIssuedPrediction() { return null },
      async reconcilePredictionLifecycle({ tableId }) {
        if (tableId === 'BAG01') throw new Error('BAG01 reconciliation failed')
        await new Promise((resolve) => setTimeout(resolve, 30))
        siblingFinished = true
      },
      async issuePrediction(candidate) {
        return { ...candidate, predictionId: `pid-${candidate.targetTableId}`, issuedAt: '2026-08-25T16:00:01.000Z' }
      },
    },
    v100FormalRuntime: {
      enabled: true,
      async processSnapshot({ tables }) { return { enabled: true, predictions: [], tables } },
    },
  })

  await app.drainCaptureOutbox()
  await new Promise((resolve) => setTimeout(resolve, 40))

  assert.equal(failed, 1)
  assert.equal(failureAckBeforeSibling, false)
  assert.equal(siblingFinished, true)
})

test('external consumer acknowledges a historical Final without issuing from a same-table unkeyed waiting screen', async () => {
  let claimed = false
  let completed = 0
  let failed = 0
  let issued = 0
  const snapshot = {
    ...envelope().snapshot,
    tables: [{ tableId: 'BAG01', shoe: null, round: null, state: 'waiting', sourceUpdatedAt: '2026-08-25T16:00:00.000Z' }],
  }
  const app = createApp({
    autoConnect: false,
    captureOutboxConsumerEnabled: true,
    outboxCoalesceMs: 0,
    now: () => 1_000_000,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        if (claimed) return []
        claimed = true
        return [claimedRow(8, { payload: { work: snapshot } })]
      },
      async completeCaptureOutbox() { completed += 1 },
      async failCaptureOutbox() { failed += 1 },
      async getCaptureOutboxHealth() { return { pending: 0, processing: 0, error: 0, dead_letter: 0, next_wakeup_at: null } },
      async readIssuedPrediction() { return null },
      async reconcilePredictionLifecycle() {},
      async issuePrediction() { issued += 1; return null },
    },
    v100FormalRuntime: {
      enabled: true,
      async processSnapshot({ tables }) {
        return { enabled: true, predictions: [], tables }
      },
    },
  })

  await app.drainCaptureOutbox()
  await app.waitForServiceWorkIdle()

  assert.equal(issued, 0)
  assert.equal(completed, 1)
  assert.equal(failed, 0)
  assert.equal(app.state.snapshot().status.persistenceError, undefined)
})

test('external consumer fails closed when a finalized shoe identity is empty', async () => {
  let claimed = false
  let completed = 0
  let failed = 0
  const base = envelope().snapshot
  const snapshot = {
    ...base,
    rounds: base.rounds.map((round) => ({ ...round, shoe: '' })),
    tables: [{ tableId: 'BAG01', shoe: 89, round: 1, sourceUpdatedAt: '2026-08-25T16:00:00.000Z', beadPlateRaw: '01', bigRoadRaw: 'B' }],
  }
  const app = createApp({
    autoConnect: false,
    captureOutboxConsumerEnabled: true,
    outboxCoalesceMs: 0,
    now: () => 1_000_000,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        if (claimed) return []
        claimed = true
        return [claimedRow(8, { payload: { work: snapshot } })]
      },
      async completeCaptureOutbox() { completed += 1 },
      async failCaptureOutbox() { failed += 1 },
      async getCaptureOutboxHealth() { return { pending: 0, processing: 0, error: 0, dead_letter: 0, next_wakeup_at: null } },
      async readIssuedPrediction() { return null },
      async reconcilePredictionLifecycle() {},
    },
    v100FormalRuntime: {
      enabled: true,
      async processSnapshot() { return { enabled: true, predictions: [], tables: snapshot.tables } },
    },
  })

  await app.drainCaptureOutbox()

  assert.equal(completed, 0)
  assert.equal(failed, 1)
  assert.match(app.state.snapshot().status.persistenceError, /finalized identity missing from published tables/)
})

test('external consumer fails closed when exact issuance read capability is unavailable', async () => {
  let claimed = false
  let completed = 0
  let failed = 0
  const snapshot = {
    ...envelope().snapshot,
    tables: [{ tableId: 'BAG01', shoe: 89, round: 1, sourceUpdatedAt: '2026-08-25T16:00:00.000Z', beadPlateRaw: '01', bigRoadRaw: 'B' }],
  }
  const app = createApp({
    autoConnect: false,
    captureOutboxConsumerEnabled: true,
    outboxCoalesceMs: 0,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        if (claimed) return []
        claimed = true
        return [claimedRow(8, { payload: { work: snapshot } })]
      },
      async completeCaptureOutbox() { completed += 1 },
      async failCaptureOutbox() { failed += 1 },
      async getCaptureOutboxHealth() { return { pending: 0, processing: 0, error: 0, dead_letter: 0, next_wakeup_at: null } },
      async reconcilePredictionLifecycle() {},
    },
    v100FormalRuntime: {
      enabled: true,
      async processSnapshot() { return { enabled: true, predictions: [], tables: snapshot.tables } },
    },
  })

  await app.drainCaptureOutbox()

  assert.equal(completed, 0)
  assert.equal(failed, 1)
  assert.match(app.state.snapshot().status.persistenceError, /issuance read capability/i)
})

test('external consumer fails closed when exact issuance read returns undefined instead of null', async () => {
  let claimed = false
  let completed = 0
  let failed = 0
  const snapshot = {
    ...envelope().snapshot,
    tables: [{ tableId: 'BAG01', shoe: 89, round: 1, sourceUpdatedAt: '2026-08-25T16:00:00.000Z', beadPlateRaw: '01', bigRoadRaw: 'B' }],
  }
  const app = createApp({
    autoConnect: false,
    captureOutboxConsumerEnabled: true,
    outboxCoalesceMs: 0,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        if (claimed) return []
        claimed = true
        return [claimedRow(8, { payload: { work: snapshot } })]
      },
      async completeCaptureOutbox() { completed += 1 },
      async failCaptureOutbox() { failed += 1 },
      async getCaptureOutboxHealth() { return { pending: 0, processing: 0, error: 0, dead_letter: 0, next_wakeup_at: null } },
      async readIssuedPrediction() { return undefined },
      async reconcilePredictionLifecycle() {},
    },
    v100FormalRuntime: {
      enabled: true,
      async processSnapshot() { return { enabled: true, predictions: [], tables: snapshot.tables } },
    },
  })

  await app.drainCaptureOutbox()

  assert.equal(completed, 0)
  assert.equal(failed, 1)
  assert.match(app.state.snapshot().status.persistenceError, /exact issuance read/i)
})

test('external consumer requires a matching Final persistence receipt before acknowledging an issued Final', async () => {
  let claimed = false
  let completed = 0
  let failed = 0
  const snapshot = {
    ...envelope().snapshot,
    tables: [{ tableId: 'BAG01', shoe: 88, round: 21, sourceUpdatedAt: '2026-08-25T16:00:00.000Z', beadPlateRaw: '0102', bigRoadRaw: 'BP' }],
  }
  const app = createApp({
    autoConnect: false,
    captureOutboxConsumerEnabled: true,
    outboxCoalesceMs: 0,
    now: () => 1_000_000,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        if (claimed) return []
        claimed = true
        return [claimedRow(8, { payload: { work: snapshot } })]
      },
      async completeCaptureOutbox() { completed += 1 },
      async failCaptureOutbox() { failed += 1 },
      async getCaptureOutboxHealth() { return { pending: 0, processing: 0, error: 0, dead_letter: 0, next_wakeup_at: null } },
      async readIssuedPrediction(identity) {
        if (identity.round !== 21) return null
        return {
          predictionId: 'pid-BAG01-88-21',
          targetTableId: 'BAG01',
          targetShoe: '88',
          targetRound: 21,
          strategyVersion: 'v105',
        }
      },
      async persistRound() { return null },
      async reconcilePredictionLifecycle() {},
      async issuePrediction(candidate) {
        return { ...candidate, predictionId: 'pid-BAG01-88-22', issuedAt: '2026-08-25T16:00:01.000Z' }
      },
    },
    v100FormalRuntime: {
      enabled: true,
      async processSnapshot({ tables }) { return { enabled: true, predictions: [], tables } },
    },
  })

  await app.drainCaptureOutbox()

  assert.equal(completed, 0)
  assert.equal(failed, 1)
  assert.match(app.state.snapshot().status.persistenceError, /durable settlement receipt/i)
})

test('external consumer rejects a Final persistence receipt with the wrong prediction identity', async () => {
  let claimed = false
  let completed = 0
  let failed = 0
  const snapshot = {
    ...envelope().snapshot,
    tables: [{ tableId: 'BAG01', shoe: 88, round: 21, sourceUpdatedAt: '2026-08-25T16:00:00.000Z', beadPlateRaw: '0102', bigRoadRaw: 'BP' }],
  }
  const app = createApp({
    autoConnect: false,
    captureOutboxConsumerEnabled: true,
    outboxCoalesceMs: 0,
    now: () => 1_000_000,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        if (claimed) return []
        claimed = true
        return [claimedRow(8, { payload: { work: snapshot } })]
      },
      async completeCaptureOutbox() { completed += 1 },
      async failCaptureOutbox() { failed += 1 },
      async getCaptureOutboxHealth() { return { pending: 0, processing: 0, error: 0, dead_letter: 0, next_wakeup_at: null } },
      async readIssuedPrediction(identity) {
        if (identity.round !== 21) return null
        return {
          predictionId: 'pid-BAG01-88-21',
          targetTableId: 'BAG01',
          targetShoe: '88',
          targetRound: 21,
          strategyVersion: 'v105',
        }
      },
      async persistRound() {
        return {
          prediction: {
            predictionId: 'pid-OTHER-999-7',
            targetTableId: 'OTHER',
            targetShoe: '999',
            targetRound: 7,
            strategyVersion: 'v105',
            prediction_features: { settlement_final: true },
          },
        }
      },
      async reconcilePredictionLifecycle() {},
    },
    v100FormalRuntime: {
      enabled: true,
      async processSnapshot({ tables }) { return { enabled: true, predictions: [], tables } },
    },
  })

  await app.drainCaptureOutbox()

  assert.equal(completed, 0)
  assert.equal(failed, 1)
  assert.match(app.state.snapshot().status.persistenceError, /settlement receipt identity/i)
})

test('external consumer reconciles and predicts only the newest shoe when one batch crosses a shoe boundary', async () => {
  let claimed = false
  let completed = 0
  let failed = 0
  const reconciledShoes = []
  const issuedShoes = []
  const oldSnapshot = {
    ...envelope().snapshot,
    tables: [{ tableId: 'BAG01', shoe: 88, round: 21, sourceUpdatedAt: '2026-08-25T16:00:00.000Z', beadPlateRaw: '0102', bigRoadRaw: 'BP' }],
  }
  const base = envelope().snapshot
  const newSnapshot = {
    ...base,
    rounds: base.rounds.map((round) => ({ ...round, shoe: 89, round: 1 })),
    tables: [{ tableId: 'BAG01', shoe: 89, round: 1, sourceUpdatedAt: '2026-08-25T16:00:01.000Z', beadPlateRaw: '01', bigRoadRaw: 'B' }],
  }
  const app = createApp({
    autoConnect: false,
    captureOutboxConsumerEnabled: true,
    captureOutboxBatchLimit: 10,
    outboxCoalesceMs: 0,
    now: () => 1_000_000,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        if (claimed) return []
        claimed = true
        return [
          claimedRow(8, { payload: { work: oldSnapshot } }),
          claimedRow(9, { payload: { work: newSnapshot } }),
        ]
      },
      async completeCaptureOutboxBatch() { completed += 1 },
      async failCaptureOutboxBatch() { failed += 1 },
      async getCaptureOutboxHealth() { return { pending: 0, processing: 0, error: 0, dead_letter: 0, next_wakeup_at: null } },
      async readIssuedPrediction() { return null },
      async reconcilePredictionLifecycle(identity) { reconciledShoes.push(String(identity.currentShoe)) },
      async issuePrediction(candidate) {
        issuedShoes.push(String(candidate.targetShoe))
        return { ...candidate, predictionId: `pid-${candidate.targetTableId}-${candidate.targetShoe}-${candidate.targetRound}`, issuedAt: '2026-08-25T16:00:02.000Z' }
      },
    },
    v100FormalRuntime: {
      enabled: true,
      async processSnapshot({ tables }) { return { enabled: true, predictions: [], tables } },
    },
  })

  await app.drainCaptureOutbox()
  await app.waitForServiceWorkIdle()

  assert.equal(completed, 1)
  assert.equal(failed, 0)
  assert.deepEqual(reconciledShoes, ['89'])
  assert.deepEqual(issuedShoes, ['89'])
})

test('external consumer materializes a finalized table missing beside unrelated published tables', async () => {
  let claimed = false
  let completed = 0
  let failed = 0
  let issued = 0
  const snapshot = {
    ...envelope().snapshot,
    tables: [{ tableId: 'BAG02', shoe: 91, round: 7, sourceUpdatedAt: '2026-08-25T16:00:00.000Z', beadPlateRaw: '0102', bigRoadRaw: 'BP' }],
  }
  const app = createApp({
    autoConnect: false,
    captureOutboxConsumerEnabled: true,
    outboxCoalesceMs: 0,
    now: () => 1_000_000,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        if (claimed) return []
        claimed = true
        return [claimedRow(8, { payload: { work: snapshot } })]
      },
      async completeCaptureOutbox() { completed += 1 },
      async failCaptureOutbox() { failed += 1 },
      async getCaptureOutboxHealth() { return { pending: 0, processing: 0, error: 0, dead_letter: 0, next_wakeup_at: null } },
      async readIssuedPrediction() { return null },
      async reconcilePredictionLifecycle() {},
      async issuePrediction(candidate) {
        issued += 1
        return { ...candidate, predictionId: 'pid-BAG01-88-22', issuedAt: '2026-08-25T16:00:01.000Z' }
      },
    },
    v100FormalRuntime: {
      enabled: true,
      async processSnapshot() {
        return {
          enabled: true,
          predictions: [],
          tables: [{ tableId: 'BAG02', shoe: 91, round: 7, sourceUpdatedAt: '2026-08-25T16:00:00.000Z', beadPlateRaw: '0102', bigRoadRaw: 'BP' }],
        }
      },
    },
  })

  await app.drainCaptureOutbox()
  await app.waitForServiceWorkIdle()

  assert.equal(issued, 1)
  assert.equal(completed, 1)
  assert.equal(failed, 0)
  assert.equal(app.state.snapshot().status.persistenceError, null)
})

test('outbox publication refreshes only tables that actually advanced', async () => {
  let claimed = false
  let durableReadsEnabled = false
  let durableBag01Shoe = 88
  let nowMs = Date.now()
  const sourceUpdatedAt = new Date(nowMs).toISOString()
  const work = {
    ...envelope().snapshot,
    tables: [{ ...envelope().snapshot.tables[0], sourceUpdatedAt, beadPlateRaw: '0102', bigRoadRaw: 'BP' }],
  }
  const app = createApp({
    autoConnect: false,
    captureOutboxConsumerEnabled: true,
    outboxCoalesceMs: 0,
    now: () => nowMs,
    requireVerifiedStrategy: false,
    supabaseClient: {
      configured: true,
      async getLatestCloudTableSnapshot() {
        if (!durableReadsEnabled) return null
        return {
          session_id: 'durable-fallback', snapshot_at: new Date().toISOString(), capture_source: 'cloud_browser',
          tables: PRODUCTION_TABLE_IDS.map((tableId) => ({
            tableId,
            shoe: tableId === 'BAG01' ? durableBag01Shoe : 92,
            round: tableId === 'BAG10' ? 5 : tableId === 'BAG01' ? 21 : 13,
            sourceUpdatedAt,
          })),
        }
      },
      async claimCaptureOutbox() {
        if (claimed) return []
        claimed = true
        return [claimedRow(9, { payload: { work } })]
      },
      async completeCaptureOutbox() {},
      async failCaptureOutbox({ error }) { assert.fail(error) },
      async getCaptureOutboxHealth() { return { pending: 0, processing: 0, error: 0, dead_letter: 0, next_wakeup_at: null } },
      async readIssuedPrediction() { return null },
      async reconcilePredictionLifecycle() {},
      async issuePrediction(candidate) {
        return { ...candidate, predictionId: 'pid-BAG01-88-22', issuedAt: new Date().toISOString() }
      },
    },
    v100FormalRuntime: {
      enabled: true,
      async processSnapshot() {
        return { enabled: true, predictions: [], tables: work.tables }
      },
    },
  })
  app.state.settleRoundEvent = async (round) => ({
    ok: true,
    receipt: {
      durable: true,
      disposition: 'no_issuance',
      tableId: String(round.tableId),
      shoe: String(round.shoe),
      round: Number(round.round),
    },
  })
  app.state.setTables(PRODUCTION_TABLE_IDS.map((tableId) => ({
    tableId,
    shoe: tableId === 'BAG01' ? 88 : 92,
    round: tableId === 'BAG01' ? 20 : 13,
    sourceUpdatedAt,
  })))
  await app.waitForServiceWorkIdle()
  nowMs += 110_000

  await app.drainCaptureOutbox()
  await app.waitForServiceWorkIdle()
  durableReadsEnabled = true
  nowMs += 20_000
  const response = await app.inject({ url: '/api/tables' })
  const tables = JSON.parse(response.body)

  assert.equal(tables.find((table) => table.tableId === 'BAG10')?.round, 5)
  assert.equal(tables.find((table) => table.tableId === 'BAG01')?.round, 21)
  durableBag01Shoe = 87
  await assert.rejects(app.refreshLatestDurablePredictions(), /shoe regression is not refreshable/)
  await app.stop()
})

test('external consumer polls for durable work that arrives without an in-process ACK wake', async () => {
  let pending = false
  let completed = false
  let claimCalls = 0
  const app = createApp({
    autoConnect: false,
    port: 0,
    host: '127.0.0.1',
    captureOutboxPollMs: 10,
    outboxCoalesceMs: 0,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        claimCalls += 1
        if (!pending) return []
        return [claimedRow(8)]
      },
      async completeCaptureOutbox() { pending = false; completed = true },
      async getCaptureOutboxHealth() {
        return { pending: pending ? 1 : 0, processing: 0, error: 0, dead_letter: 0, next_wakeup_at: null }
      },
    },
  })

  await app.start()
  await Promise.race([
    (async () => { while (claimCalls === 0) await delay(5) })(),
    delay(200).then(() => { throw new Error('startup drain did not run') }),
  ])
  await delay(15)
  const claimsAfterInitialDrain = claimCalls
  pending = true
  try {
    await Promise.race([
      (async () => { while (!completed) await delay(5) })(),
      delay(200).then(() => { throw new Error('external consumer poll did not discover durable work') }),
    ])
    assert.ok(claimCalls > claimsAfterInitialDrain)
    assert.equal(completed, true)
  } finally {
    await app.stop()
  }
  const claimsAfterStop = claimCalls
  await delay(25)
  assert.equal(claimCalls, claimsAfterStop, 'poll claimed work after app stop')
})

test('external consumer poll interval is zero-disabled or a bounded safe integer', () => {
  for (const value of [-1, 1, 60_001, 'NaN', '', '   ']) {
    assert.throws(() => createApp({ autoConnect: false, captureOutboxPollMs: value }), /capture outbox poll/i)
  }
  assert.doesNotThrow(() => createApp({ autoConnect: false, captureOutboxPollMs: 0 }))
  assert.doesNotThrow(() => createApp({ autoConnect: false, captureOutboxPollMs: 10 }))
  assert.doesNotThrow(() => createApp({ autoConnect: false, captureOutboxPollMs: 60_000 }))
})

test('ACK scheduled during an in-flight stale health read always triggers a fresh outbox drain', async () => {
  let releaseFirstHealth
  let signalFirstHealthStarted
  const firstHealthGate = new Promise((resolve) => { releaseFirstHealth = resolve })
  const firstHealthStarted = new Promise((resolve) => { signalFirstHealthStarted = resolve })
  let pending = false
  let claimCalls = 0
  let formalCalls = 0
  let healthCalls = 0
  const app = createApp({
    autoConnect: false,
    outboxCoalesceMs: 0,
    ingestKey: 'worker-key',
    now: () => 1_000_000,
    supabaseClient: {
      configured: true,
      async persistCaptureEnvelope(value) {
        pending = true
        return { acceptedRoundKeys: value.roundKeys }
      },
      async writeCloudCaptureStatus() {},
      async writeCloudTableSnapshot() {},
      async writeCloudRoundEvent() {},
      async claimCaptureOutbox() {
        claimCalls += 1
        if (!pending) return []
        pending = false
        return [claimedRow(7, { payload: { work: envelope().snapshot } })]
      },
      async getCaptureOutboxHealth() {
        healthCalls += 1
        if (healthCalls === 1) {
          signalFirstHealthStarted()
          await firstHealthGate
        }
        return { pending: 0, error: 0, processing: 0, dead_letter: 0, next_wakeup_at: null }
      },
      async completeCaptureOutbox() { return { completed: true } },
      async failCaptureOutbox() { assert.fail('fresh durable work must not fail') },
    },
    v100FormalRuntime: {
      enabled: true,
      async processSnapshot({ tables }) {
        formalCalls += 1
        return { tables }
      },
    },
  })

  const staleDrain = app.drainCaptureOutbox()
  await firstHealthStarted
  const response = await app.inject({
    method: 'POST',
    url: '/api/cloud-ingest/snapshot',
    headers: { 'x-worker-key': 'worker-key' },
    body: JSON.stringify(envelope()),
  })
  assert.equal(response.statusCode, 200)
  await delay(20)
  releaseFirstHealth()
  await staleDrain
  await app.waitForCaptureOutboxIdle()

  assert.ok(claimCalls >= 2, `fresh outbox wake was lost after ${claimCalls} claim`)
  assert.equal(formalCalls, 1)
  assert.equal(pending, false)
  await app.stop()
})

test('fresh durable ACK cannot delay an existing immediate backlog continuation', async () => {
  let releaseFirstFormal
  let signalFirstFormalStarted
  let signalSecondClaimStarted
  const firstFormalGate = new Promise((resolve) => { releaseFirstFormal = resolve })
  const firstFormalStarted = new Promise((resolve) => { signalFirstFormalStarted = resolve })
  const secondClaimStarted = new Promise((resolve) => { signalSecondClaimStarted = resolve })
  const makeWork = (round) => {
    const work = structuredClone(envelope().snapshot)
    work.tables[0].round = round
    work.rounds[0].round = round
    return work
  }
  const pendingRows = [
    claimedRow(21, { payload: { work: makeWork(21) } }),
    claimedRow(22, { payload: { work: makeWork(22) } }),
  ]
  let claimCalls = 0
  let formalCalls = 0
  const app = createApp({
    autoConnect: false,
    ingestKey: 'worker-key',
    now: () => 1_000_000,
    outboxCoalesceMs: 1000,
    supabaseClient: {
      configured: true,
      async persistCaptureEnvelope(value) {
        pendingRows.push(claimedRow(value.sequence, { payload: { work: makeWork(23) } }))
        return { acceptedRoundKeys: value.roundKeys }
      },
      async writeCloudCaptureStatus() {},
      async writeCloudTableSnapshot() {},
      async writeCloudRoundEvent() {},
      async claimCaptureOutbox() {
        claimCalls += 1
        if (claimCalls === 2) signalSecondClaimStarted()
        return pendingRows.length > 0 ? [pendingRows.shift()] : []
      },
      async completeCaptureOutbox() { return { completed: true } },
      async failCaptureOutbox() { assert.fail('backlog continuation must not fail') },
      async readIssuedPrediction() { return null },
    },
    v100FormalRuntime: {
      enabled: true,
      async processSnapshot({ tables }) {
        formalCalls += 1
        if (formalCalls === 1) {
          signalFirstFormalStarted()
          await firstFormalGate
        }
        return { tables }
      },
    },
  })

  const firstDrain = app.drainCaptureOutbox()
  await firstFormalStarted
  const freshEnvelope = envelope()
  freshEnvelope.sessionId = 'fresh-worker'
  freshEnvelope.sequence = 23
  freshEnvelope.roundKeys = ['BAG01:88:23']
  freshEnvelope.snapshot.tables[0].round = 23
  freshEnvelope.snapshot.rounds[0].round = 23
  const response = await app.inject({
    method: 'POST',
    url: '/api/cloud-ingest/snapshot',
    headers: { 'x-worker-key': 'worker-key' },
    body: JSON.stringify(freshEnvelope),
  })
  assert.equal(response.statusCode, 200, response.body)
  releaseFirstFormal()

  const continuedImmediately = await Promise.race([
    secondClaimStarted.then(() => true),
    delay(500).then(() => false),
  ])
  assert.equal(continuedImmediately, true, 'fresh ACK delayed an existing 0ms backlog continuation')
  await firstDrain
  await app.waitForCaptureOutboxIdle()
  await app.stop()
})

test('durable ACK remains successful when graceful stop begins before outbox wake scheduling', async () => {
  let releasePersist
  let signalPersistStarted
  const persistGate = new Promise((resolve) => { releasePersist = resolve })
  const persistStarted = new Promise((resolve) => { signalPersistStarted = resolve })
  const app = createApp({
    autoConnect: false,
    ingestKey: 'worker-key',
    now: () => 1_000_000,
    supabaseClient: {
      configured: true,
      async persistCaptureEnvelope(value) {
        signalPersistStarted()
        await persistGate
        return { acceptedRoundKeys: value.roundKeys }
      },
      async writeCloudCaptureStatus() {},
      async writeCloudTableSnapshot() {},
      async writeCloudRoundEvent() {},
      async claimCaptureOutbox() { return [] },
    },
    v100FormalRuntime: { enabled: false },
  })

  const request = app.inject({
    method: 'POST',
    url: '/api/cloud-ingest/snapshot',
    headers: { 'x-worker-key': 'worker-key' },
    body: JSON.stringify(envelope()),
  })
  await persistStarted
  const stopping = app.stop()
  releasePersist()
  const response = await request
  await stopping

  assert.equal(response.statusCode, 200)
  assert.deepEqual(JSON.parse(response.body).acceptedRoundKeys, ['BAG01:88:21'])
})

test('sequential durable ACKs coalesce before one formal outbox batch claim', async () => {
  const pendingRows = []
  const claimedBatchSizes = []
  let formalCalls = 0
  const app = createApp({
    autoConnect: false,
    ingestKey: 'worker-key',
    now: () => 1_000_000,
    outboxCoalesceMs: 25,
    supabaseClient: {
      configured: true,
      async persistCaptureEnvelope(value) {
        const work = structuredClone(envelope().snapshot)
        if (value.sequence === 8) {
          work.tables[0].round = 22
          work.rounds[0].round = 22
        }
        pendingRows.push(claimedRow(value.sequence, { payload: { work } }))
        return { acceptedRoundKeys: value.roundKeys }
      },
      async writeCloudCaptureStatus() {},
      async writeCloudTableSnapshot() {},
      async writeCloudRoundEvent() {},
      async claimCaptureOutbox() {
        if (pendingRows.length === 0) return []
        const rows = pendingRows.splice(0, 3)
        claimedBatchSizes.push(rows.length)
        return rows
      },
      async completeCaptureOutboxBatch({ claims }) { return { completed: claims.length } },
      async failCaptureOutboxBatch() { assert.fail('coalesced work must not fail') },
    },
    v100FormalRuntime: {
      enabled: true,
      async processSnapshot({ tables }) {
        formalCalls += 1
        return { tables }
      },
    },
  })

  const first = envelope()
  const second = structuredClone(first)
  second.sequence = 8
  second.roundKeys = ['BAG01:88:22']
  second.snapshot.tables[0].round = 22
  second.snapshot.rounds[0].round = 22
  const firstResponse = await app.inject({ method: 'POST', url: '/api/cloud-ingest/snapshot', headers: { 'x-worker-key': 'worker-key' }, body: JSON.stringify(first) })
  await delay(5)
  const secondResponse = await app.inject({ method: 'POST', url: '/api/cloud-ingest/snapshot', headers: { 'x-worker-key': 'worker-key' }, body: JSON.stringify(second) })
  assert.equal(firstResponse.statusCode, 200)
  assert.equal(secondResponse.statusCode, 200)
  await delay(50)
  await app.waitForCaptureOutboxIdle()

  assert.deepEqual(claimedBatchSizes, [2])
  assert.equal(formalCalls, 1)
  await app.stop()
})

test('outbox coalescing rejects invalid or unbounded configuration', async () => {
  for (const value of ['', Number.NaN, -1, 1.5, 5001]) {
    assert.throws(
      () => createApp({ autoConnect: false, outboxCoalesceMs: value }),
      /outbox coalesce.*integer.*0.*5000/i,
    )
  }
  const app = createApp({ autoConnect: false, outboxCoalesceMs: 0 })
  await app.stop()
})

test('outbox batch limit rejects invalid or unbounded configuration', async () => {
  for (const value of ['', Number.NaN, 0, 1.5, 101]) {
    assert.throws(
      () => createApp({ autoConnect: false, captureOutboxBatchLimit: value }),
      /outbox batch limit.*integer.*1.*100/i,
    )
  }
  const app = createApp({ autoConnect: false, captureOutboxBatchLimit: 100 })
  await app.stop()

  const defaultLimits = []
  const defaultApp = createApp({
    autoConnect: false,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox({ limit }) { defaultLimits.push(limit); return [] },
      async completeCaptureOutboxBatch() {},
      async failCaptureOutboxBatch() {},
    },
  })
  await defaultApp.drainCaptureOutbox()
  await defaultApp.waitForCaptureOutboxIdle()
  assert.equal(defaultLimits[0], 30, 'Main60 defaults to the adaptive thirty-row formal batch after the live Batch10 throughput gate failed')
  await defaultApp.stop()
})

test('batch lease deadline preserves single-unit work and adds bounded multi-batch jitter budget', () => {
  assert.equal(resolveCaptureOutboxLeaseDeadlineMs(45_000, 1), 45_000)
  assert.equal(resolveCaptureOutboxLeaseDeadlineMs(45_000, 10), 45_000)
  assert.equal(resolveCaptureOutboxLeaseDeadlineMs(45_000, 11), 135_000)
  assert.equal(resolveCaptureOutboxLeaseDeadlineMs(45_000, 30), 180_000)
  assert.equal(resolveCaptureOutboxLeaseDeadlineMs(45_000, 100), 240_000)
  assert.equal(resolveCaptureOutboxLeaseDeadlineMs(100_000, 30), 240_000)
  assert.ok(resolveCaptureOutboxLeaseDeadlineMs(45_000, 100) < 300_000)
})

test('same-session 100-row outbox batch preserves per-table round order and completes every exact lease atomically', async () => {
  let claimed = false
  const formalInputs = []
  const completedBatches = []
  const makeFinal = (tableId, round) => ({
    tableId, shoe: 88, round, winner: 'banker',
    rawResult: [1, 9, 2, 10, -1, -1, -1, -1, 1, 9],
    sourceAction: '/api/v1/gametype/*/game/*/room/*/table/*/summary',
  })
  const makeWork = (tableId, round) => ({
    ...envelope().snapshot,
    tables: [{ ...envelope().snapshot.tables[0], tableId, shoe: 88, round }],
    rounds: [makeFinal(tableId, round)],
  })
  const tableIds = ['BAG01', 'BAG02', 'BAG03', 'BAG03A', 'BAG05', 'BAG06', 'BAG07', 'BAG08', 'BAG09', 'BAG10']
  const rows = Array.from({ length: 100 }, (_, index) => {
    const sequence = 21 + index
    const tableRound = 21 + Math.floor(index / tableIds.length)
    return claimedRow(sequence, { payload: { work: makeWork(tableIds[index % tableIds.length], tableRound) } })
  })
  const app = createApp({
    autoConnect: false,
    captureOutboxBatchLimit: 100,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox({ limit }) {
        assert.equal(limit, 100)
        if (claimed) return []
        claimed = true
        return rows
      },
      async completeCaptureOutboxBatch({ claims }) {
        completedBatches.push(claims)
        return { completed: true, count: claims.length }
      },
      async failCaptureOutboxBatch() { assert.fail('successful batch must not fail') },
      async readIssuedPrediction() { return null },
      async reconcilePredictionLifecycle() {},
      async issuePrediction(candidate) {
        return { ...candidate, predictionId: `pid-${candidate.targetTableId}`, issuedAt: '2026-08-25T16:00:01.000Z' }
      },
    },
    v100FormalRuntime: {
      enabled: true,
      async processSnapshot(input) {
        formalInputs.push(structuredClone(input))
        return { tables: input.tables }
      },
    },
  })

  await app.drainCaptureOutbox()
  await app.waitForCaptureOutboxIdle()

  assert.equal(formalInputs.length, 1)
  assert.equal(formalInputs[0].rounds.length, 100)
  for (const tableId of tableIds) {
    assert.deepEqual(
      formalInputs[0].rounds.filter((round) => round.tableId === tableId).map((round) => round.round),
      Array.from({ length: 10 }, (_, index) => 21 + index),
    )
  }
  assert.equal(completedBatches.length, 1)
  assert.equal(completedBatches[0].length, 100)
  assert.deepEqual(completedBatches[0].map((claim) => claim.sequence), Array.from({ length: 100 }, (_, index) => 21 + index))
})

test('thirty-row formal batch scales the bounded lease deadline instead of reusing the single-work-item budget', async () => {
  let claimed = false
  let completed = 0
  let failed = 0
  const rows = Array.from({ length: 30 }, (_, index) => claimedRow(101 + index, {
    payload: {
      work: {
        ...envelope().snapshot,
        tables: [{ ...envelope().snapshot.tables[0], tableId: 'BAG01', shoe: 88, round: 130 }],
        rounds: [{ ...envelope().snapshot.rounds[0], tableId: 'BAG01', shoe: 88, round: 101 + index }],
      },
    },
  }))
  const app = createApp({
    autoConnect: false,
    captureOutboxBatchLimit: 30,
    outboxWorkDeadlineMs: 40,
    outboxBackoffMs: 1,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        if (claimed) return []
        claimed = true
        return rows
      },
      async completeCaptureOutboxBatch({ claims }) { completed = claims.length; return { completed: true, count: claims.length } },
      async failCaptureOutboxBatch() { failed += 1; return { failed: true, count: rows.length } },
      async readIssuedPrediction() { return null },
      async reconcilePredictionLifecycle() {},
      async issuePrediction(candidate) {
        return { ...candidate, predictionId: 'pid-scaled-batch-deadline', issuedAt: '2026-08-25T16:00:01.000Z' }
      },
    },
    v100FormalRuntime: {
      enabled: true,
      async processSnapshot({ tables }) {
        await delay(90)
        return { tables }
      },
    },
  })

  await app.drainCaptureOutbox()
  await app.waitForCaptureOutboxIdle()

  assert.equal(completed, 30)
  assert.equal(failed, 0)
})

test('same-session outbox batch failure drains merged work then fails every exact lease atomically', async () => {
  let claimed = false
  const failedBatches = []
  const rows = [21, 22].map((sequence) => claimedRow(sequence, {
    payload: { work: { ...envelope().snapshot, rounds: [{ ...envelope().snapshot.rounds[0], round: sequence }] } },
  }))
  const app = createApp({
    autoConnect: false,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        if (claimed) return []
        claimed = true
        return rows
      },
      async completeCaptureOutboxBatch() { assert.fail('failed batch must not complete') },
      async failCaptureOutboxBatch(payload) { failedBatches.push(payload); return { failed: true, count: payload.claims.length } },
    },
    v100FormalRuntime: {
      enabled: true,
      async processSnapshot() { throw new Error('formal batch failure') },
    },
  })

  const result = await app.drainCaptureOutbox()
  await app.waitForCaptureOutboxIdle()

  assert.deepEqual(result, { processed: 0, failed: 2 })
  assert.equal(failedBatches.length, 1)
  assert.match(failedBatches[0].error, /formal batch failure/)
  assert.deepEqual(failedBatches[0].claims.map((claim) => claim.sequence), [21, 22])
})

test('zero-Final heartbeat completes durable outbox without entering formal prediction work', async () => {
  let claimed = false
  let formalStarted = false
  const completed = []
  const app = createApp({
    autoConnect: false,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        if (claimed) return []
        claimed = true
        return [claimedRow(8)]
      },
      async completeCaptureOutbox(identity) { completed.push(identity); return { completed: true } },
      async failCaptureOutbox() { assert.fail('zero-Final heartbeat must complete directly') },
    },
    v100FormalRuntime: {
      enabled: true,
      async processSnapshot() {
        formalStarted = true
        await new Promise(() => {})
      },
    },
  })
  const result = await Promise.race([
    app.drainCaptureOutbox(),
    delay(50).then(() => ({ timeout: true })),
  ])
  assert.deepEqual(result, { processed: 1, failed: 0 })
  assert.equal(formalStarted, false)
  assert.deepEqual(completed, [{ sessionId: 'outbox-worker', sequence: 8, claimToken: 'lease-8', attempt: 1 }])
  await app.stop()
})

test('restart drains a pending durable outbox item before marking it complete', async () => {
  const completed = []
  let claimed = false
  const work = envelope().snapshot
  const app = createApp({
    autoConnect: false,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        if (claimed) return []
        claimed = true
        return [claimedRow(7, { payload: { work } })]
      },
      async completeCaptureOutbox(identity) { completed.push(identity); return { completed: true } },
      async failCaptureOutbox() { assert.fail('valid pending work must not fail') },
      async readIssuedPrediction() { return null },
    },
    v100FormalRuntime: {
      enabled: true,
      async processSnapshot({ tables }) { return { tables } },
    },
  })
  const result = await app.drainCaptureOutbox()
  assert.deepEqual(result, { processed: 1, failed: 0 })
  assert.deepEqual(completed, [{ sessionId: 'outbox-worker', sequence: 7, claimToken: 'lease-7', attempt: 1 }])
})

retiredServerShadowTest('shadow work must settle before a timed-out lease is failed for retry', async () => {
  let claimed = false
  let completed = 0
  const failures = []
  let releaseSettlement
  const settlementGate = new Promise((resolve) => { releaseSettlement = resolve })
  const app = createApp({
    autoConnect: false,
    outboxWorkDeadlineMs: 25,
    shadowServiceWorkTimeoutMs: 5,
    shadowShutdownDeadlineMs: 10,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        if (claimed) return []
        claimed = true
        return [claimedRow(7, { payload: { work: envelope().snapshot } })]
      },
      async completeCaptureOutbox() { completed += 1 },
      async failCaptureOutbox(identity) { failures.push(identity); return { failed: true, retryAfterMs: 10 } },
      async readIssuedPrediction() { return null },
    },
    v100FormalRuntime: { enabled: false },
    v105ShadowV9Runtime: {
      enabled: true,
      async observeTable() {},
      async settleRound() { await settlementGate },
    },
  })

  const draining = app.drainCaptureOutbox()
  await delay(35)
  assert.equal(failures.length, 0, 'failure ACK must not release a lease while shadow work is still active')
  releaseSettlement()
  const result = await draining
  assert.deepEqual(result, { processed: 0, failed: 1 })
  assert.equal(completed, 0)
  assert.equal(failures.length, 1)
  assert.deepEqual(
    { sessionId: failures[0].sessionId, sequence: failures[0].sequence, claimToken: failures[0].claimToken, attempt: failures[0].attempt },
    { sessionId: 'outbox-worker', sequence: 7, claimToken: 'lease-7', attempt: 1 },
  )
  await app.stop()
})

test('same and older sequences always reach durable DB verification and conflicting payload returns 409', async () => {
  const persisted = []
  const app = createApp({
    autoConnect: false, ingestKey: 'worker-key', now: () => 1_000_000,
    supabaseClient: {
      configured: true,
      async writeCloudTableSnapshot() {},
      async writeCloudRoundEvent() {},
      async persistCaptureEnvelope(value) {
        persisted.push(structuredClone(value))
        if (persisted.length === 2) {
          const error = new Error('capture identity conflict')
          error.statusCode = 409
          throw error
        }
        return { acceptedRoundKeys: value.roundKeys, duplicate: persisted.length > 1 }
      },
      async claimCaptureOutbox() { return [] },
    },
  })
  const first = await app.inject({ method: 'POST', url: '/api/cloud-ingest/snapshot', headers: { 'x-worker-key': 'worker-key' }, body: JSON.stringify(envelope()) })
  const conflicting = envelope()
  conflicting.snapshot.rounds[0].winner = 'player'
  conflicting.snapshot.connected = false
  const second = await app.inject({ method: 'POST', url: '/api/cloud-ingest/snapshot', headers: { 'x-worker-key': 'worker-key' }, body: JSON.stringify(conflicting) })
  const older = envelope()
  older.sequence = 6
  older.snapshot.connected = false
  older.snapshot.tables[0].round = 20
  const third = await app.inject({ method: 'POST', url: '/api/cloud-ingest/snapshot', headers: { 'x-worker-key': 'worker-key' }, body: JSON.stringify(older) })
  assert.equal(first.statusCode, 200)
  assert.equal(second.statusCode, 409)
  assert.equal(JSON.parse(second.body).error, 'sequence_payload_conflict')
  assert.equal(third.statusCode, 200)
  assert.equal(JSON.parse(third.body).duplicate, true)
  assert.equal(persisted.length, 3, 'memory cache must never bypass durable duplicate verification')
  assert.equal(app.state.snapshot().status.connected, true, 'older DB-verified duplicate must not regress status')
  assert.equal(app.state.snapshot().tables[0].round, 21, 'older DB-verified duplicate must not regress snapshot')
})

test('same envelope retry passes bit-stable durable input after an acknowledgement is lost', async () => {
  const persisted = []
  const app = createApp({
    autoConnect: false, ingestKey: 'worker-key', now: () => 1_000_000,
    supabaseClient: {
      configured: true,
      async writeCloudTableSnapshot() {},
      async writeCloudRoundEvent() {},
      async persistCaptureEnvelope(value) {
        persisted.push(structuredClone(value))
        return { acceptedRoundKeys: value.roundKeys, duplicate: persisted.length > 1 }
      },
      async claimCaptureOutbox() { return [] },
    },
  })
  const body = JSON.stringify(envelope())
  const first = await app.inject({ method: 'POST', url: '/api/cloud-ingest/snapshot', headers: { 'x-worker-key': 'worker-key' }, body })
  await delay(5)
  const retry = await app.inject({ method: 'POST', url: '/api/cloud-ingest/snapshot', headers: { 'x-worker-key': 'worker-key' }, body })
  assert.equal(first.statusCode, 200)
  assert.equal(retry.statusCode, 200)
  assert.equal(JSON.parse(retry.body).duplicate, true)
  assert.deepEqual(persisted[1], persisted[0], 'same Worker identity must produce the exact same DB payload')
})

test('rawOutboxMs measures the real durable DB acknowledgement latency', async () => {
  const app = createApp({
    autoConnect: false, ingestKey: 'worker-key', now: () => 1_000_000,
    supabaseClient: {
      configured: true,
      async writeCloudTableSnapshot() {},
      async writeCloudRoundEvent() {},
      async persistCaptureEnvelope(value) {
        await delay(15)
        return { acceptedRoundKeys: value.roundKeys }
      },
      async claimCaptureOutbox() { return [] },
    },
  })
  const response = await app.inject({ method: 'POST', url: '/api/cloud-ingest/snapshot', headers: { 'x-worker-key': 'worker-key' }, body: JSON.stringify(envelope()) })
  assert.equal(response.statusCode, 200)
  assert.ok(app.state.snapshot().status.durableTimings.rawOutboxMs >= 10)
})

test('bounded outbox passes automatically continue beyond 100 rows without monopolizing one event-loop turn', async () => {
  const rows = Array.from({ length: 101 }, (_, index) => claimedRow(index + 1))
  const claimLimits = []
  let completed = 0
  let eventLoopYielded = false
  const app = createApp({
    autoConnect: false,
    outboxBackoffMs: 1,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox({ limit }) {
        claimLimits.push(limit)
        if (completed === 1) assert.equal(eventLoopYielded, true, 'next durable row must start in a later event-loop turn')
        return rows.splice(0, limit)
      },
      async completeCaptureOutbox() {
        completed += 1
        if (completed === 1) setImmediate(() => { eventLoopYielded = true })
        return { completed: true }
      },
      async failCaptureOutbox() { assert.fail('valid rows must not fail') },
      async getCaptureOutboxHealth() {
        await delay(10)
        return { pending: rows.length, error: 0, processing: 0, dead_letter: 0, alert: false, next_wakeup_at: null }
      },
    },
    v100FormalRuntime: { enabled: false },
  })
  await app.drainCaptureOutbox()
  await app.waitForCaptureOutboxIdle()
  assert.equal(completed, 101)
  assert.ok(claimLimits.every((limit) => limit === 1), 'each pass must claim exactly one durable row')
})

test('drain publishes dead-letter health for alerts and operations gates', async () => {
  const app = createApp({
    autoConnect: false,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() { return [] },
      async getCaptureOutboxHealth() {
        return { pending: 0, error: 0, processing: 0, dead_letter: 2, alert: true }
      },
    },
  })
  await app.drainCaptureOutbox()
  assert.deepEqual(app.state.snapshot().status.captureOutbox, {
    pending: 0, error: 0, processing: 0, dead_letter: 2, alert: true,
  })
})

test('health next_wakeup_at automatically wakes error and stale-processing rows when they become claimable', async () => {
  let claims = 0
  let completed = 0
  let healthReads = 0
  const app = createApp({
    autoConnect: false, outboxBackoffMs: 1,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        claims += 1
        if (claims === 1) return []
        if (claims === 2) return [claimedRow(1)]
        return []
      },
      async completeCaptureOutbox() { completed += 1; return { completed: true } },
      async failCaptureOutbox() { assert.fail('claimable retry must complete') },
      async getCaptureOutboxHealth() {
        healthReads += 1
        return healthReads === 1
          ? { pending: 0, error: 1, processing: 0, dead_letter: 0, alert: false, next_wakeup_at: new Date(Date.now() + 5).toISOString() }
          : { pending: 0, error: 0, processing: 0, dead_letter: 0, alert: false, next_wakeup_at: null }
      },
    },
    v100FormalRuntime: { enabled: false },
  })
  await app.drainCaptureOutbox()
  await app.waitForCaptureOutboxIdle()
  assert.ok(claims >= 2)
  assert.equal(completed, 1)
})

test('transient outbox health failure schedules a bounded retry instead of stalling durable work', async () => {
  let claims = 0
  let healthReads = 0
  const app = createApp({
    autoConnect: false, outboxBackoffMs: 1,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() { claims += 1; return [] },
      async getCaptureOutboxHealth() {
        healthReads += 1
        if (healthReads === 1) throw new Error('temporary health RPC outage')
        return { pending: 0, error: 0, processing: 0, dead_letter: 0, alert: false, next_wakeup_at: null }
      },
    },
  })
  await app.drainCaptureOutbox()
  await delay(40)
  await app.stop()
  assert.ok(claims >= 2)
  assert.ok(healthReads >= 2)
})

test('persistent outbox health failure uses increasing backoff instead of fixed-rate polling', async () => {
  const claimTimes = []
  const app = createApp({
    autoConnect: false, outboxBackoffMs: 10,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() { claimTimes.push(Date.now()); return [] },
      async getCaptureOutboxHealth() { throw new Error('persistent health RPC outage') },
    },
  })
  await app.drainCaptureOutbox()
  await waitFor(() => claimTimes.length >= 5, 1500)
  assert.equal(claimTimes.length, 5)
  const gaps = claimTimes.slice(1).map((time, index) => time - claimTimes[index])
  assert.ok(gaps[1] >= 15, `second retry did not back off: ${gaps.join(',')}`)
  assert.ok(gaps[2] >= 30, `third retry did not back off: ${gaps.join(',')}`)
  assert.ok(gaps[3] >= 60, `fourth retry did not back off: ${gaps.join(',')}`)
  await delay(45)
  await app.stop()
  assert.equal(claimTimes.length, 5, `fixed-rate polling detected: ${claimTimes.length} claims`)
})

test('successful outbox health read resets only the health retry backoff', async () => {
  let healthReads = 0
  const app = createApp({
    autoConnect: false, outboxBackoffMs: 100,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() { return [] },
      async getCaptureOutboxHealth() {
        healthReads += 1
        if (healthReads === 1 || healthReads === 3) throw new Error('intermittent health RPC outage')
        if (healthReads === 2) {
          return { pending: 1, error: 0, processing: 0, dead_letter: 0, alert: false, next_wakeup_at: new Date(Date.now() + 1).toISOString() }
        }
        return { pending: 0, error: 0, processing: 0, dead_letter: 0, alert: false, next_wakeup_at: null }
      },
    },
  })
  await app.drainCaptureOutbox()
  await delay(450)
  await app.stop()
  assert.ok(healthReads >= 4, `health backoff did not reset after recovery: ${healthReads} reads`)
})

test('multiple session retries schedule the earliest retry instead of the slowest', async () => {
  let claimCalls = 0
  const app = createApp({
    autoConnect: false, outboxBackoffMs: 1,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        claimCalls += 1
        if (claimCalls === 1) {
          return [
            claimedRow(1, { session_id: 'slow-session', payload: {} }),
            claimedRow(2, { session_id: 'fast-session', payload: {} }),
          ]
        }
        return []
      },
      async failCaptureOutbox({ sessionId }) {
        return { failed: true, isolated: false, retry_after_ms: sessionId === 'slow-session' ? 1000 : 10 }
      },
    },
    v100FormalRuntime: { enabled: false },
  })
  await app.drainCaptureOutbox()
  await delay(120)
  await app.stop()
  assert.ok(claimCalls >= 2, `earliest retry was missed: ${claimCalls} claim`)
})

test('an earlier health wakeup replaces an already scheduled later retry timer', async () => {
  let claimCalls = 0
  let healthReads = 0
  const app = createApp({
    autoConnect: false, outboxBackoffMs: 1,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        claimCalls += 1
        return claimCalls === 1 ? [claimedRow(1, { payload: {} })] : []
      },
      async failCaptureOutbox() { return { failed: true, isolated: false, retry_after_ms: 1000 } },
      async getCaptureOutboxHealth() {
        healthReads += 1
        return healthReads === 1
          ? { pending: 1, error: 0, processing: 0, dead_letter: 0, alert: false, next_wakeup_at: new Date(Date.now() + 10).toISOString() }
          : { pending: 0, error: 0, processing: 0, dead_letter: 0, alert: false, next_wakeup_at: null }
      },
    },
    v100FormalRuntime: { enabled: false },
  })
  await app.drainCaptureOutbox()
  await delay(120)
  await app.stop()
  assert.ok(claimCalls >= 2, `earlier health wakeup was ignored: ${claimCalls} claim`)
})

test('temporary claim failure retries but an uncancellable exact failure ACK is never duplicated', async () => {
  let claimCalls = 0
  let failCalls = 0
  const completed = []
  const app = createApp({
    autoConnect: false, outboxBackoffMs: 1, outboxWorkDeadlineMs: 25,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        claimCalls += 1
        if (claimCalls === 1) throw new Error('temporary claim outage')
        if (claimCalls === 2) return [claimedRow(1, { payload: {} })]
        if (claimCalls === 3) return [claimedRow(2)]
        return []
      },
      async completeCaptureOutbox({ sequence }) { completed.push(sequence); return { completed: true } },
      async failCaptureOutbox(identity) {
        failCalls += 1
        throw new Error(`temporary fail RPC outage for ${identity.claimToken}`)
      },
    },
    v100FormalRuntime: { enabled: false },
  })
  await app.drainCaptureOutbox().catch(() => {})
  await app.waitForCaptureOutboxIdle()
  assert.ok(claimCalls >= 3)
  assert.equal(failCalls, 1)
  assert.deepEqual(completed, [2], 'a failure ACK outage must not drop the next claimable Final')
})

test('each consumer work item has a deadline and records failure through its exact lease', async () => {
  let failure
  let claimed = false
  const app = createApp({
    autoConnect: false, outboxWorkDeadlineMs: 10, outboxBackoffMs: 1,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        if (claimed) return []
        claimed = true
        return [claimedRow(1, { payload: { work: envelope().snapshot } })]
      },
      async completeCaptureOutbox() { assert.fail('timed out work must not complete') },
      async failCaptureOutbox(identity) { failure = identity; return { failed: true, isolated: true } },
    },
    v100FormalRuntime: { enabled: true, async processSnapshot() { await delay(50); throw new Error('late work failure') } },
  })
  await app.drainCaptureOutbox()
  assert.match(failure.error, /deadline exceeded/i)
  assert.equal(failure.claimToken, 'lease-1')
  assert.equal(failure.attempt, 1)
})

test('formal deadline waits for the underlying work to settle before failure ACK permits a retry', async () => {
  let claimCalls = 0
  let formalCalls = 0
  let activeFormal = 0
  let maxActiveFormal = 0
  let failureAckWhileFormalActive = false
  const completed = []
  const app = createApp({
    autoConnect: false, outboxWorkDeadlineMs: 1000, outboxBackoffMs: 1,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        claimCalls += 1
        if (claimCalls > 2) return []
        return [claimedRow(1, {
          attempts: claimCalls,
          claim_token: `lease-attempt-${claimCalls}`,
          payload: { work: envelope().snapshot },
        })]
      },
      async completeCaptureOutbox({ attempt }) { completed.push(attempt); return { completed: true } },
      async failCaptureOutbox() {
        failureAckWhileFormalActive = activeFormal > 0
        return { failed: true, retry_after_ms: 0 }
      },
      async readIssuedPrediction() { return null },
      async reconcilePredictionLifecycle() {},
      async issuePrediction(candidate) {
        return { ...candidate, predictionId: 'pid-BAG01-88-22', issuedAt: '2026-08-25T16:00:01.000Z' }
      },
    },
    v100FormalRuntime: {
      enabled: true,
      async processSnapshot({ tables }) {
        formalCalls += 1
        const call = formalCalls
        activeFormal += 1
        maxActiveFormal = Math.max(maxActiveFormal, activeFormal)
        if (call === 1) await delay(3000)
        activeFormal -= 1
        return { tables }
      },
    },
  })

  await app.drainCaptureOutbox()
  await app.waitForCaptureOutboxIdle()

  assert.equal(failureAckWhileFormalActive, false, 'failure ACK must remain fenced behind the timed-out Formal promise')
  assert.equal(maxActiveFormal, 1, 'a reclaimed attempt must not overlap the old Formal lifecycle')
  assert.deepEqual(completed, [2])
})

test('consumer deadline includes the completion ACK RPC', async () => {
  let failure
  let claimed = false
  const app = createApp({
    autoConnect: false, outboxWorkDeadlineMs: 10, outboxBackoffMs: 1,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        if (claimed) return []
        claimed = true
        return [claimedRow(1)]
      },
      async completeCaptureOutbox() { await delay(50); throw new Error('late completion failure') },
      async failCaptureOutbox(identity) { failure = identity; return { failed: true, isolated: true } },
    },
    v100FormalRuntime: { enabled: false },
  })
  await app.drainCaptureOutbox()
  assert.match(failure.error, /deadline exceeded/i)
})

test('stalled failure RPC is bounded and cannot block shutdown forever', async () => {
  let claimed = false
  const app = createApp({
    autoConnect: false, outboxWorkDeadlineMs: 10, outboxBackoffMs: 1,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        if (claimed) return []
        claimed = true
        return [claimedRow(1, { payload: {} })]
      },
      async failCaptureOutbox() { await new Promise(() => {}) },
    },
    v100FormalRuntime: { enabled: false },
  })
  const settled = await Promise.race([
    app.drainCaptureOutbox().then(() => true, () => true),
    delay(200).then(() => false),
  ])
  assert.equal(settled, true)
  await app.stop()
})

test('scaled 120-second failure path sends one exact failure ACK while processing stays reclaimable and pending grows', async () => {
  let claimed = false
  let processing = 0
  let pending = 1
  let failureAckCalls = 0
  let releaseFormal
  const formalGate = new Promise((resolve) => { releaseFormal = resolve })
  const app = createApp({
    autoConnect: false, outboxWorkDeadlineMs: 30, outboxBackoffMs: 1,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        if (claimed) return []
        claimed = true
        pending -= 1
        processing += 1
        return [claimedRow(1, { payload: { work: envelope().snapshot } })]
      },
      async failCaptureOutbox() {
        failureAckCalls += 1
        await new Promise(() => {})
      },
      async getCaptureOutboxHealth() {
        return { pending, processing, error: 0, dead_letter: 0, next_wakeup_at: null }
      },
    },
    v100FormalRuntime: { enabled: true, async processSnapshot() { await formalGate } },
  })
  setTimeout(() => { pending += 2 }, 10).unref?.()

  const startedAt = Date.now()
  const draining = app.drainCaptureOutbox()
  await delay(40)
  assert.equal(failureAckCalls, 0, 'failure ACK must stay fenced while Formal remains active')
  const statusResponse = await app.inject({ method: 'GET', url: '/api/status' })
  assert.equal(JSON.parse(statusResponse.body).captureOutboxPhase.phase, 'formal_settling')
  releaseFormal()
  await draining.catch(() => {})
  const elapsedMs = Date.now() - startedAt

  assert.equal(processing, 1, 'unacknowledged exact lease must remain processing for DB stale-lease reclaim')
  assert.equal(pending, 2, 'new durable Final rows remain queued behind the processing FIFO head')
  assert.equal(failureAckCalls, 1, 'an uncancellable exact failure ACK must never overlap with retries')
  assert.ok(elapsedMs < 150, `scaled drain reproduced the 30 + 3x30 second stall: ${elapsedMs}ms`)
  await app.stop()
})

test('status exposes only bounded outbox phase diagnostics while formal work is blocked', async () => {
  let claimed = false
  let releaseFormal
  const formalGate = new Promise((resolve) => { releaseFormal = resolve })
  const app = createApp({
    autoConnect: false, outboxWorkDeadlineMs: 20,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        if (claimed) return []
        claimed = true
        return [claimedRow(1, { payload: { work: envelope().snapshot } })]
      },
      async completeCaptureOutbox() {},
      async failCaptureOutbox() {},
    },
    v100FormalRuntime: { enabled: true, async processSnapshot() { await formalGate } },
  })
  const drain = app.drainCaptureOutbox()
  await delay(30)

  const response = await app.inject({ method: 'GET', url: '/api/status' })
  const status = JSON.parse(response.body)
  assert.equal(status.captureOutboxPhase.phase, 'formal_settling')
  assert.equal(status.captureOutboxPhase.attempt, 1)
  assert.deepEqual(Object.keys(status.captureOutboxPhase).sort(), ['attempt', 'phase', 'startedAt'])

  releaseFormal()
  await drain.catch(() => {})
  await app.stop()
})

test('shutdown stops new wakeups and waits for in-flight work', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let completed = 0
  let claimed = false
  const app = createApp({
    autoConnect: false, outboxWorkDeadlineMs: 1000, outboxBackoffMs: 1,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        if (claimed) return []
        claimed = true
        return [claimedRow(1, { payload: { work: envelope().snapshot } })]
      },
      async completeCaptureOutbox() { completed += 1; return { completed: true } },
      async failCaptureOutbox() { assert.fail('released work must not fail') },
      async readIssuedPrediction() { return null },
    },
    v100FormalRuntime: { enabled: true, async processSnapshot() { await gate } },
  })
  const drain = app.drainCaptureOutbox()
  const stopping = app.stop()
  const early = await Promise.race([stopping.then(() => true), delay(10).then(() => false)])
  assert.equal(early, false, 'shutdown returned before in-flight work settled')
  release()
  await Promise.all([drain, stopping])
  assert.equal(completed, 1)
})

test('outbox consumer preserves raw source fence and canonicalizes formal round source after shadow retirement', async () => {
  const fence = { mode: 'api', ownerId: 'owner-a', epoch: 2, fence: 'fence-a' }
  const work = structuredClone(envelope().snapshot)
  work.rounds[0].source = structuredClone(fence)
  const rawBefore = structuredClone(work)
  let claimed = false
  let formalRounds = null
  const app = createApp({
    autoConnect: false,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        if (claimed) return []
        claimed = true
        return [claimedRow(7, { payload: { work } })]
      },
      async completeCaptureOutbox() { return { completed: true } },
      async failCaptureOutbox() { assert.fail('canonical source work must not fail') },
      async readIssuedPrediction() { return null },
    },
    v100FormalRuntime: {
      enabled: true,
      async processSnapshot({ tables, rounds }) {
        formalRounds = structuredClone(rounds)
        return { tables }
      },
    },
  })

  const result = await app.drainCaptureOutbox()

  assert.deepEqual(result, { processed: 1, failed: 0 })
  assert.equal(formalRounds[0].source, 'ofalive99')
  assert.deepEqual(work, rawBefore, 'durable raw fence evidence must stay immutable')
})
