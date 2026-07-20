import test from 'node:test'
import assert from 'node:assert/strict'
import { createV104ShadowRuntime } from '../src/v104-shadow-runtime.js'

const table = (overrides = {}) => ({
  tableId: 'BAG08', shoe: 104, round: 20,
  bankerCount: 12, playerCount: 8,
  beadPlateRaw: '222221', bigRoadRaw: '222221',
  nextBankerRaw: '', nextPlayerRaw: '',
  ...overrides,
})

function createWriter(history = []) {
  const candidates = []
  const settlements = []
  const durable = new Map()
  return {
    configured: true, candidates, settlements, durable,
    async getV104ShadowHistory() { return structuredClone(history) },
    async issueV104ShadowPrediction(candidate) {
      candidates.push(structuredClone(candidate))
      const issued = { ...candidate, predictionId: `pid-${candidate.targetShoe}-${candidate.targetRound}`, issuedAt: '2026-07-21T10:00:00Z' }
      durable.set(`${candidate.targetShoe}:${candidate.targetRound}`, issued)
      return issued
    },
    async readV104ShadowIssuance({ shoe, round }) { return durable.get(`${shoe}:${round}`) ?? null },
    async settleV104ShadowPrediction(settlement) { settlements.push(structuredClone(settlement)); return { predictionId: settlement.predictionId, duplicate: false } },
  }
}

test('v104 runtime hydrates issuance streaks before predicting and tracks pre-result directions per table and shoe', async () => {
  const history = Array.from({ length: 4 }, (_, index) => ({
    source: 'ofalive99', table_id: 'BAG08', shoe_no: '104', round_no: 17 + index,
    strategy_version: 'v104', prediction_timing: 'pre_result_context',
    prediction_issued_at: `2026-07-21T10:0${index}:00Z`, predicted_result: 'banker',
  }))
  const writer = createWriter(history)
  const runtime = createV104ShadowRuntime({ enabled: true, writer })
  const issued = await runtime.observeTable(table())

  assert.equal(issued.lockRisk, true)
  assert.equal(issued.shoeBiasSuppressed, true)
  assert.equal(runtime.snapshot().historySource, 'v104_shadow_issuance_and_final')
})

test('v104 runtime resets same-side issuance tracking when shoe changes', async () => {
  const writer = createWriter()
  const runtime = createV104ShadowRuntime({ enabled: true, writer })
  for (let round = 20; round < 24; round += 1) await runtime.observeTable(table({ round }))
  const fresh = await runtime.observeTable(table({ shoe: 105, round: 0, bankerCount: 0, playerCount: 0 }))
  assert.equal(fresh.sameSideStreak, 1)
  assert.equal(fresh.shoeBiasSuppressed, false)
})

test('v104 restart rehydrates an unsettled immutable issuance instead of recomputing the same target', async () => {
  const payload = {
    source: 'ofalive99', strategyVersion: 'v104', predictionTiming: 'pre_result_context',
    targetTableId: 'BAG08', targetShoe: '104', targetRound: 21,
    predictedResult: 'banker', confidence: 48, sameSideStreak: 4,
    independentSupportCount: 2, shoeBiasSuppressed: false, lockRisk: false,
  }
  const history = [{
    prediction_id: 'persisted-v104-21', source: 'ofalive99', table_id: 'BAG08',
    shoe_no: '104', round_no: 21, strategy_version: 'v104',
    prediction_timing: 'pre_result_context', prediction_issued_at: '2026-07-21T10:04:00Z',
    predicted_result: 'banker', settlement_final: false, prediction_payload: payload,
  }]
  const writer = createWriter(history)
  const runtime = createV104ShadowRuntime({ enabled: true, writer })
  const issued = await runtime.observeTable(table({ round: 20 }))
  assert.equal(issued.predictionId, 'persisted-v104-21')
  assert.equal(issued.sameSideStreak, 4)
  assert.equal(writer.candidates.length, 0)
})

