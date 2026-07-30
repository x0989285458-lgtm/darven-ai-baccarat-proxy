import test from 'node:test'
import assert from 'node:assert/strict'
import { createV100FormalRuntime, resolveV100FormalEnabled } from '../src/v100-formal-runtime.js'
import { buildV100SideActions } from '../src/supabase-writer.js'

const COUNTS = Object.fromEntries(['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'].map((rank) => [rank, 32]))

function table() {
  return { tableId: 'BAG01', shoe: 'S100', round: 1, bankerCount: 1, playerCount: 0, tieCount: 0, bankerPairCount: 0, playerPairCount: 0 }
}

function round() {
  return {
    source: 'mt-cloud', tableId: 'BAG01', shoe: 'S100', round: 1,
    sourceAction: '/api/v1/gametype/*/game/*/room/*/table/*/summary',
    rawResult: [1, 14, 2, 15, 27, 40, -1, -1, 4, 5], winner: 'banker', playerPoint: 4, bankerPoint: 5,
  }
}

function durable(overrides = {}) {
  return {
    identity: { source: 'mt-cloud', table_id: 'BAG01', shoe: 'S100' },
    status: 'contiguous', completeThroughRound: 1, complete_through_round: 1, targetRound: 2,
    rankDataAvailable: true, remainingRankCounts: { ...COUNTS, A: 29, '2': 29 },
    cardsSeenTotal: 6, cards_seen_dealt: 6, physicalRemainingExact: false,
    burnObservationStatus: 'unavailable', revision: 1, ...overrides,
  }
}

test('v100 release feature flag is exact opt-in only', () => {
  assert.equal(resolveV100FormalEnabled({}), false)
  assert.equal(resolveV100FormalEnabled({ V100_RELEASE_ENABLED: 'false' }), false)
  assert.equal(resolveV100FormalEnabled({ V100_RELEASE_ENABLED: 'TRUE' }), false)
  assert.equal(resolveV100FormalEnabled({ V100_RELEASE_ENABLED: 'true' }), true)
  assert.equal(resolveV100FormalEnabled({ V100_FORMAL_ENABLED: 'true' }), false)
})

test('v100 formal runtime is disabled by default and cannot touch writer or formal table', async () => {
  const input = table()
  const before = structuredClone(input)
  const runtime = createV100FormalRuntime({ writer: new Proxy({}, { get() { throw new Error('writer must not be called') } }) })
  const result = await runtime.processSnapshot({ tables: [input], rounds: [round()] })
  assert.deepEqual(result, { enabled: false, predictions: [] })
  assert.deepEqual(input, before)
})

test('enabled v100 runtime rehydrates, applies Final in round order, and scores only from DB ACK', async () => {
  const calls = []
  const writer = {
    configured: true,
    async readV100RankLedger(identity) { calls.push(['read', identity]); return null },
    async applyV100RankLedgerEvent(event) { calls.push(['apply', event.round]); return durable() },
  }
  const input = table()
  const before = structuredClone(input)
  const runtime = createV100FormalRuntime({ enabled: true, writer, source: 'mt-cloud' })
  const result = await runtime.processSnapshot({ tables: [input], rounds: [round()] })

  assert.deepEqual(calls.map((call) => call[0]), ['read', 'apply'])
  assert.equal(result.enabled, true)
  assert.equal(result.predictions.length, 1)
  assert.equal(result.predictions[0].rankDataAvailable, true)
  assert.equal(result.predictions[0].targetTableId, 'BAG01')
  assert.equal(result.predictions[0].targetShoe, 'S100')
  assert.equal(result.predictions[0].targetRound, 2)
  assert.equal(result.predictions[0].side.strategyVersion.includes('v105'), true)
  assert.equal(result.predictions[0].activationEligible, true)
  assert.deepEqual(
    result.predictions[0].side.actions,
    buildV100SideActions(result.predictions[0].side.predictions, result.predictions[0].main.predictedResult),
  )
  assert.equal(Object.values(result.predictions[0].side.actions).some((value) => typeof value === 'boolean'), true)
  assert.equal(result.predictions[0].activationBlockReason, null)
  assert.equal(result.tables[0].v102RankLedger.rankDataAvailable, true)
  assert.deepEqual(input, before, 'formal runtime must not mutate the formal table')
})

test('a restarted v100 runtime reads the exact durable shoe and fails rank closed when progress is stale', async () => {
  const reads = []
  const writer = {
    configured: true,
    async readV100RankLedger(identity) { reads.push(identity); return durable({ completeThroughRound: 0, complete_through_round: 0, targetRound: 1 }) },
    async applyV100RankLedgerEvent() { throw new Error('no new rounds expected') },
  }
  const runtime = createV100FormalRuntime({ enabled: true, writer, source: 'mt-cloud' })
  const result = await runtime.processSnapshot({ tables: [table()], rounds: [] })

  assert.equal(reads.length, 1)
  assert.equal(result.predictions[0].rankDataAvailable, false)
  assert.equal(result.predictions[0].side.diagnostics.rank.fallback, 'renormalize')
})

test('skips Final events already covered by the verified durable ledger and applies only the missing tail', async () => {
  const applied = []
  const writer = {
    configured: true,
    async readV100RankLedger() {
      return durable({ completeThroughRound: 22, complete_through_round: 22, targetRound: 23, revision: 22 })
    },
    async applyV100RankLedgerEvent(event) {
      applied.push(event.round)
      return durable({ completeThroughRound: event.round, complete_through_round: event.round, targetRound: event.round + 1, revision: event.round })
    },
  }
  const runtime = createV100FormalRuntime({ enabled: true, writer, source: 'mt-cloud' })
  await runtime.processSnapshot({
    tables: [{ ...table(), round: 23 }],
    rounds: [21, 22, 23].map((number) => ({ ...round(), round: number })),
  })
  assert.deepEqual(applied, [23])
})

