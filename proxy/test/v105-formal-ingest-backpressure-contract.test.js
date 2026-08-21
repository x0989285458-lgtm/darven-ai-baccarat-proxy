import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createV100FormalRuntime } from '../src/v100-formal-runtime.js'
import { applyCloudCapturePayload } from '../src/cloud-capture.js'
import { buildLivePrediction, createSupabaseIngestionClient } from '../src/supabase-writer.js'
import { createApp, createServiceWorkScheduler } from '../src/server.js'

const lifecycleIndexMigrationUrl = new URL('../../supabase/migrations/20260729011133_v105_lifecycle_pending_index.sql', import.meta.url)
const lifecycleIndexRollbackUrl = new URL('../../supabase/operations/rollback_v105_lifecycle_pending_index.sql', import.meta.url)

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const finalRound = (tableId, round) => ({
  source: 'ofalive99', tableId, shoe: 'S1', round,
  sourceAction: '/api/v1/gametype/3/game/1/room/1/table/1/summary',
  rawResult: [1, 14, 2, 15, -1, -1, -1, -1, 3, 5],
})

function durableFor(event) {
  return {
    identity: { source: event.source, table_id: event.tableId, shoe: event.shoe },
    status: 'contiguous', rankDataAvailable: true,
    completeThroughRound: event.round, complete_through_round: event.round,
    targetRound: event.round + 1, remainingRankCounts: {},
  }
}

test('v105 lifecycle pending index is concurrent, exact, partial, and independently reversible', () => {
  const migration = readFileSync(lifecycleIndexMigrationUrl, 'utf8')
  const rollback = readFileSync(lifecycleIndexRollbackUrl, 'utf8')
  assert.match(migration, /create index concurrently if not exists daily_prediction_results_v105_pending_lifecycle_idx/i)
  assert.match(migration, /on public\.daily_prediction_results\s*\(source,\s*table_id,\s*strategy_version,\s*shoe_no,\s*round_no\)/i)
  assert.match(migration, /where prediction_issued_at is not null\s+and settlement_final is not true/i)
  assert.doesNotMatch(migration, /\bbegin\s*;/i)
  assert.doesNotMatch(migration, /\bcommit\s*;/i)
  assert.match(rollback, /drop index concurrently if exists public\.daily_prediction_results_v105_pending_lifecycle_idx/i)
})

test('formal rank ledger preserves per-identity order while serializing independent tables for service responsiveness', async () => {
  const activeByTable = new Map()
  const appliedByTable = new Map()
  let active = 0
  let maxActive = 0
  let maxPerTable = 0
  const writer = {
    configured: true,
    async readV100RankLedger() { return null },
    async applyV100RankLedgerEvent(event) {
      active += 1
      activeByTable.set(event.tableId, (activeByTable.get(event.tableId) ?? 0) + 1)
      maxActive = Math.max(maxActive, active)
      maxPerTable = Math.max(maxPerTable, activeByTable.get(event.tableId))
      ;(appliedByTable.get(event.tableId) ?? appliedByTable.set(event.tableId, []).get(event.tableId)).push(event.round)
      await delay(15)
      active -= 1
      activeByTable.set(event.tableId, activeByTable.get(event.tableId) - 1)
      return durableFor(event)
    },
  }
  const runtime = createV100FormalRuntime({ enabled: true, writer, source: 'ofalive99' })
  await runtime.processSnapshot({
    tables: [],
    rounds: [finalRound('BAG01', 2), finalRound('BAG02', 2), finalRound('BAG01', 1), finalRound('BAG02', 1)],
  })
  assert.deepEqual(appliedByTable.get('BAG01'), [1, 2])
  assert.deepEqual(appliedByTable.get('BAG02'), [1, 2])
  assert.equal(maxPerTable, 1)
  assert.equal(maxActive, 1)
})

test('formal identity fan-out is serialized to one durable operation', async () => {
  let active = 0
  let maxActive = 0
  const writer = {
    configured: true,
    async readV100RankLedger() { return null },
    async applyV100RankLedgerEvent(event) {
      active += 1
      maxActive = Math.max(maxActive, active)
      await delay(15)
      active -= 1
      return durableFor(event)
    },
  }
  const runtime = createV100FormalRuntime({ enabled: true, writer, source: 'ofalive99' })
  const rounds = Array.from({ length: 12 }, (_, index) => finalRound(`BAG${String(index + 1).padStart(2, '0')}`, 1))

  await runtime.processSnapshot({ tables: [], rounds })

  assert.equal(maxActive, 1)
})

test('formal settlement preserves per-table order while serializing independent tables for service responsiveness', async () => {
  const activeByTable = new Map()
  const settledByTable = new Map()
  let active = 0
  let maxActive = 0
  let maxPerTable = 0
  const state = {
    setStatus() {}, setTables() {},
    async upsertRoundEvent(event) {
      active += 1
      activeByTable.set(event.tableId, (activeByTable.get(event.tableId) ?? 0) + 1)
      maxActive = Math.max(maxActive, active)
      maxPerTable = Math.max(maxPerTable, activeByTable.get(event.tableId))
      ;(settledByTable.get(event.tableId) ?? settledByTable.set(event.tableId, []).get(event.tableId)).push(event.round)
      await delay(15)
      active -= 1
      activeByTable.set(event.tableId, activeByTable.get(event.tableId) - 1)
      return { ok: true }
    },
  }
  await applyCloudCapturePayload({
    parsed: {
      sessionId: 'formal12', status: { connected: true }, tables: [],
      rounds: [finalRound('BAG01', 2), finalRound('BAG02', 2), finalRound('BAG01', 1), finalRound('BAG02', 1)],
    },
    state,
    writer: { configured: false },
  })
  assert.deepEqual(settledByTable.get('BAG01'), [1, 2])
  assert.deepEqual(settledByTable.get('BAG02'), [1, 2])
  assert.equal(maxPerTable, 1)
  assert.equal(maxActive, 1)
})

test('service work scheduler serializes work and coalesces a pending table to its latest state', async () => {
  const scheduler = createServiceWorkScheduler()
  const order = []
  let active = 0
  let maxActive = 0
  let releaseFirst
  const firstGate = new Promise((resolve) => { releaseFirst = resolve })
  const run = (name, gate = null) => async () => {
    active += 1
    maxActive = Math.max(maxActive, active)
    order.push(name)
    if (gate) await gate
    active -= 1
    return name
  }

  const first = scheduler.enqueueLatest('BAG01', run('BAG01:first', firstGate))
  const stale = scheduler.enqueueLatest('BAG02', run('BAG02:stale'))
  const latest = scheduler.enqueueLatest('BAG02', run('BAG02:latest'))
  releaseFirst()
  await Promise.all([first, stale, latest, scheduler.waitForIdle()])

  assert.equal(maxActive, 1)
  assert.deepEqual(order, ['BAG01:first', 'BAG02:latest'])
})

