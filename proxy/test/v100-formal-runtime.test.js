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
  assert.equal(result.predictions[0].side.strategyVersion.includes('v102'), true)
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
