import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'
import { buildV105FormalPrediction } from '../src/v105-formal-strategy.js'

const TABLE_IDS = ['BAG01', 'BAG02', 'BAG03', 'BAG03A', 'BAG05', 'BAG06', 'BAG07', 'BAG08', 'BAG09', 'BAG10']
const table = (tableId = 'BAG01') => ({ tableId, shoe: 105, round: 20, sourceUpdatedAt: '2026-07-29T01:00:00.000Z', bankerCount: 12, playerCount: 8, tieCount: 1, beadPlateRaw: '020102010201', bigRoadRaw: 'B#P' })

test('the same ten-table snapshot and verified Final use bounded V9 fan-out with formal, V7, and V8', async () => {
  const seen = { v7: [], v8: [], v9: [] }
  const finals = { v7: 0, v8: 0, v9: 0 }
  const issued = []
  let persisted = 0
  const runtime = (key, fail = false) => ({
    enabled: true,
    async observeTable(value) { seen[key].push(value.tableId); if (fail) throw new Error('expected V9 issuance failure') },
    async settleRound() { finals[key] += 1; if (fail) throw new Error('expected V9 Final failure') },
    snapshot: () => ({ status: fail ? 'error' : 'ready' }),
  })
  const formalRuntime = {
    async start() {},
    async buildPrediction(input) { return buildV105FormalPrediction(input) },
    recordIssuance() {}, recordSettlement() {}, snapshot: () => ({ strategyVersion: 'v105', status: 'ready' }),
  }
  const writer = {
    configured: true,
    async issuePrediction(candidate) { issued.push(candidate.targetTableId); return { ...candidate, predictionId: `formal-${candidate.targetTableId}`, issuedAt: '2026-07-29T01:00:01.000Z' } },
    async readIssuedPrediction() { return null },
    async persistRound() { persisted += 1; return { prediction: { strategy_version: 'v105', predicted_result: 'banker', settlement_final: true, resolved_at: '2026-07-29T01:00:02.000Z' } } },
  }
  const app = createApp({
    autoConnect: false, requireVerifiedStrategy: false, memberAuthRequired: false,
    supabaseClient: writer, v104FormalRuntime: formalRuntime,
    v105ShadowV7Runtime: runtime('v7'), v105ShadowV8Runtime: runtime('v8'), v105ShadowV9Runtime: runtime('v9', true),
  })
  app.state.setTables(TABLE_IDS.map(table))
  await app.waitForServiceWorkIdle()
  await app.state.upsertRoundEvent({ ...table(), round: 21, sourceAction: '/summary', winner: 'banker', rawResult: [1, 9, 2, 10, 0, 0, -1, -1, 3, 9] })
  await app.waitForServiceWorkIdle()
  assert.deepEqual(seen.v7, TABLE_IDS)
  assert.deepEqual(seen.v8, TABLE_IDS)
  assert.equal(finals.v7, 1)
  assert.equal(finals.v8, 1)
  assert.deepEqual(issued, TABLE_IDS)
  assert.equal(persisted, 1)
  assert.deepEqual(seen.v9, TABLE_IDS)
  assert.equal(finals.v9, 1)
})