test('service work scheduler runs formal settlement before pending table observations', async () => {
  const scheduler = createServiceWorkScheduler()
  const order = []
  let releaseFirst
  const firstGate = new Promise((resolve) => { releaseFirst = resolve })
  const first = scheduler.enqueueLatest('BAG01', async () => {
    order.push('observe:first')
    await firstGate
  })
  await delay(0)
  const pendingObservation = scheduler.enqueueLatest('BAG02', async () => { order.push('observe:second') })
  const formalSettlement = scheduler.enqueuePriority(async () => { order.push('settlement') })
  releaseFirst()
  await Promise.all([first, pendingObservation, formalSettlement, scheduler.waitForIdle()])

  assert.deepEqual(order, ['observe:first', 'settlement', 'observe:second'])
})

test('service work scheduler lets latest table work run after four priority settlements', async () => {
  const scheduler = createServiceWorkScheduler()
  const order = []
  let releaseFirst
  const firstGate = new Promise((resolve) => { releaseFirst = resolve })
  const first = scheduler.enqueueLatest('BAG01', async () => {
    order.push('observe:first')
    await firstGate
  })
  await delay(0)
  const observation = scheduler.enqueueLatest('BAG02', async () => { order.push('observe:latest') })
  const settlements = Array.from({ length: 6 }, (_, index) => scheduler.enqueuePriority(async () => { order.push(`settlement:${index + 1}`) }))
  releaseFirst()
  await Promise.all([first, observation, ...settlements, scheduler.waitForIdle()])

  assert.deepEqual(order, [
    'observe:first',
    'settlement:1', 'settlement:2', 'settlement:3', 'settlement:4',
    'observe:latest',
    'settlement:5', 'settlement:6',
  ])
})

test('closing the service scheduler rejects new work and drains work already accepted', async () => {
  const scheduler = createServiceWorkScheduler()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const accepted = scheduler.enqueueLatest('BAG01', async () => gate)
  await delay(0)
  const closing = scheduler.closeAndWait()

  await assert.rejects(scheduler.enqueueLatest('BAG02', async () => {}), /closing/i)
  await assert.rejects(scheduler.enqueuePriority(async () => {}), /closing/i)
  release()
  await Promise.all([accepted, closing])
})

test('table updates coalesce to the latest snapshot and run all shadow observations through one service slot', async () => {
  let active = 0
  let maxActive = 0
  let calls = 0
  const runtime = () => ({
    enabled: true,
    async observeTable() {
      calls += 1
      active += 1
      maxActive = Math.max(maxActive, active)
      await delay(5)
      active -= 1
    },
  })
  const app = createApp({
    autoConnect: false,
    production: false,
    memberAuthRequired: false,
    requireVerifiedStrategy: false,
    supabaseClient: { configured: false },
    v100FormalRuntime: { enabled: false },
    v103ShadowRuntime: runtime(),
    v105ShadowV9Runtime: runtime(),
  })
  const tables = Array.from({ length: 10 }, (_, index) => ({
    tableId: `BAG${String(index + 1).padStart(2, '0')}`,
    shoe: 'S1', round: 1, bankerCount: 1, playerCount: 1, tieCount: 0,
  }))

  app.state.setTables(tables)
  app.state.setTables(tables.map((table) => ({ ...table, round: 2 })))
  await app.waitForServiceWorkIdle()

  assert.equal(maxActive, 1)
  assert.equal(calls, 20)
  await app.stop()
})

test('one table observer failure does not skip later shadow observers', async () => {
  const observed = []
  const app = createApp({
    autoConnect: false,
    production: false,
    memberAuthRequired: false,
    requireVerifiedStrategy: false,
    supabaseClient: { configured: false },
    v100FormalRuntime: { enabled: false },
    v103ShadowRuntime: { enabled: true, async observeTable() { throw new Error('expected early observer failure') } },
    v105ShadowV9Runtime: { enabled: true, async observeTable() { observed.push('v9') } },
  })

  app.state.setTables([{ tableId: 'BAG01', shoe: 'S1', round: 1, bankerCount: 1, playerCount: 1 }])
  await app.waitForServiceWorkIdle()

  assert.deepEqual(observed, ['v9'])
  await app.stop()
})

test('a stale issuance acknowledgement reconciles the latest screen before it can remain pending', async () => {
  let releaseOldIssue
  let signalOldIssueStarted
  const oldIssueStarted = new Promise((resolve) => { signalOldIssueStarted = resolve })
  const oldIssueGate = new Promise((resolve) => { releaseOldIssue = resolve })
  const reconciled = []
  const issued = []
  const writer = {
    configured: true,
    getRuntimeStatus() { return { ready: true, degraded: false, activeStrategyVersion: 'v105' } },
    async reconcilePredictionLifecycle(identity) {
      reconciled.push(`${identity.currentShoe}:${identity.currentVisibleRound}`)
    },
    async issuePrediction(candidate) {
      issued.push(`${candidate.targetShoe}:${candidate.targetRound}`)
      if (String(candidate.targetShoe) === '88') {
        signalOldIssueStarted()
        await oldIssueGate
      }
      return { ...candidate, predictionId: `pid-${candidate.targetShoe}-${candidate.targetRound}`, issuedAt: '2026-07-29T20:00:00.000Z' }
    },
    async readIssuedPrediction() { return null },
  }
  const formalRuntime = {
    async buildPrediction(input) { return buildLivePrediction(input) },
    recordIssuance() {},
    snapshot() { return { strategyVersion: 'v105', status: 'ready' } },
  }
  const app = createApp({
    autoConnect: false,
    production: false,
    memberAuthRequired: false,
    requireVerifiedStrategy: false,
    supabaseClient: writer,
    v104FormalRuntime: formalRuntime,
  })

  app.state.setTables([{ tableId: 'BAG01', shoe: 88, round: 20, sourceUpdatedAt: '2026-07-29T20:00:00.000Z' }])
  await oldIssueStarted
  app.state.setTables([{ tableId: 'BAG01', shoe: 89, round: 2, sourceUpdatedAt: '2026-07-29T20:00:01.000Z' }])
  releaseOldIssue()
  await app.waitForServiceWorkIdle()

  assert.deepEqual(issued, ['88:21', '89:3'])
  assert.deepEqual(reconciled, ['88:20', '89:2', '89:2'])
  await app.stop()
})

