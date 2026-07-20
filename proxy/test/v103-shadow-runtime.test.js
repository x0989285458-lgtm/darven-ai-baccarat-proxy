import test from 'node:test'
import assert from 'node:assert/strict'
import { createV103ShadowRuntime } from '../src/v103-shadow-runtime.js'

const table = { tableId: 'BAG01', shoe: 103, round: 20, bankerCount: 12, playerCount: 8 }

test('shadow runtime rehydrates only through the dedicated v103 Final history reader before issuance', async () => {
  const calls = []
  const writer = {
    configured: true,
    async getV103ShadowHistory() { calls.push('hydrate'); return [] },
    async issueV103ShadowPrediction(candidate) { calls.push('issue'); return { ...candidate, predictionId: 'pid-103', issuedAt: '2026-07-20T10:00:00Z' } },
  }
  const runtime = createV103ShadowRuntime({ enabled: true, writer })
  await runtime.observeTable(table)
  assert.deepEqual(calls, ['hydrate', 'issue'])
  assert.equal(runtime.snapshot().historySource, 'v103_shadow_final_only')
})

test('first complete issuance wins, identical replay is idempotent, and conflict fails closed', async () => {
  let first
  const writer = {
    configured: true,
    async getV103ShadowHistory() { return [] },
    async issueV103ShadowPrediction(candidate) {
      if (!first) first = { ...candidate, predictionId: 'pid-103', issuedAt: '2026-07-20T10:00:00Z' }
      if (candidate.predictedResult !== first.predictedResult) throw new Error('conflicting v103 shadow issuance')
      return structuredClone(first)
    },
  }
  const runtime = createV103ShadowRuntime({ enabled: true, writer })
  const issued = await runtime.observeTable(table)
  assert.deepEqual(await runtime.observeTable(table), issued)
  await assert.rejects(writer.issueV103ShadowPrediction({ ...issued, predictedResult: issued.predictedResult === 'banker' ? 'player' : 'banker' }), /conflicting/)
})

test('settlement attaches only to the same issued identity and identical Final replay stays idempotent', async () => {
  const settlements = []
  const writer = {
    configured: true,
    async getV103ShadowHistory() { return [] },
    async issueV103ShadowPrediction(candidate) { return { ...candidate, predictionId: 'pid-103', issuedAt: '2026-07-20T10:00:00Z' } },
    async readV103ShadowIssuance() { return null },
    async settleV103ShadowPrediction(settlement) { settlements.push(settlement); return { predictionId: settlement.predictionId, duplicate: settlements.length > 1 } },
  }
  const runtime = createV103ShadowRuntime({ enabled: true, writer })
  await runtime.observeTable(table)
  const round = { ...table, round: 21, sourceAction: '/summary', winner: 'tie' }
  assert.equal((await runtime.settleRound(round)).duplicate, false)
  assert.equal((await runtime.settleRound(round)).duplicate, true)
  assert.equal(settlements[0].settlementStatus, 'push')
  assert.equal(settlements[0].predictionId, 'pid-103')
  assert.equal(runtime.snapshot().pendingIssuances, 0)
})

test('a settled Final immediately feeds the same table calibration without requiring restart', async () => {
  const candidates = []
  const writer = {
    configured: true,
    async getV103ShadowHistory() { return [] },
    async issueV103ShadowPrediction(candidate) {
      candidates.push(structuredClone(candidate))
      return { ...candidate, predictionId: `pid-${candidate.targetRound}`, issuedAt: '2026-07-20T10:00:00Z' }
    },
    async settleV103ShadowPrediction(settlement) { return { predictionId: settlement.predictionId, duplicate: false } },
  }
  const runtime = createV103ShadowRuntime({ enabled: true, writer })
  const strongBanker = { ...table, bankerCount: 20, playerCount: 0 }
  const first = await runtime.observeTable(strongBanker)
  assert.equal(first.predictedResult, 'banker')
  await runtime.settleRound({ ...strongBanker, round: 21, sourceAction: '/summary', winner: 'banker' })
  await runtime.observeTable({ ...strongBanker, round: 21 })
  assert.equal(candidates[1].calibration.direction, 'banker')
  assert.equal(candidates[1].calibration.sampleCount, 1)
})

test('pending shadow issuances are bounded and an evicted identity can settle from DB after Final', async () => {
  const durable = new Map()
  const writer = {
    configured: true,
    async getV103ShadowHistory() { return [] },
    async issueV103ShadowPrediction(candidate) {
      const issued = { ...candidate, predictionId: `pid-${candidate.targetRound}`, issuedAt: '2026-07-20T10:00:00Z' }
      durable.set(candidate.targetRound, issued)
      return issued
    },
    async readV103ShadowIssuance({ round }) { return durable.get(round) ?? null },
    async settleV103ShadowPrediction(settlement) { return { predictionId: settlement.predictionId, duplicate: false } },
  }
  const runtime = createV103ShadowRuntime({ enabled: true, writer, maxPendingIssuances: 2 })
  await runtime.observeTable({ ...table, round: 20 })
  await runtime.observeTable({ ...table, round: 21 })
  await runtime.observeTable({ ...table, round: 22 })
  assert.equal(runtime.snapshot().pendingIssuances, 2)
  const result = await runtime.settleRound({ ...table, round: 21, sourceAction: '/summary', winner: 'banker' })
  assert.equal(result.predictionId, 'pid-21')
})

test('a hanging shadow RPC times out into observable error without waiting forever', async () => {
  const writer = {
    configured: true,
    async getV103ShadowHistory() { return [] },
    async issueV103ShadowPrediction() { return new Promise(() => {}) },
  }
  const runtime = createV103ShadowRuntime({ enabled: true, writer, requestTimeoutMs: 10 })
  await assert.rejects(runtime.observeTable(table), /timed out/i)
  assert.equal(runtime.snapshot().status, 'error')
  assert.match(runtime.snapshot().error, /timed out/i)
})
