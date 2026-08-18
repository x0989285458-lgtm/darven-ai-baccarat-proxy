import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'
import { buildV106FormalPrediction } from '../src/v106-formal-strategy.js'

const TABLE_IDS = ['BAG01', 'BAG02', 'BAG03', 'BAG03A', 'BAG05', 'BAG06', 'BAG07', 'BAG08', 'BAG09', 'BAG10']
const table = (tableId = 'BAG01') => ({
  tableId, shoe: 105, round: 20, sourceUpdatedAt: '2026-08-02T01:00:00.000Z',
  bankerCount: 12, playerCount: 8, tieCount: 1, beadPlateRaw: '020102010201', bigRoadRaw: 'B#P#B#P#B#P',
})

test('v106 formal keeps V9 isolated while the promoted V10 shadow lane is stopped', async () => {
  const seen = { v9: [], v10: [] }
  const finals = { v9: 0, v10: 0 }
  const issued = []
  let persisted = 0
  const runtime = (key, fail = false) => ({
    enabled: true,
    async observeTable(value) { seen[key].push(value.tableId); if (fail) throw new Error('expected V10 issuance failure') },
    async settleRound() { finals[key] += 1; if (fail) throw new Error('expected V10 Final failure') },
    snapshot: () => ({ status: fail ? 'error' : 'ready' }),
  })
  const formalRuntime = {
    async start() {},
    async buildPrediction(input) { return buildV106FormalPrediction(input) },
    recordIssuance() {}, recordSettlement() {}, snapshot: () => ({ strategyVersion: 'v106', status: 'ready' }),
  }
  const writer = {
    configured: true,
    async issuePrediction(candidate) { issued.push(candidate.targetTableId); return { ...candidate, predictionId: `formal-${candidate.targetTableId}`, issuedAt: '2026-08-02T01:00:01.000Z' } },
    async readIssuedPrediction() { return null },
    async persistRound() { persisted += 1; return { prediction: { strategy_version: 'v106', predicted_result: 'banker', settlement_final: true, resolved_at: '2026-08-02T01:00:02.000Z' } } },
  }
  const app = createApp({
    autoConnect: false, requireVerifiedStrategy: false, memberAuthRequired: false,
    supabaseClient: writer, v104FormalRuntime: formalRuntime,
    v105ShadowV9Runtime: runtime('v9'), v105ShadowV10Runtime: runtime('v10', true),
  })
  app.state.setTables(TABLE_IDS.map(table))
  await app.waitForServiceWorkIdle()
  await app.state.upsertRoundEvent({ ...table(), round: 21, sourceAction: '/summary', winner: 'banker', rawResult: [1, 9, 2, 10, 0, 0, -1, -1, 3, 9] })
  await app.waitForServiceWorkIdle()
  assert.deepEqual(seen.v9, TABLE_IDS)
  assert.equal(finals.v9, 1)
  assert.deepEqual(seen.v10, [])
  assert.equal(finals.v10, 0)
  assert.deepEqual(issued, TABLE_IDS)
  assert.equal(persisted, 1)
})

test('v106 formal stops an injected isolated V10 lane and never prepares it', async (t) => {
  let v10PrepareCalls = 0
  let v10StopCalls = 0
  const disabled = { enabled: 0, prepared: 0, pending: 0, queued: 0, failed: 0, disabled: 1 }
  const shadowProcessClient = {
    async prepareRequired() { return disabled },
    async prepareV9() { return disabled },
    async prepareV10() { v10PrepareCalls += 1; return disabled },
    async stopV10() { v10StopCalls += 1 },
    runtime: () => ({ enabled: false, snapshot: () => ({ status: 'disabled' }) }),
    async processCapture() {},
    status: () => ({ running: false, v105V10: { enabled: false, running: false } }),
    beginStop() {},
    async stop() {},
  }
  const app = createApp({
    autoConnect: false,
    port: 0,
    host: '127.0.0.1',
    requireVerifiedStrategy: false,
    memberAuthRequired: false,
    isolateShadowProcess: true,
    shadowProcessClient,
    supabaseClient: { configured: false },
  })
  t.after(() => app.stop())
  await app.start()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(v10StopCalls, 1)
  assert.equal(v10PrepareCalls, 0)
})