test('round shadow settlements use the priority service slot without detached fan-out', async () => {
  let active = 0
  let maxActive = 0
  let calls = 0
  const runtime = () => ({
    enabled: true,
    async settleRound() {
      calls += 1
      active += 1
      maxActive = Math.max(maxActive, active)
      await delay(5)
      active -= 1
    },
  })
  const app = createApp({
    autoConnect: false,
    production: false,
    memberAuthRequired: false,
    requireVerifiedStrategy: false,
    supabaseClient: { configured: true, async readIssuedPrediction() { return null } },
    v100FormalRuntime: { enabled: false },
    v103ShadowRuntime: runtime(),
    v105ShadowV9Runtime: runtime(),
  })

  await applyCloudCapturePayload({
    parsed: {
      sessionId: 'priority-shadow', status: { connected: true }, tables: [],
      rounds: [
        { ...finalRound('BAG01', 1), sourceAction: '/api/v1/gametype/*/game/*/room/*/table/*/summary', rawResult: [1, 14, 2, 15, 3, 16, -1, -1, 6, 6] },
        { ...finalRound('BAG02', 1), sourceAction: '/api/v1/gametype/*/game/*/room/*/table/*/summary', rawResult: [4, 17, 5, 18, 6, 19, -1, -1, 5, 5] },
      ],
    },
    state: app.state,
    writer: { configured: false },
  })
  await app.waitForServiceWorkIdle()

  assert.equal(calls, 4)
  assert.equal(maxActive, 1)
  await app.stop()
})

test('a hung shadow settlement times out and cannot block later shadows or formal work', async () => {
  let laterShadowSettlements = 0
  let timedOutShadowSettled = false
  const app = createApp({
    autoConnect: false,
    production: false,
    memberAuthRequired: false,
    requireVerifiedStrategy: false,
    shadowServiceWorkTimeoutMs: 20,
    supabaseClient: { configured: true, async readIssuedPrediction() { return null } },
    v100FormalRuntime: { enabled: false },
    v103ShadowRuntime: {
      enabled: true,
      async settleRound(_round, { signal } = {}) {
        await new Promise((_, reject) => {
          const finish = () => setTimeout(() => {
            timedOutShadowSettled = true
            reject(new Error('aborted shadow settled'))
          }, 40)
          if (signal?.aborted) finish()
          else signal?.addEventListener('abort', finish, { once: true })
        })
      },
    },
    v105ShadowV9Runtime: { enabled: true, async settleRound() { laterShadowSettlements += 1 } },
  })
  const round = {
    ...finalRound('BAG01', 1),
    sourceAction: '/api/v1/gametype/*/game/*/room/*/table/*/summary',
    rawResult: [1, 14, 2, 15, 3, 16, -1, -1, 6, 6],
  }

  const outcome = await Promise.race([
    app.state.upsertRoundEvent(round).then(() => 'completed'),
    delay(150).then(() => 'timed_out'),
  ])

  assert.equal(outcome, 'completed')
  assert.equal(timedOutShadowSettled, false)
  await app.waitForServiceWorkIdle()
  assert.equal(laterShadowSettlements, 1)
  assert.equal(timedOutShadowSettled, true)
  await app.stop()
})

test('a Final queued behind a timed-out observation on the same shadow runtime is not dropped', async () => {
  let observationSettled = false
  let finalSettlements = 0
  const runtime = {
    enabled: true,
    async observeTable(_table, { signal } = {}) {
      await new Promise((_, reject) => {
        const finish = () => setTimeout(() => {
          observationSettled = true
          reject(new Error('observation aborted'))
        }, 30)
        if (signal?.aborted) finish()
        else signal?.addEventListener('abort', finish, { once: true })
      })
    },
    async settleRound() { finalSettlements += 1 },
  }
  const app = createApp({
    autoConnect: false,
    production: false,
    memberAuthRequired: false,
    requireVerifiedStrategy: false,
    shadowServiceWorkTimeoutMs: 10,
    supabaseClient: { configured: true, async readIssuedPrediction() { return null } },
    v100FormalRuntime: { enabled: false },
    v105ShadowV9Runtime: runtime,
  })
  app.state.setTables([{ tableId: 'BAG01', shoe: 'S1', round: 1, bankerCount: 1, playerCount: 1 }])
  await delay(15)
  await app.state.upsertRoundEvent({
    ...finalRound('BAG01', 2),
    sourceAction: '/api/v1/gametype/*/game/*/room/*/table/*/summary',
    rawResult: [1, 14, 2, 15, 3, 16, -1, -1, 6, 6],
  })
  await app.waitForServiceWorkIdle()

  assert.equal(observationSettled, true)
  assert.equal(finalSettlements, 1)
  await app.stop()
})

test('shutdown waits for queued service work before returning', async () => {
  let releaseObservation
  const observationGate = new Promise((resolve) => { releaseObservation = resolve })
  let observationStarted = false
  const app = createApp({
    autoConnect: false,
    production: false,
    memberAuthRequired: false,
    requireVerifiedStrategy: false,
    supabaseClient: { configured: false },
    v100FormalRuntime: { enabled: false },
    v105ShadowV9Runtime: {
      enabled: true,
      async observeTable() {
        observationStarted = true
        await observationGate
      },
    },
  })
  app.state.setTables([{ tableId: 'BAG01', shoe: 'S1', round: 1, bankerCount: 1, playerCount: 1 }])
  await delay(0)
  assert.equal(observationStarted, true)

  let stopped = false
  const stopping = app.stop().then(() => { stopped = true })
  await delay(10)
  assert.equal(stopped, false)
  releaseObservation()
  await stopping
  assert.equal(stopped, true)
})

test('shutdown is bounded and observable when a shadow ignores AbortSignal forever', async () => {
  const app = createApp({
    autoConnect: false,
    production: false,
    memberAuthRequired: false,
    requireVerifiedStrategy: false,
    shadowServiceWorkTimeoutMs: 5,
    shadowShutdownDeadlineMs: 20,
    supabaseClient: { configured: false },
    v100FormalRuntime: { enabled: false },
    v105ShadowV9Runtime: {
      enabled: true,
      async observeTable() { await new Promise(() => {}) },
    },
  })
  app.state.setTables([{ tableId: 'BAG01', shoe: 'S1', round: 1, bankerCount: 1, playerCount: 1 }])
  await delay(10)

  const result = await Promise.race([
    app.stop().then(() => 'stopped'),
    delay(100).then(() => 'hung'),
  ])
  assert.equal(result, 'stopped')
  const status = JSON.parse((await app.inject({ url: '/api/status' })).body)
  assert.equal(status.shadowShutdownStatus, 'timed_out')
})

