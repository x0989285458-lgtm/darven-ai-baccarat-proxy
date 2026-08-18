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

test('shadow work must settle before a timed-out lease is failed for retry', async () => {
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
  const failedAcks = []
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
        failedAcks.push(`${identity.sessionId}\u0000${identity.sequence}\u0000${identity.claimToken}\u0000${identity.attempt}`)
        throw new Error(`temporary fail RPC outage for ${identity.claimToken}`)
      },
    },
    v100FormalRuntime: { enabled: false },
  })
  await app.drainCaptureOutbox().catch(() => {})
  const retryDeadline = Date.now() + 1_000
  while (!completed.includes(2) && Date.now() < retryDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  await app.waitForCaptureOutboxIdle()
  assert.ok(claimCalls >= 3)
  assert.equal(new Set(failedAcks).size, failedAcks.length, 'the same exact failure ACK lease was attempted more than once')
  assert.equal(failedAcks.filter((key) => key.includes('\u00001\u0000lease-1\u00001')).length, 1)
  assert.deepEqual(completed, [2], 'a failure ACK outage must not drop the next claimable Final')
})

test('failure ACK outage does not hold another claimable Final behind retry backoff', async () => {
  let claimCalls = 0
  const completed = []
  const app = createApp({
    autoConnect: false, outboxBackoffMs: 5000, outboxWorkDeadlineMs: 25,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        claimCalls += 1
        if (claimCalls === 1) return [claimedRow(1, { payload: {} })]
        if (claimCalls === 2) return [claimedRow(2)]
        return []
      },
      async completeCaptureOutbox({ sequence }) { completed.push(sequence); return { completed: true } },
      async failCaptureOutbox() { throw new Error('failure ACK unavailable') },
    },
    v100FormalRuntime: { enabled: false },
  })
  await app.drainCaptureOutbox()
  const deadline = Date.now() + 250
  while (!completed.includes(2) && Date.now() < deadline) await delay(5)
  await app.stop()
  assert.deepEqual(completed, [2])
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
    autoConnect: false, outboxWorkDeadlineMs: 10, outboxBackoffMs: 1,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() {
        claimCalls += 1
        if (claimCalls > 2) return []
        return [claimedRow(1, { attempts: claimCalls, claim_token: `lease-attempt-${claimCalls}` })]
      },
      async completeCaptureOutbox({ attempt }) { completed.push(attempt); return { completed: true } },
      async failCaptureOutbox() {
        failureAckWhileFormalActive = activeFormal > 0
        return { failed: true, retry_after_ms: 0 }
      },
    },
    v100FormalRuntime: {
      enabled: true,
      async processSnapshot({ tables }) {
        formalCalls += 1
        const call = formalCalls
        activeFormal += 1
        maxActiveFormal = Math.max(maxActiveFormal, activeFormal)
        if (call === 1) await delay(40)
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
  // The structural single-call assertion above detects the former 3x deadline retry.
  // Keep only a generous deadlock bound here so scheduler load cannot turn wall-clock jitter into a product failure.
  assert.ok(elapsedMs < 500, `scaled drain exceeded the bounded deadlock budget: ${elapsedMs}ms`)
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

test('outbox consumer preserves raw source fence but canonicalizes formal round source', async () => {
  const fence = { mode: 'api', ownerId: 'owner-a', epoch: 2, fence: 'fence-a' }
  const work = structuredClone(envelope().snapshot)
  work.rounds[0].source = structuredClone(fence)
  const rawBefore = structuredClone(work)
  let claimed = false
  let formalRounds = null
  let shadowRounds = null
  const shadowProcessClient = {
    runtime(_key, { enabled }) {
      return {
        enabled,
        async observeTable() {},
        async settleRound() {},
        snapshot() { return { status: 'ready' } },
      }
    },
    async processCapture(payload) { shadowRounds = structuredClone(payload.rounds) },
    async processCaptureWithoutV10(payload) { shadowRounds = structuredClone(payload.rounds) },
    status() { return { running: true, generation: 1, pending: 0, stopping: false } },
    beginStop() {},
    async stop() {},
  }
  const app = createApp({
    autoConnect: false,
    isolateShadowProcess: true,
    shadowProcessClient,
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
  assert.equal(shadowRounds[0].source, 'ofalive99')
  assert.deepEqual(work, rawBefore, 'durable raw fence evidence must stay immutable')
})
