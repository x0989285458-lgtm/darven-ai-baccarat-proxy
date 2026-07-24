import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createV100FormalRuntime } from '../src/v100-formal-runtime.js'
import { applyCloudCapturePayload } from '../src/cloud-capture.js'

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
