import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
    await delay(0)
    assert.equal(order.includes('formal-start'), true)
    assert.equal(order.includes('formal-finish'), false)
  } finally {
    releaseSettlement()
    await request
  }
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

test('bounded outbox passes automatically continue beyond 100 rows', async () => {
  const rows = Array.from({ length: 101 }, (_, index) => claimedRow(index + 1))
  let completed = 0
  const app = createApp({
    autoConnect: false,
    outboxBackoffMs: 1,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox({ limit }) { return rows.splice(0, limit) },
      async completeCaptureOutbox() { completed += 1; return { completed: true } },
      async failCaptureOutbox() { assert.fail('valid rows must not fail') },
    },
    v100FormalRuntime: { enabled: false },
  })
  await app.drainCaptureOutbox()
  await app.waitForCaptureOutboxIdle()
  assert.equal(completed, 101)
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
  await delay(260)
  await app.stop()
  assert.ok(healthReads >= 4, `health backoff did not reset after recovery: ${healthReads} reads`)
})

test('temporary claim and work failures auto-retry while poison work is isolated', async () => {
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
        if (failCalls === 1) throw new Error('temporary fail RPC outage')
        return { failed: true, isolated: true, ...identity }
      },
    },
    v100FormalRuntime: { enabled: false },
  })
  await app.drainCaptureOutbox().catch(() => {})
  await app.waitForCaptureOutboxIdle()
  assert.ok(claimCalls >= 3)
  assert.ok(failCalls >= 2)
  assert.deepEqual(completed, [2], 'poison row must not block the next sequence after isolation')
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
    delay(80).then(() => false),
  ])
  assert.equal(settled, true)
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
