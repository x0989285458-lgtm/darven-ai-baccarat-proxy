import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createApp } from '../src/server.js'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
        return null
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
        return null
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

test('external consumer retains the exact outbox lease when a finalized identity is missing from published tables', async () => {
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
      async issuePrediction() { issued += 1; return null },
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

  assert.equal(issued, 0)
  assert.equal(completed, 0)
  assert.equal(failed, 1)
  assert.match(app.state.snapshot().status.persistenceError, /finalized identity missing from published tables/)
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
    outboxCoalesceMs: 100,
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
    delay(50).then(() => false),
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
  for (const value of ['', Number.NaN, 0, 1.5, 11]) {
    assert.throws(
      () => createApp({ autoConnect: false, captureOutboxBatchLimit: value }),
      /outbox batch limit.*integer.*1.*10/i,
    )
  }
  const app = createApp({ autoConnect: false, captureOutboxBatchLimit: 3 })
  await app.stop()
})

test('same-session outbox batch merges ordered envelopes and completes every exact lease atomically', async () => {
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
  const rows = [
    claimedRow(21, { payload: { work: makeWork('BAG01', 21) } }),
    claimedRow(22, { payload: { work: makeWork('BAG02', 22) } }),
    claimedRow(23, { payload: { work: makeWork('BAG01', 23) } }),
  ]
  const app = createApp({
    autoConnect: false,
    captureOutboxBatchLimit: 3,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox({ limit }) {
        assert.equal(limit, 3)
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
  assert.deepEqual(formalInputs[0].rounds.map((round) => `${round.tableId}:${round.round}`), ['BAG01:21', 'BAG02:22', 'BAG01:23'])
  assert.deepEqual(completedBatches, [[
    { sessionId: 'outbox-worker', sequence: 21, claimToken: 'lease-21', attempt: 1 },
    { sessionId: 'outbox-worker', sequence: 22, claimToken: 'lease-22', attempt: 1 },
    { sessionId: 'outbox-worker', sequence: 23, claimToken: 'lease-23', attempt: 1 },
  ]])
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
  await delay(95)
  await app.stop()
  assert.ok(claimTimes.length >= 3)
  assert.ok(claimTimes.length <= 5, `fixed-rate polling detected: ${claimTimes.length} claims`)
  const gaps = claimTimes.slice(1).map((time, index) => time - claimTimes[index])
  assert.ok(gaps[1] >= 15, `second retry did not back off: ${gaps.join(',')}`)
  assert.ok(gaps[2] == null || gaps[2] >= 30, `third retry did not back off: ${gaps.join(',')}`)
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
    autoConnect: false, outboxWorkDeadlineMs: 50, outboxBackoffMs: 1,
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
        if (call === 1) await delay(150)
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