test('worker gives a bounded large FIFO head enough time to receive an exact durable ACK', () => {
  const workerServer = readFileSync(new URL('../../cloud-browser-worker/src/server.js', import.meta.url), 'utf8')
  assert.match(workerServer, /requestTimeoutMs:\s*Number\(process\.env\.PUSH_REQUEST_TIMEOUT_MS\s*\?\?\s*120000\)/)
})


test('overlapping formal runtime calls serialize the same identity without ledger regression', async () => {
  let active = 0
  let maxActive = 0
  const completed = []
  const writer = {
    configured: true,
    async readV100RankLedger() { return null },
    async applyV100RankLedgerEvent(event) {
      active += 1
      maxActive = Math.max(maxActive, active)
      await delay(event.round === 1 ? 30 : 5)
      completed.push(event.round)
      active -= 1
      return durableFor(event)
    },
  }
  const runtime = createV100FormalRuntime({ enabled: true, writer, source: 'ofalive99' })
  await Promise.all([
    runtime.processSnapshot({ tables: [], rounds: [finalRound('BAG01', 1)] }),
    runtime.processSnapshot({ tables: [], rounds: [finalRound('BAG01', 2)] }),
  ])
  assert.equal(maxActive, 1)
  assert.deepEqual(completed, [1, 2])
})

test('overlapping capture payloads serialize the same table across a shoe transition', async () => {
  let active = 0
  let maxActive = 0
  const order = []
  const state = {
    setStatus() {}, setTables() {},
    async upsertRoundEvent(event) {
      active += 1
      maxActive = Math.max(maxActive, active)
      order.push(`${event.shoe}:start`)
      await delay(event.shoe === 'OLD' ? 30 : 5)
      order.push(`${event.shoe}:end`)
      active -= 1
      return { ok: true }
    },
  }
  const payload = (shoe, round) => ({ sessionId: 'formal12', status: { connected: true }, tables: [], rounds: [{ ...finalRound('BAG01', round), shoe }] })
  await Promise.all([
    applyCloudCapturePayload({ parsed: payload('OLD', 99), state, writer: { configured: false } }),
    applyCloudCapturePayload({ parsed: payload('NEW', 1), state, writer: { configured: false } }),
  ])
  assert.equal(maxActive, 1)
  assert.deepEqual(order, ['OLD:start', 'OLD:end', 'NEW:start', 'NEW:end'])
})


test('failed formal fan-out drains every identity before the next snapshot starts', async () => {
  let bag02Active = 0
  let bag02Max = 0
  const order = []
  let bag02Ledger = 0
  const writer = {
    configured: true,
    async readV100RankLedger() { return null },
    async applyV100RankLedgerEvent(event) {
      if (event.tableId === 'BAG01') {
        await delay(5)
        throw new Error('BAG01 durable failure')
      }
      bag02Active += 1
      bag02Max = Math.max(bag02Max, bag02Active)
      order.push(`start:${event.round}`)
      await delay(event.round === 1 ? 40 : 5)
      bag02Ledger = event.round
      order.push(`end:${event.round}`)
      bag02Active -= 1
      return durableFor(event)
    },
  }
  const runtime = createV100FormalRuntime({ enabled: true, writer, source: 'ofalive99' })
  const first = runtime.processSnapshot({ tables: [], rounds: [finalRound('BAG01', 1), finalRound('BAG02', 1)] })
  const second = first.catch(() => runtime.processSnapshot({ tables: [], rounds: [finalRound('BAG02', 2)] }))
  await assert.rejects(first, /BAG01 durable failure/)
  await second
  assert.equal(bag02Max, 1)
  assert.deepEqual(order, ['start:1', 'end:1', 'start:2', 'end:2'])
  assert.equal(bag02Ledger, 2)
})


test('overlapping snapshot calls share the same single-identity concurrency budget', async () => {
  let active = 0
  let maxActive = 0
  const writer = {
    configured: true,
    async readV100RankLedger() { return null },
    async applyV100RankLedgerEvent(event) {
      active += 1
      maxActive = Math.max(maxActive, active)
      await delay(30)
      active -= 1
      return durableFor(event)
    },
  }
  const runtime = createV100FormalRuntime({ enabled: true, writer, source: 'ofalive99' })
  await Promise.all(Array.from({ length: 8 }, (_, index) => runtime.processSnapshot({
    tables: [],
    rounds: [finalRound(`BAG${String(index + 1).padStart(2, '0')}`, 1)],
  })))
  assert.equal(maxActive, 1)
})

test('overlapping snapshots serialize independent identities for service responsiveness', async () => {
  let active = 0
  let maxActive = 0
  const writer = {
    configured: true,
    async readV100RankLedger() { return null },
    async applyV100RankLedgerEvent(event) {
      active += 1
      maxActive = Math.max(maxActive, active)
      await delay(40)
      active -= 1
      return durableFor(event)
    },
  }
  const runtime = createV100FormalRuntime({ enabled: true, writer, source: 'ofalive99' })
  await Promise.all([
    runtime.processSnapshot({ tables: [], rounds: [finalRound('BAG01', 1)] }),
    runtime.processSnapshot({ tables: [], rounds: [finalRound('BAG02', 1)] }),
  ])
  assert.equal(maxActive, 1)
})

