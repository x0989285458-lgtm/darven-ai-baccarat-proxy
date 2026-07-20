import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'
import { buildLivePrediction } from '../src/supabase-writer.js'

const table = { tableId: 'BAG01', shoe: 103, round: 20, bankerCount: 12, playerCount: 8 }
const final = { ...table, round: 21, sourceAction: '/summary', winner: 'banker', rawResult: [1, 9, 2, 10, 0, 0, -1, -1, 3, 9] }

test('adding v103 shadow leaves the member v102 table prediction bit-for-bit unchanged', async () => {
  const activeWriter = { configured: false }
  const clock = () => Date.parse('2026-07-20T10:00:00Z')
  const withoutShadow = createApp({ autoConnect: false, supabaseClient: activeWriter, now: clock })
  const withShadow = createApp({
    autoConnect: false,
    supabaseClient: activeWriter,
    now: clock,
    v103ShadowRuntime: { enabled: true, async observeTable() {}, async settleRound() {}, snapshot: () => ({ status: 'ok' }) },
  })
  withoutShadow.state.setTables([table])
  withShadow.state.setTables([table])
  const active = JSON.parse((await withoutShadow.inject({ url: '/api/tables' })).body)
  const shadowed = JSON.parse((await withShadow.inject({ url: '/api/tables' })).body)
  assert.deepEqual(shadowed, active)
  assert.equal(shadowed[0].prediction.strategyVersion, 'v102')
})

test('shadow failure is backend-observable but never blocks active settlement, ACK, queue, or formal health', async () => {
  let activeSettlements = 0
  const issued = { ...buildLivePrediction(table), predictionId: 'v102-pid', issuedAt: '2026-07-20T10:00:00Z' }
  const activeWriter = {
    configured: true,
    async issuePrediction() { return issued },
    async readIssuedPrediction() { return issued },
    async persistRound() { activeSettlements += 1; return { prediction: { strategy_version: 'v102' } } },
    getRuntimeStatus() { return { ready: true, degraded: false, reason: null, activeStrategyVersion: 'v102' } },
  }
  const shadow = {
    enabled: true,
    async observeTable() { throw new Error('shadow issuance unavailable') },
    async settleRound() { throw new Error('shadow settlement unavailable') },
    snapshot() { return { status: 'error', error: 'shadow settlement unavailable' } },
  }
  const app = createApp({ autoConnect: false, supabaseClient: activeWriter, v103ShadowRuntime: shadow, controlToken: 'operator-only' })
  app.state.setTables([table])
  await app.inject({ url: '/api/tables' })
  app.state.upsertRoundEvent(final)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(activeSettlements, 1)
  const publicStatus = JSON.parse((await app.inject({ url: '/api/status' })).body)
  const unauthorized = await app.inject({ url: '/api/v103-shadow/status' })
  const status = JSON.parse((await app.inject({ url: '/api/v103-shadow/status', headers: { 'x-control-token': 'operator-only' } })).body)
  const health = JSON.parse((await app.inject({ url: '/health' })).body)
  assert.equal('v103Shadow' in publicStatus, false)
  assert.equal(unauthorized.statusCode, 401)
  assert.equal(status.v103Shadow.status, 'error')
  assert.equal(health.degraded, false)
  assert.equal(health.runtimeStatus.activeStrategyVersion, 'v102')
})
