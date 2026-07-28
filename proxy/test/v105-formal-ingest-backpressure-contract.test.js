import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createV100FormalRuntime } from '../src/v100-formal-runtime.js'
import { applyCloudCapturePayload } from '../src/cloud-capture.js'
import { buildLivePrediction, createSupabaseIngestionClient } from '../src/supabase-writer.js'
import { createApp } from '../src/server.js'

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

test('formal rank ledger preserves per-identity order while processing independent tables concurrently', async () => {
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
  assert.equal(maxActive, 2)
})

test('formal identity fan-out is bounded to four concurrent durable operations', async () => {
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

  assert.ok(maxActive >= 2)
  assert.ok(maxActive <= 4, `expected at most 4 concurrent identities, got ${maxActive}`)
})

test('formal settlement preserves per-table order while processing independent tables concurrently', async () => {
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
  assert.equal(maxActive, 2)
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


test('overlapping snapshot calls share the same four-identity concurrency budget', async () => {
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
  assert.ok(maxActive >= 2)
  assert.ok(maxActive <= 4, `expected one shared limit of 4, got ${maxActive}`)
})

test('overlapping snapshots keep independent identities concurrent', async () => {
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
  assert.equal(maxActive, 2)
})

test('formal Final settlement keeps a reserved checkout when concurrent ingest envelopes persist ancillary data', async () => {
  let active = 0
  let ancillaryStarted = 0
  let releaseAncillary
  const ancillaryGate = new Promise((resolve) => { releaseAncillary = resolve })
  const waiters = []
  const wakeWaiters = () => {
    while (active < 4 && waiters.length > 0) waiters.shift()()
  }
  const acquire = () => new Promise((resolve, reject) => {
    if (active < 4) {
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

test('formal settlement burst uses three priority slots while preserving one standard slot', async () => {
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
  const standardCalls = [1, 2, 3].map((index) => writer.writeCloudTableSnapshot({
    sessionId: `standard-${index}`, tables: [{ tableId: `BAG0${index}` }], status: { connected: true },
  }))
  while (standardStarted < 3) await new Promise((resolve) => setImmediate(resolve))

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

  standardReleases.shift()()
  standardReleases.shift()()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(formalStarted, 3)

  releaseAll = true
  for (const release of standardReleases.splice(0)) release()
  for (const release of formalReleases.splice(0)) release()
  await Promise.all([...standardCalls, ...formalCalls])
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