test('formal Final settlement keeps a reserved checkout when concurrent ingest envelopes persist ancillary data', async () => {
  let active = 0
  let ancillaryStarted = 0
  let releaseAncillary
  const ancillaryGate = new Promise((resolve) => { releaseAncillary = resolve })
  const waiters = []
  const wakeWaiters = () => {
    while (active < 8 && waiters.length > 0) waiters.shift()()
  }
  const acquire = () => new Promise((resolve, reject) => {
    if (active < 8) {
      active += 1
      resolve()
      return
    }
    const start = () => {
      clearTimeout(timeout)
      active += 1
      resolve()
    }
    const timeout = setTimeout(() => {
      const index = waiters.indexOf(start)
      if (index >= 0) waiters.splice(index, 1)
      reject(new Error('timeout exceeded when trying to connect'))
    }, 25)
    waiters.push(start)
  })
  const release = () => {
    active -= 1
    wakeWaiters()
  }
  const baseTable = { tableId: 'BAG10', shoe: 'S1', round: 20 }
  const issued = {
    ...buildLivePrediction(baseTable),
    predictionId: '11111111-1111-1111-1111-111111111111',
    issuedAt: '2026-07-27T00:00:00.000Z',
  }
  const strategyPool = {
    async query(query) {
      await acquire()
      const text = String(query?.text ?? query)
      try {
        if (/cloud_capture_status|persist_latest_cloud_table_snapshot/i.test(text)) {
          ancillaryStarted += 1
          await ancillaryGate
          if (/persist_latest_cloud_table_snapshot/i.test(text)) {
            return { rows: [{ persist_latest_cloud_table_snapshot: { persisted: true } }] }
          }
          return { rows: [] }
        }
        if (/from public\.daily_prediction_results/i.test(text)) {
          return { rows: [{
            id: issued.predictionId, source: 'ofalive99', table_id: 'BAG10', shoe_no: 'S1', round_no: 21,
            strategy_version: 'v105', prediction_issued_at: issued.issuedAt,
            issued_prediction_payload: issued, settlement_final: false,
          }] }
        }
        if (/settle_v105_prediction/i.test(text)) {
          releaseAncillary()
          return { rows: [{ settle_v105_prediction: {
            persisted: true, roadmapDurable: true, predictionDurable: true,
            prediction_id: query.values[1].prediction_id,
          } }] }
        }
        if (/cloud_table_rounds/i.test(text)) return { rows: [] }
        throw new Error(`unexpected query in checkout test: ${text}`)
      } finally {
        release()
      }
    },
  }
  const writer = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    requestTimeoutMs: 100, durableWriteRequestTimeoutMs: 100, strategyPool,
  })
  const passiveState = { setStatus() {}, setTables() {}, async upsertRoundEvent() { return { ok: true } } }
  const ancillaryPayload = (sessionId) => applyCloudCapturePayload({
    parsed: { sessionId, status: { connected: true }, tables: [], rounds: [] },
    state: passiveState,
    writer,
  })
  const ancillary = [ancillaryPayload('ancillary-1'), ancillaryPayload('ancillary-2')]
  while (ancillaryStarted < 3) await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))

  const final = finalRound('BAG10', 21)
  const settlementState = {
    setStatus() {}, setTables() {},
    async upsertRoundEvent(round) {
      const prediction = await writer.readIssuedPrediction({
        tableId: round.tableId, shoe: round.shoe, round: round.round,
        strategyVersion: 'v105',
      }, { priority: 'settlement' })
      await writer.persistRound(round, baseTable, prediction)
      return { ok: true }
    },
  }
  try {
    const result = await applyCloudCapturePayload({
      parsed: { sessionId: 'formal-final', status: { connected: true }, tables: [baseTable], rounds: [final] },
      state: settlementState,
      writer,
    })
    assert.ok(result.durableTimings.formalSettlementMs < 100)
  } finally {
    releaseAncillary()
    await Promise.allSettled(ancillary)
  }
})

test('strategy queue deadline identifies the exact queued SQL target', async () => {
  let releaseAll = false
  const releases = []
  const strategyPool = {
    async query(query) {
      const text = String(query?.text ?? query)
      if (/persist_latest_cloud_table_snapshot/i.test(text)) {
        if (!releaseAll) await new Promise((resolve) => releases.push(resolve))
        return { rows: [{ persist_latest_cloud_table_snapshot: { persisted: true } }] }
      }
      if (/cloud_capture_status/i.test(text)) return { rows: [] }
      throw new Error(`unexpected diagnostic query: ${text}`)
    },
  }
  const writer = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    requestTimeoutMs: 20, durableWriteRequestTimeoutMs: 20, strategyPool,
  })
  const blockers = Array.from({ length: 4 }, (_, index) => writer.writeCloudTableSnapshot({
    sessionId: `diagnostic-blocker-${index}`, tables: [{ tableId: 'BAG01' }], status: { connected: true },
  }))
  await delay(10)
  try {
    await assert.rejects(
      writer.writeCloudCaptureStatus({ sessionId: 'diagnostic-status', connected: true }),
      /strategy query queue deadline exceeded.*cloud_capture_status/i,
    )
  } finally {
    releaseAll = true
    for (const release of releases.splice(0)) release()
    await Promise.allSettled(blockers)
  }
})

test('strategy scheduler keeps four standard slots while reserving raw and control lanes', async () => {
  let started = 0
  let releaseAll = false
  const releases = []
  const strategyPool = {
    async query(query) {
      const text = String(query?.text ?? query)
      if (!/persist_latest_cloud_table_snapshot/i.test(text)) throw new Error(`unexpected query in scheduler headroom test: ${text}`)
      started += 1
      if (!releaseAll) await new Promise((resolve) => releases.push(resolve))
      return { rows: [{ persist_latest_cloud_table_snapshot: { persisted: true } }] }
    },
  }
  const writer = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    requestTimeoutMs: 100, durableWriteRequestTimeoutMs: 100, strategyPool,
  })
  const calls = Array.from({ length: 4 }, (_, index) => writer.writeCloudTableSnapshot({
    sessionId: `standard-headroom-${index}`, tables: [{ tableId: 'BAG01' }], status: { connected: true },
  }))
  await delay(20)
  try {
    assert.equal(started, 4, 'all four standard slots should start without queueing')
  } finally {
    releaseAll = true
    for (const release of releases.splice(0)) release()
    await Promise.allSettled(calls)
  }
})

test('formal issuance uses the reserved priority slot when shadow-standard traffic is saturated', async () => {
  let standardStarted = 0
  let issueStarted = 0
  let releaseAll = false
  const standardReleases = []
  const candidate = buildLivePrediction({ tableId: 'BAG10', shoe: 'S2', round: 30 })
  const issued = {
    ...candidate,
    predictionId: '22222222-2222-2222-2222-222222222222',
    issuedAt: '2026-07-29T00:00:00.000Z',
  }
  const strategyPool = {
    async query(query) {
      const text = String(query?.text ?? query)
      if (/persist_latest_cloud_table_snapshot/i.test(text)) {
        standardStarted += 1
        if (!releaseAll) await new Promise((resolve) => standardReleases.push(resolve))
        return { rows: [{ persist_latest_cloud_table_snapshot: { persisted: true } }] }
      }
      if (/issue_v105_prediction/i.test(text)) {
        issueStarted += 1
        return { rows: [{ issue_v105_prediction: {
          prediction_id: issued.predictionId,
          prediction_issued_at: issued.issuedAt,
          prediction: issued,
        } }] }
      }
      throw new Error(`unexpected query in formal issuance priority test: ${text}`)
    },
  }
  const writer = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    requestTimeoutMs: 100, durableWriteRequestTimeoutMs: 100, strategyPool,
  })
  const standardCalls = [1, 2, 3].map((index) => writer.writeCloudTableSnapshot({
    sessionId: `shadow-standard-${index}`, tables: [{ tableId: `BAG0${index}` }], status: { connected: true },
  }))
  while (standardStarted < 3) await new Promise((resolve) => setImmediate(resolve))
  const issuance = writer.issuePrediction(candidate)
  await delay(20)

  try {
    assert.equal(issueStarted, 1, 'formal issuance must use the reserved priority slot')
  } finally {
    releaseAll = true
    for (const release of standardReleases.splice(0)) release()
    await Promise.allSettled([...standardCalls, issuance])
  }
})