test('never skips a Final event from an invalid durable ledger even when its complete round is higher', async () => {
  const applied = []
  const writer = {
    configured: true,
    async readV100RankLedger() {
      return durable({ status: 'invalid', rankDataAvailable: false, completeThroughRound: 22, complete_through_round: 22 })
    },
    async applyV100RankLedgerEvent(event) {
      applied.push(event.round)
      return durable({ completeThroughRound: event.round, complete_through_round: event.round })
    },
  }
  const runtime = createV100FormalRuntime({ enabled: true, writer, source: 'mt-cloud' })
  await runtime.processSnapshot({ tables: [{ ...table(), round: 21 }], rounds: [{ ...round(), round: 21 }] })
  assert.deepEqual(applied, [21])
})

test('formal rank-ledger work is serialized so one capture cannot starve service requests', async () => {
  let active = 0
  let maxActive = 0
  const writer = {
    configured: true,
    async readV100RankLedger(identity) {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      return durable({ identity, completeThroughRound: 0, complete_through_round: 0, targetRound: 1 })
    },
    async applyV100RankLedgerEvent() { throw new Error('no rounds expected') },
  }
  const runtime = createV100FormalRuntime({ enabled: true, writer, source: 'mt-cloud' })
  await runtime.processSnapshot({
    tables: ['BAG01', 'BAG02', 'BAG03'].map((tableId) => ({ ...table(), tableId })),
    rounds: [],
  })
  assert.equal(maxActive, 1)
})

test('cold ten-table capture hydrates exact rank-ledger identities with one bounded batch read', async () => {
  const batchCalls = []
  const writer = {
    configured: true,
    async readV100RankLedgers(identities) {
      batchCalls.push(structuredClone(identities))
      return identities.map((identity) => durable({
        identity: { source: identity.source, table_id: identity.tableId, shoe: identity.shoe },
        completeThroughRound: 0,
        complete_through_round: 0,
        targetRound: 1,
      }))
    },
    async readV100RankLedger() { assert.fail('cold multi-table hydration must not issue serial per-table reads') },
    async applyV100RankLedgerEvent() { throw new Error('no rounds expected') },
  }
  const runtime = createV100FormalRuntime({ enabled: true, writer, source: 'mt-cloud' })
  const tables = Array.from({ length: 10 }, (_, index) => ({
    ...table(), tableId: `BAG${String(index + 1).padStart(2, '0')}`, shoe: `S${index + 1}`,
  }))

  const result = await runtime.processSnapshot({ tables, rounds: [] })

  assert.equal(batchCalls.length, 1)
  assert.deepEqual(batchCalls[0], tables.map((item) => ({ source: 'mt-cloud', tableId: item.tableId, shoe: item.shoe })))
  assert.equal(result.tables.length, 10)
})

test('concurrent snapshots serialize batch hydration before applying the same identity tail', async () => {
  let batchCalls = 0
  let activeBatchReads = 0
  let maxActiveBatchReads = 0
  const applied = []
  const writer = {
    configured: true,
    async readV100RankLedgers() {
      batchCalls += 1
      const call = batchCalls
      activeBatchReads += 1
      maxActiveBatchReads = Math.max(maxActiveBatchReads, activeBatchReads)
      await new Promise((resolve) => setTimeout(resolve, call === 1 ? 30 : 0))
      activeBatchReads -= 1
      return []
    },
    async readV100RankLedger() { assert.fail('batch hydration must cover the identity without a serial fallback') },
    async applyV100RankLedgerEvent(event) {
      applied.push(event.round)
      return durable({
        completeThroughRound: event.round,
        complete_through_round: event.round,
        targetRound: event.round + 1,
        revision: event.round,
      })
    },
  }
  const runtime = createV100FormalRuntime({ enabled: true, writer, source: 'mt-cloud' })

  await Promise.all([
    runtime.processSnapshot({ tables: [{ ...table(), round: 2 }], rounds: [{ ...round(), round: 2 }] }),
    runtime.processSnapshot({ tables: [{ ...table(), round: 3 }], rounds: [{ ...round(), round: 3 }] }),
  ])

  assert.equal(batchCalls, 1, 'the later snapshot must observe the first FIFO hydration result')
  assert.equal(maxActiveBatchReads, 1, 'batch DB reads must stay inside the formal concurrency permit')
  assert.deepEqual(applied, [2, 3], 'same-identity Finals must apply in snapshot arrival order')
})

test('partial batch hydration treats missing requested identities as absent rows without serial reads', async () => {
  const first = { ...table(), tableId: 'BAG01', shoe: 'S1' }
  const second = { ...table(), tableId: 'BAG02', shoe: 'S2' }
  const writer = {
    configured: true,
    async readV100RankLedgers() {
      return [durable({
        identity: { source: 'mt-cloud', table_id: 'BAG01', shoe: 'S1' },
        completeThroughRound: 0,
        complete_through_round: 0,
        targetRound: 1,
      })]
    },
    async readV100RankLedger() { assert.fail('a partial batch result must not degrade into per-table reads') },
    async applyV100RankLedgerEvent() { throw new Error('no rounds expected') },
  }
  const runtime = createV100FormalRuntime({ enabled: true, writer, source: 'mt-cloud' })

  const result = await runtime.processSnapshot({ tables: [first, second], rounds: [] })

  assert.equal(result.tables.length, 2)
  assert.equal(result.tables[0].v102RankLedger?.identity?.table_id, 'BAG01')
  assert.equal(result.tables[1].v102RankLedger, undefined)
})
