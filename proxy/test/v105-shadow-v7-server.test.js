import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createApp } from '../src/server.js'
import { V105_SHADOW_VERSION } from '../src/v105-shadow-contract.js'
import { V104_ITERATION_SHADOW_VERSION } from '../src/v104-iteration-shadow-contract.js'
import { buildV105FormalPrediction } from '../src/v105-formal-strategy.js'

const TABLE_IDS = ['BAG01','BAG02','BAG03','BAG03A','BAG05','BAG06','BAG07','BAG08','BAG09','BAG10']
const table = (tableId = 'BAG01') => ({ tableId, shoe: 105, round: 20, bankerCount: 12, playerCount: 8 })

test('the same ten-table update fans out independently to V7 alongside V6', async () => {
  const v6Observed = []
  const v7Observed = []
  const runtime = (version, observed) => ({
    enabled: true,
    async observeTable(value) { observed.push(value.tableId) },
    async settleRound() {},
    snapshot: () => ({ strategyVersion: version, status: 'ready' }),
  })
  const app = createApp({
    autoConnect: false, supabaseClient: { configured: false },
    v105ShadowRuntime: runtime('v105-shadow-v6-road-pattern', v6Observed),
    v105ShadowV7Runtime: runtime('v105-shadow-v7-ask-road', v7Observed),
  })
  app.state.setTables(TABLE_IDS.map(table))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(v6Observed, TABLE_IDS)
  assert.deepEqual(v7Observed, TABLE_IDS)
})

test('V7 issuance and Final errors never block formal Final or V6 fan-out', async () => {
  let formalSettlements = 0
  let v6Settlements = 0
  let v7Settlements = 0
  const formal = { ...buildV105FormalPrediction(table()), predictionId: 'formal', issuedAt: '2026-07-27T10:00:00.000Z' }
  const writer = {
    configured: true,
    async getV105FormalHistory() { return [] }, async getRecentPredictionRows() { return [] },
    async issuePrediction() { return formal }, async readIssuedPrediction() { return formal },
    async persistRound() { formalSettlements += 1; return { prediction: { ...formal, strategy_version: 'v105', settlement_final: true } } },
    getRuntimeStatus() { return { ready: true, degraded: false, activeStrategyVersion: 'v105' } },
  }
  const v6 = { enabled: true, async observeTable() {}, async settleRound() { v6Settlements += 1 }, snapshot: () => ({ status: 'ready' }) }
  const v7 = {
    enabled: true,
    observeTable() { throw new Error('v7 issue failed') },
    settleRound() { v7Settlements += 1; throw new Error('v7 final failed') },
    snapshot: () => ({ status: 'error' }),
  }
  const app = createApp({ autoConnect: false, supabaseClient: writer, v105ShadowRuntime: v6, v105ShadowV7Runtime: v7 })
  app.state.setTables([table()])
  await new Promise((resolve) => setImmediate(resolve))
  app.state.upsertRoundEvent({ ...table(), round: 21, sourceAction: '/summary', winner: 'banker', rawResult: [1,9,2,10,0,0,-1,-1,3,9] })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(formalSettlements, 1)
  assert.equal(v6Settlements, 1)
  assert.equal(v7Settlements, 1)
  assert.equal(JSON.parse((await app.inject({ url: '/health' })).body).degraded, false)
})

test('V5/V6 identities remain exact and V7 identity is absent from frontend/admin source', () => {
  assert.equal(V104_ITERATION_SHADOW_VERSION, 'v104-seven-head-shadow-v5-best-stage-side-reweight')
  assert.equal(V105_SHADOW_VERSION, 'v105-shadow-v6-road-pattern')
  const root = new URL('../..', import.meta.url)
  const files = execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files', '-z', 'frontend', 'admin'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
  for (const file of files) assert.doesNotMatch(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'), /v105-shadow-v7-ask-road/i)
})