test('formal settlement burst keeps four reserved priority slots beside four standard slots', async () => {
  let standardStarted = 0
  let formalStarted = 0
  let releaseAll = false
  const standardReleases = []
  const formalReleases = []
  const strategyPool = {
    async query(query) {
      const text = String(query?.text ?? query)
      if (/persist_latest_cloud_table_snapshot/i.test(text)) {
        standardStarted += 1
        if (!releaseAll) await new Promise((resolve) => standardReleases.push(resolve))
        return { rows: [{ persist_latest_cloud_table_snapshot: { persisted: true } }] }
      }
      if (/jsonb_array_elements/i.test(text)) {
        formalStarted += 1
        if (!releaseAll) await new Promise((resolve) => formalReleases.push(resolve))
        const payloads = JSON.parse(query.values[0])
        return { rows: payloads.map((item, index) => ({
          ordinality: index + 1,
          acknowledgement: {
            persisted: true, roadmapDurable: true, predictionDurable: true,
            prediction_id: item.p_settlement.prediction_id,
          },
        })) }
      }
      if (/settle_v105_prediction/i.test(text)) {
        formalStarted += 1
        if (!releaseAll) await new Promise((resolve) => formalReleases.push(resolve))
        return { rows: [{ settle_v105_prediction: {
          persisted: true, roadmapDurable: true, predictionDurable: true,
          prediction_id: query.values[1].prediction_id,
        } }] }
      }
      throw new Error(`unexpected query in priority burst test: ${text}`)
    },
  }
  const writer = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    requestTimeoutMs: 100, durableWriteRequestTimeoutMs: 100, strategyPool,
  })
  const standardCalls = [1, 2, 3, 4].map((index) => writer.writeCloudTableSnapshot({
    sessionId: `standard-${index}`, tables: [{ tableId: `BAG${index}` }], status: { connected: true },
  }))
  while (standardStarted < 4) await new Promise((resolve) => setImmediate(resolve))

  const tableIds = ['BAG01', 'BAG02', 'BAG03', 'BAG03A', 'BAG05']
  const formalCalls = tableIds.map((tableId, index) => {
    const table = { tableId, shoe: 'S1', round: 20 }
    const prediction = {
      ...buildLivePrediction(table),
      predictionId: `${index + 1}1111111-1111-1111-1111-111111111111`,
      issuedAt: '2026-07-28T00:00:00.000Z',
    }
    return writer.persistRound(finalRound(tableId, 21), table, prediction)
  })
  while (formalStarted < 1) await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(formalStarted, 4)

  releaseAll = true
  for (const release of standardReleases.splice(0)) release()
  for (const release of formalReleases.splice(0)) release()
  await Promise.all([...standardCalls, ...formalCalls])
})

test('raw ingest ACK keeps a dedicated slot when four standard and four formal queries are saturated', async () => {
  let standardStarted = 0
  let formalStarted = 0
  let rawIngestStarted = 0
  let releaseAll = false
  const releases = []
  const strategyPool = {
    async query(query) {
      const text = String(query?.text ?? query)
      if (/persist_latest_cloud_table_snapshot/i.test(text)) standardStarted += 1
      else if (/persist_v105_fenced_capture_envelope/i.test(text)) rawIngestStarted += 1
      else formalStarted += 1
      if (!releaseAll && !/persist_v105_fenced_capture_envelope/i.test(text)) {
        await new Promise((resolve) => releases.push(resolve))
      }
      if (/persist_latest_cloud_table_snapshot/i.test(text)) {
        return { rows: [{ persist_latest_cloud_table_snapshot: { persisted: true } }] }
      }
      if (/persist_v105_fenced_capture_envelope/i.test(text)) {
        return { rows: [{ persist_v105_fenced_capture_envelope: {
          persisted: true, duplicate: false, accepted_round_keys: [],
        } }] }
      }
      return { rows: [] }
    },
  }
  const writer = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    requestTimeoutMs: 500, durableWriteRequestTimeoutMs: 500, strategyPool,
  })
  const standardCalls = Array.from({ length: 4 }, (_, index) => writer.writeCloudTableSnapshot({
    sessionId: `raw-ack-standard-${index}`, tables: [{ tableId: `BAG${index}` }], status: { connected: true },
  }))
  while (standardStarted < 4) await new Promise((resolve) => setImmediate(resolve))
  const formalCalls = [1, 2, 3, 4].map((round) => writer.readIssuedPrediction({
    tableId: 'BAG01', shoe: 'S1', round, strategyVersion: 'v105',
  }, { priority: 'settlement' }))
  while (formalStarted < 4) await new Promise((resolve) => setImmediate(resolve))
  const rawIngest = writer.persistCaptureEnvelope({
    sessionId: 'raw-ack-worker', sequence: 1, roundKeys: [],
    tables: [{ tableId: 'BAG01', shoe: 'S1', round: 10 }], rounds: [],
    status: { connected: true, authenticated: true, tableCount: 1 },
    capturedAt: '2026-08-20T00:00:00.000Z',
    source: { role: 'canonical_api', ownerId: 'raw-ack-owner', epoch: 1 },
  })
  await delay(20)
  try {
    assert.equal(rawIngestStarted, 1, 'raw ingest must not queue behind all background/formal slots')
  } finally {
    releaseAll = true
    for (const release of releases.splice(0)) release()
    await Promise.allSettled([...standardCalls, ...formalCalls, rawIngest])
  }
})