test('v104 restart hydration resets streak across missing round gaps', async () => {
  const history = [17, 19].map((round) => ({
    source: 'ofalive99', table_id: 'BAG08', shoe_no: '104', round_no: round,
    strategy_version: 'v104', prediction_timing: 'pre_result_context',
    prediction_issued_at: `2026-07-21T10:${round}:00Z`, predicted_result: 'banker',
  }))
  const writer = createWriter(history)
  const runtime = createV104ShadowRuntime({ enabled: true, writer })
  const issued = await runtime.observeTable(table({
    round: 19, bankerCount: 20, playerCount: 0,
    beadPlateRaw: '222222', bigRoadRaw: '222222', nextBankerRaw: '2', nextPlayerRaw: '1',
  }))
  assert.equal(issued.predictedResult, 'banker')
  assert.equal(issued.sameSideStreak, 2)
})

test('v104 serializes concurrent same-table issuances before deriving the next streak', async () => {
  const writer = createWriter()
  const originalIssue = writer.issueV104ShadowPrediction.bind(writer)
  let releaseFirst
  let firstStarted
  const started = new Promise((resolve) => { firstStarted = resolve })
  const gate = new Promise((resolve) => { releaseFirst = resolve })
  writer.issueV104ShadowPrediction = async (candidate) => {
    if (candidate.targetRound === 21) {
      firstStarted()
      await gate
    }
    return originalIssue(candidate)
  }
  const runtime = createV104ShadowRuntime({ enabled: true, writer })
  const strongBanker = {
    bankerCount: 20, playerCount: 0,
    beadPlateRaw: '222222', bigRoadRaw: '222222', nextBankerRaw: '2', nextPlayerRaw: '1',
  }
  const firstPromise = runtime.observeTable(table({ ...strongBanker, round: 20 }))
  await started
  const secondPromise = runtime.observeTable(table({ ...strongBanker, round: 21 }))
  releaseFirst()
  const [first, second] = await Promise.all([firstPromise, secondPromise])
  assert.equal(first.predictedResult, 'banker')
  assert.equal(second.predictedResult, 'banker')
  assert.equal(first.sameSideStreak, 1)
  assert.equal(second.sameSideStreak, 2)
})

test('v104 first complete issuance wins and identical replay is idempotent', async () => {
  const writer = createWriter()
  const runtime = createV104ShadowRuntime({ enabled: true, writer })
  const first = await runtime.observeTable(table())
  assert.deepEqual(await runtime.observeTable(table()), first)
  assert.equal(writer.candidates.length, 1)
})

test('v104 settles only verified Final identity and tie remains PUSH', async () => {
  const writer = createWriter()
  const runtime = createV104ShadowRuntime({ enabled: true, writer })
  await runtime.observeTable(table())
  const result = await runtime.settleRound({ ...table(), round: 21, sourceAction: '/show_win', winner: 'tie' })
  assert.equal(result.predictionId, 'pid-104-21')
  assert.equal(writer.settlements[0].settlementStatus, 'push')
  assert.equal(writer.settlements[0].isHit, null)
  await assert.rejects(runtime.settleRound({ ...table(), round: 22, sourceAction: '/show_poker', winner: 'banker' }), /immutable issuance|verified Final/i)
})

test('v104 pending issuances remain bounded and evicted identity hydrates from DB for settlement', async () => {
  const writer = createWriter()
  const runtime = createV104ShadowRuntime({ enabled: true, writer, maxPendingIssuances: 2 })
  await runtime.observeTable(table({ round: 20 }))
  await runtime.observeTable(table({ round: 21 }))
  await runtime.observeTable(table({ round: 22 }))
  assert.equal(runtime.snapshot().pendingIssuances, 2)
  const result = await runtime.settleRound({ ...table(), round: 21, sourceAction: '/summary', winner: 'banker' })
  assert.equal(result.predictionId, 'pid-104-21')
})

test('v104 hanging RPC times out into its own observable error', async () => {
  const writer = createWriter()
  writer.issueV104ShadowPrediction = async () => new Promise(() => {})
  const runtime = createV104ShadowRuntime({ enabled: true, writer, requestTimeoutMs: 10 })
  await assert.rejects(runtime.observeTable(table()), /timed out/i)
  assert.equal(runtime.snapshot().status, 'error')
  assert.match(runtime.snapshot().error, /timed out/i)
})
