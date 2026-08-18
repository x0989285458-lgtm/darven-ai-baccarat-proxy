import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'
import { buildLivePrediction } from '../src/supabase-writer.js'

const table = { tableId: 'BAG08', shoe: 104, round: 20, bankerCount: 12, playerCount: 8 }
const final = { ...table, round: 21, sourceAction: '/summary', winner: 'banker', rawResult: [1, 9, 2, 10, 0, 0, -1, -1, 3, 9] }

test('promoted v104 formal output ignores attempted same-version shadow injection while v103 continues observing', async () => {
  const activeWriter = { configured: false }
  const clock = () => Date.parse('2026-07-21T10:00:00Z')
  let withoutV104Calls = 0
  let withV104Calls = 0
  const withoutV104 = createApp({
    autoConnect: false, supabaseClient: activeWriter, now: clock,
    v103ShadowRuntime: { enabled: true, async observeTable() { withoutV104Calls += 1 }, async settleRound() {}, snapshot: () => ({ status: 'ready' }) },
  })
  const withV104 = createApp({
    autoConnect: false, supabaseClient: activeWriter, now: clock,
    v103ShadowRuntime: { enabled: true, async observeTable() { withV104Calls += 1 }, async settleRound() {}, snapshot: () => ({ status: 'ready' }) },
    v104ShadowRuntime: { enabled: true, async observeTable() {}, async settleRound() {}, snapshot: () => ({ status: 'ready' }) },
  })
  withoutV104.state.setTables([table])
  withV104.state.setTables([table])
  const baseline = JSON.parse((await withoutV104.inject({ url: '/api/tables' })).body)
  const candidate = JSON.parse((await withV104.inject({ url: '/api/tables' })).body)
  assert.deepEqual(candidate, baseline)
  assert.equal(candidate[0].prediction.strategyVersion, 'v106')
  assert.equal(withoutV104Calls, 1)
  assert.equal(withV104Calls, 1)
})

test('attempted v104 shadow failure is disabled and cannot block formal v104 or v103', async () => {
  let activeSettlements = 0
  let v103Settlements = 0
  const issued = { ...buildLivePrediction(table), strategyVersion: 'v106', predictionId: 'v106-pid', issuedAt: '2026-07-21T10:00:00Z' }
  const activeWriter = {
    configured: true,
    getV106FormalHistory: async () => [],
    async issuePrediction() { return issued },
    async readIssuedPrediction() { return issued },
    async persistRound() { activeSettlements += 1; return { prediction: { strategy_version: 'v106' } } },
    getRuntimeStatus() { return { ready: true, degraded: false, reason: null, activeStrategyVersion: 'v106' } },
  }
  const v103 = {
    enabled: true, async observeTable() {}, async settleRound() { v103Settlements += 1 },
    snapshot: () => ({ status: 'ready' }),
  }
  const v104 = {
    enabled: true,
    async observeTable() { throw new Error('v104 issuance unavailable') },
    async settleRound() { throw new Error('v104 settlement unavailable') },
    snapshot: () => ({ status: 'error', error: 'v104 settlement unavailable' }),
  }
  const app = createApp({ autoConnect: false, supabaseClient: activeWriter, v103ShadowRuntime: v103, v104ShadowRuntime: v104, controlToken: 'operator-only' })
  app.state.setTables([table])
  await app.waitForServiceWorkIdle()
  await app.inject({ url: '/api/tables' })
  await app.state.upsertRoundEvent(final)

  assert.equal(activeSettlements, 1)
  assert.equal(v103Settlements, 1)
  const publicStatus = JSON.parse((await app.inject({ url: '/api/status' })).body)
  const health = JSON.parse((await app.inject({ url: '/health' })).body)
  const unauthorized = await app.inject({ url: '/api/v104-shadow/status' })
  const controlled = JSON.parse((await app.inject({ url: '/api/v104-shadow/status', headers: { 'x-control-token': 'operator-only' } })).body)
  assert.equal('v104Shadow' in publicStatus, false)
  assert.equal('v103Shadow' in publicStatus, false)
  assert.equal('v104Shadow' in health, false)
  assert.equal(health.degraded, false)
  assert.equal(health.runtimeStatus.activeStrategyVersion, 'v106')
  assert.equal(unauthorized.statusCode, 401)
  assert.equal(controlled.activeStrategyVersion, 'v106')
  assert.equal(controlled.v104Shadow.status, 'error')
})