test('a stalled outbox claim cannot block the next raw envelope durable ACK', async () => {
  let claimStarted = 0
  let rawIngestStarted = 0
  let releaseClaim
  const strategyPool = {
    async query(query) {
      const text = String(query?.text ?? query)
      if (/claim_v105_capture_settlement_outbox/i.test(text)) {
        claimStarted += 1
        await new Promise((resolve) => { releaseClaim = resolve })
        return { rows: [] }
      }
      if (/persist_v105_fenced_capture_envelope/i.test(text)) {
        rawIngestStarted += 1
        return { rows: [{ persist_v105_fenced_capture_envelope: {
          persisted: true, duplicate: false, accepted_round_keys: [],
        } }] }
      }
      throw new Error(`unexpected query in raw/control isolation test: ${text}`)
    },
  }
  const writer = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    requestTimeoutMs: 500, durableWriteRequestTimeoutMs: 500, strategyPool,
  })
  const claim = writer.claimCaptureOutbox({ limit: 1 })
  while (claimStarted < 1) await new Promise((resolve) => setImmediate(resolve))
  const rawIngest = writer.persistCaptureEnvelope({
    sessionId: 'raw-after-stalled-claim', sequence: 1, roundKeys: [],
    tables: [{ tableId: 'BAG01', shoe: 'S1', round: 10 }], rounds: [],
    status: { connected: true, authenticated: true, tableCount: 1 },
    capturedAt: '2026-08-20T00:00:00.000Z',
    source: { role: 'canonical_api', ownerId: 'raw-control-owner', epoch: 1 },
  })
  await delay(20)
  try {
    assert.equal(rawIngestStarted, 1, 'raw ingest must have a lane independent of a stalled outbox control query')
  } finally {
    releaseClaim?.()
    await Promise.allSettled([claim, rawIngest])
  }
})

test('outbox control RPCs keep their own lane when standard and formal work are saturated', async () => {
  let standardStarted = 0
  let formalStarted = 0
  const controlStarted = []
  let releaseAll = false
  const releases = []
  const strategyPool = {
    async query(query) {
      const text = String(query?.text ?? query)
      if (/persist_latest_cloud_table_snapshot/i.test(text)) {
        standardStarted += 1
        if (!releaseAll) await new Promise((resolve) => releases.push(resolve))
        return { rows: [{ persist_latest_cloud_table_snapshot: { persisted: true } }] }
      }
      if (/claim_v105_capture_settlement_outbox/i.test(text)) {
        controlStarted.push('claim')
        return { rows: [] }
      }
      if (/complete_v105_capture_settlement_outbox/i.test(text)) {
        controlStarted.push('complete')
        return { rows: [{ complete_v105_capture_settlement_outbox: { completed: true } }] }
      }
      if (/fail_v105_capture_settlement_outbox/i.test(text)) {
        controlStarted.push('fail')
        return { rows: [{ fail_v105_capture_settlement_outbox: { failed: true } }] }
      }
      if (/get_v105_capture_outbox_health/i.test(text)) {
        controlStarted.push('health')
        return { rows: [{ health: { pending: 0, processing: 0, error: 0, dead_letter: 0 } }] }
      }
      formalStarted += 1
      if (!releaseAll) await new Promise((resolve) => releases.push(resolve))
      return { rows: [] }
    },
  }
  const writer = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    requestTimeoutMs: 500, durableWriteRequestTimeoutMs: 500, strategyPool,
  })
  const standardCalls = Array.from({ length: 4 }, (_, index) => writer.writeCloudTableSnapshot({
    sessionId: `control-standard-${index}`, tables: [{ tableId: `BAG${index}` }], status: { connected: true },
  }))
  while (standardStarted < 4) await new Promise((resolve) => setImmediate(resolve))
  const formalCalls = [1, 2, 3, 4].map((round) => writer.readIssuedPrediction({
    tableId: 'BAG01', shoe: 'S1', round, strategyVersion: 'v105',
  }, { priority: 'settlement' }))
  while (formalStarted < 4) await new Promise((resolve) => setImmediate(resolve))
  const controls = [
    writer.claimCaptureOutbox({ limit: 1 }),
    writer.completeCaptureOutbox({ sessionId: 'control', sequence: 1, claimToken: '00000000-0000-0000-0000-000000000001', attempt: 1 }),
    writer.failCaptureOutbox({ sessionId: 'control', sequence: 2, claimToken: '00000000-0000-0000-0000-000000000002', attempt: 1, error: 'bounded' }),
    writer.getCaptureOutboxHealth(),
  ]
  await delay(20)
  try {
    assert.deepEqual(controlStarted, ['claim', 'complete', 'fail', 'health'])
  } finally {
    releaseAll = true
    for (const release of releases.splice(0)) release()
    await Promise.allSettled([...standardCalls, ...formalCalls, ...controls])
  }
})

test('timed-out outbox control work is removed and the reserved slot remains reusable', async () => {
  let releaseClaim
  let healthStarted = 0
  const strategyPool = {
    async query(query) {
      const text = String(query?.text ?? query)
      if (/claim_v105_capture_settlement_outbox/i.test(text)) {
        await new Promise((resolve) => { releaseClaim = resolve })
        return { rows: [] }
      }
      if (/get_v105_capture_outbox_health/i.test(text)) {
        healthStarted += 1
        return { rows: [{ health: { pending: 0, processing: 0, error: 0, dead_letter: 0 } }] }
      }
      throw new Error(`unexpected query in critical timeout test: ${text}`)
    },
  }
  const writer = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    requestTimeoutMs: 20, durableWriteRequestTimeoutMs: 20, strategyPool,
  })
  const blockingClaim = writer.claimCaptureOutbox({ limit: 1 })
  while (typeof releaseClaim !== 'function') await new Promise((resolve) => setImmediate(resolve))
  await assert.rejects(
    writer.getCaptureOutboxHealth(),
    /strategy query queue deadline exceeded: get_v105_capture_outbox_health/,
  )
  assert.equal(healthStarted, 0)
  releaseClaim()
  await blockingClaim
  const health = await writer.getCaptureOutboxHealth()
  assert.equal(healthStarted, 1)
  assert.equal(health.pending, 0)
})

test('sustained priority traffic cannot starve an ACK-required standard durable write', async () => {
  const started = []
  const blocked = []
  let releaseAll = false
  const resultFor = (text) => /persist_latest_cloud_table_snapshot/i.test(text)
    ? { rows: [{ persist_latest_cloud_table_snapshot: { persisted: true } }] }
    : { rows: [] }
  const strategyPool = {
    query(query) {
      const text = String(query?.text ?? query)
      const kind = /persist_latest_cloud_table_snapshot/i.test(text) ? 'standard' : 'priority'
      started.push(kind)
      if (releaseAll) return Promise.resolve(resultFor(text))
      return new Promise((resolve) => blocked.push({ text, resolve }))
    },
  }
  const writer = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    requestTimeoutMs: 100, durableWriteRequestTimeoutMs: 100, strategyPool,
  })
  const priorityRead = (round) => writer.readIssuedPrediction({
    tableId: 'BAG01', shoe: 'S1', round, strategyVersion: 'v105',
  }, { priority: 'settlement' })
  const calls = [1, 2, 3].map(priorityRead)
  while (started.length < 3) await new Promise((resolve) => setImmediate(resolve))
  calls.push(writer.writeCloudTableSnapshot({
    sessionId: 'fairness-worker', tables: [{ tableId: 'BAG01' }], status: { connected: true },
  }))
  calls.push(...[4, 5, 6, 7].map(priorityRead))

  try {
    while (started.length < 4) await new Promise((resolve) => setImmediate(resolve))
    assert.equal(started[3], 'standard')
  } finally {
    releaseAll = true
    while (blocked.length > 0) {
      const item = blocked.shift()
      item.resolve(resultFor(item.text))
    }
    await Promise.allSettled(calls)
  }
})

