import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'
import { buildV105FormalPrediction } from '../src/v105-formal-strategy.js'

const TABLE_IDS = ['BAG01','BAG02','BAG03','BAG03A','BAG05','BAG06','BAG07','BAG08','BAG09','BAG10']
const table = (tableId = 'BAG01') => ({ tableId, shoe: 105, round: 20, bankerCount: 12, playerCount: 8 })

test('the same formal ten-table snapshot fans out to v105-shadow-v6-road-pattern issuance', async () => {
  const observed = []
  const shadow = {
    enabled: true,
    async observeTable(value) { observed.push(structuredClone(value)) },
    async settleRound() {},
    snapshot: () => ({ strategyVersion: 'v105-shadow-v6-road-pattern', status: 'ready' }),
  }
  const app = createApp({
    autoConnect: false, supabaseClient: { configured: false },
    v105ShadowRuntime: shadow,
  })
  app.state.setTables(TABLE_IDS.map(table))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(observed.map((value) => value.tableId), TABLE_IDS)
})

test('default v105 shadow does not partially start against an incomplete writer', async () => {
  let shadowHydrations = 0
  const writer = {
    configured: true,
    async getV105FormalHistory() { return [] },
    async getRecentPredictionRows() { return [] },
    async issuePrediction(candidate) { return { ...candidate, predictionId: 'formal', issuedAt: '2026-07-27T10:00:00.000Z' } },
    async getV105ShadowHistory() { shadowHydrations += 1; return [] },
  }
  const app = createApp({ autoConnect: false, supabaseClient: writer })
  app.state.setTables([table()])
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(shadowHydrations, 0)
})

test('v105 shadow issuance and settlement failures cannot block formal Queue ACK or Final', async () => {
  let formalIssues = 0
  let formalSettlements = 0
  let shadowIssues = 0
  let shadowSettlements = 0
  const formal = {
    ...buildV105FormalPrediction(table()), predictionId: 'formal-v105-pid', issuedAt: '2026-07-27T10:00:00.000Z',
  }
  const writer = {
    configured: true,
    async getV105FormalHistory() { return [] },
    async getRecentPredictionRows() { return [] },
    async issuePrediction() { formalIssues += 1; return formal },
    async readIssuedPrediction() { return formal },
    async persistRound() {
      formalSettlements += 1
      return { prediction: { ...formal, strategy_version: 'v105', settlement_final: true, resolved_at: '2026-07-27T10:00:01.000Z' } }
    },
    getRuntimeStatus() { return { ready: true, degraded: false, reason: null, activeStrategyVersion: 'v105' } },
  }
  const shadow = {
    enabled: true,
    observeTable() { shadowIssues += 1; throw new Error('v105 shadow issuance unavailable') },
    settleRound() { shadowSettlements += 1; throw new Error('v105 shadow settlement unavailable') },
    snapshot: () => ({ strategyVersion: 'v105-shadow-v6-road-pattern', status: 'error', error: 'v105 shadow settlement unavailable' }),
  }
  const app = createApp({ autoConnect: false, supabaseClient: writer, v105ShadowRuntime: shadow })
  app.state.setTables([table()])
  await new Promise((resolve) => setImmediate(resolve))
  app.state.upsertRoundEvent({
    ...table(), round: 21, sourceAction: '/summary', winner: 'banker',
    rawResult: [1, 9, 2, 10, 0, 0, -1, -1, 3, 9],
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(formalIssues, 1)
  assert.equal(formalSettlements, 1)
  assert.equal(shadowIssues, 1)
  assert.equal(shadowSettlements, 1)
  const health = JSON.parse((await app.inject({ url: '/health' })).body)
  assert.equal(health.degraded, false)
  assert.equal(health.runtimeStatus.activeStrategyVersion, 'v105')
})