test('cloud ingest fails closed within its proxy deadline before the worker request timeout', async () => {
  let releaseSnapshot
  const snapshotGate = new Promise((resolve) => { releaseSnapshot = resolve })
  const writer = {
    configured: true,
    async writeCloudCaptureStatus() {},
    async writeCloudTableSnapshot() { await snapshotGate },
  }
  const app = createApp({
    autoConnect: false,
    ingestKey: 'worker-key',
    now: () => 1_000_000,
    ingestDeadlineMs: 20,
    supabaseClient: writer,
  })
  const request = app.inject({
    method: 'POST',
    url: '/api/cloud-ingest/snapshot',
    headers: { 'x-worker-key': 'worker-key' },
    body: JSON.stringify({
      protocolVersion: 'v105', timestamp: 1_000_000, sequence: 1, roundKeys: [],
      snapshot: {
        buildVersion: '105', sessionId: 'deadline-worker', connected: true, authenticated: true,
        tables: [{ tableId: 'BAG01', shoe: 'S1', round: 1 }], rounds: [],
      },
    }),
  })
  try {
    const response = await Promise.race([
      request,
      delay(75).then(() => ({ statusCode: 599, body: JSON.stringify({ error: 'test deadline exceeded' }) })),
    ])
    assert.equal(response.statusCode, 503)
    assert.deepEqual(JSON.parse(response.body), {
      ok: false,
      accepted: false,
      error: 'durable ingest deadline exceeded',
    })
  } finally {
    releaseSnapshot()
    await request
  }
})

test('timed-out ingest keeps the session lock until its underlying durable work settles', async () => {
  let releaseSnapshot
  const snapshotGate = new Promise((resolve) => { releaseSnapshot = resolve })
  let snapshotCalls = 0
  let activeSnapshots = 0
  let maxActiveSnapshots = 0
  const writer = {
    configured: true,
    async writeCloudCaptureStatus() {},
    async writeCloudTableSnapshot() {
      snapshotCalls += 1
      activeSnapshots += 1
      maxActiveSnapshots = Math.max(maxActiveSnapshots, activeSnapshots)
      try {
        await snapshotGate
      } finally {
        activeSnapshots -= 1
      }
    },
  }
  const app = createApp({
    autoConnect: false,
    ingestKey: 'worker-key',
    now: () => 1_000_000,
    ingestDeadlineMs: 20,
    supabaseClient: writer,
  })
  const request = () => app.inject({
    method: 'POST',
    url: '/api/cloud-ingest/snapshot',
    headers: { 'x-worker-key': 'worker-key' },
    body: JSON.stringify({
      protocolVersion: 'v105', timestamp: 1_000_000, sequence: 1, roundKeys: [],
      snapshot: {
        buildVersion: '105', sessionId: 'deadline-lock-worker', connected: true, authenticated: true,
        tables: [{ tableId: 'BAG01', shoe: 'S1', round: 1 }], rounds: [],
      },
    }),
  })

  const first = await request()
  assert.equal(first.statusCode, 503)
  const retryPromise = request()
  await delay(30)
  assert.equal(snapshotCalls, 1)
  assert.equal(maxActiveSnapshots, 1)

  const retry = await retryPromise
  assert.equal(retry.statusCode, 503)
  assert.equal(JSON.parse(retry.body).accepted, false)
  releaseSnapshot()
  const completedRetry = await request()
  assert.equal(completedRetry.statusCode, 200)
  assert.equal(JSON.parse(completedRetry.body).duplicate, true)
  assert.equal(snapshotCalls, 1)
  assert.equal(maxActiveSnapshots, 1)
})

test('same durable ingest identity is single-flight across timed-out worker retries', async () => {
  let releasePersist
  const persistGate = new Promise((resolve) => { releasePersist = resolve })
  let persistCalls = 0
  const writer = {
    configured: true,
    async writeCloudTableSnapshot() {},
    async persistCaptureEnvelope({ sessionId, sequence, roundKeys }) {
      persistCalls += 1
      await persistGate
      return { persisted: true, duplicate: persistCalls > 1, session_id: sessionId, sequence, acceptedRoundKeys: roundKeys }
    },
  }
  const app = createApp({
    autoConnect: false,
    ingestKey: 'worker-key',
    now: () => 1_000_000,
    ingestDeadlineMs: 20,
    supabaseClient: writer,
  })
  const request = (shoe = 'S1') => app.inject({
    method: 'POST',
    url: '/api/cloud-ingest/snapshot',
    headers: { 'x-worker-key': 'worker-key' },
    body: JSON.stringify({
      protocolVersion: 'v105', timestamp: 1_000_000, sequence: 1, roundKeys: [],
      snapshot: {
        buildVersion: '105', sessionId: 'durable-singleflight-worker', connected: true, authenticated: true,
        tables: [{ tableId: 'BAG01', shoe, round: 1 }], rounds: [],
      },
    }),
  })

  const first = await request()
  assert.equal(first.statusCode, 503)
  const retries = [request(), request(), request()]
  const conflict = await request('S2')
  assert.equal(conflict.statusCode, 409)
  assert.equal(JSON.parse(conflict.body).error, 'sequence_payload_conflict')
  await delay(30)
  assert.equal(persistCalls, 1, 'retries must join the exact in-flight durable write instead of appending DB work')
  releasePersist()
  await Promise.all(retries)
  await delay(10)
  assert.equal(persistCalls, 1, 'settling one exact write must not replay every timed-out retry')

  const acknowledged = await request()
  assert.equal(acknowledged.statusCode, 200)
  assert.equal(JSON.parse(acknowledged.body).duplicate, true)
  assert.equal(persistCalls, 2, 'one later retry may perform the authoritative durable duplicate readback')
})
