import test from 'node:test'
import assert from 'node:assert/strict'

const VERSION = 'v105-shadow-v10-uncommon-road-structure'
const TABLE_IDS = ['BAG01', 'BAG02', 'BAG03', 'BAG03A', 'BAG05', 'BAG06', 'BAG07', 'BAG08', 'BAG09', 'BAG10']
const table = (tableId = 'BAG01', round = 20) => ({
  tableId, shoe: 105, round, bankerCount: 12, playerCount: 8,
  beadPlateRaw: '020102010201', bigRoadRaw: 'B#P#B#P#B#P',
})

function writer(history = []) {
  const candidates = []
  const settlements = []
  const reads = []
  return {
    configured: true, candidates, settlements, reads,
    async getV105ShadowV10History() { return structuredClone(history) },
    async issueV105ShadowV10Prediction(candidate) {
      candidates.push(structuredClone(candidate))
      return { ...candidate, predictionId: `v10-${candidate.targetTableId}-${candidate.targetRound}`, issuedAt: '2026-08-02T01:00:00.000Z' }
    },
    async readV105ShadowV10Issuance(identity) { reads.push(structuredClone(identity)); return null },
    async settleV105ShadowV10Prediction(settlement) {
      settlements.push(structuredClone(settlement))
      return { predictionId: settlement.predictionId, settlement_sequence: 1 }
    },
  }
}

test('V10 has an independent default-enabled runtime switch', async () => {
  const { resolveV105ShadowV10Enabled } = await import('../src/v105-shadow-v10-runtime.js')
  assert.equal(resolveV105ShadowV10Enabled({}), true)
  assert.equal(resolveV105ShadowV10Enabled({ V105_SHADOW_V10_ENABLED: 'false', V105_SHADOW_V9_ENABLED: 'true' }), false)
  assert.equal(resolveV105ShadowV10Enabled({ V105_SHADOW_V10_ENABLED: 'true', V105_SHADOW_V9_ENABLED: 'false' }), true)
})

test('V10 independently issues only the fixed ten tables', async () => {
  const { createV105ShadowV10Runtime } = await import('../src/v105-shadow-v10-runtime.js')
  const store = writer()
  const runtime = createV105ShadowV10Runtime({ writer: store })
  await Promise.all(TABLE_IDS.map((tableId) => runtime.observeTable(table(tableId))))
  assert.deepEqual(store.candidates.map((candidate) => candidate.targetTableId), TABLE_IDS)
  assert.equal(await runtime.observeTable(table('BAG04')), null)
  assert.equal(runtime.snapshot().historySource, 'v105_shadow_v10_only')
})

test('V10 restart hydrates only its own compact history and never rebuilds pending issuance', async () => {
  const { createV105ShadowV10Runtime } = await import('../src/v105-shadow-v10-runtime.js')
  const row = (strategyVersion, predictionId, settlementFinal = true) => ({
    prediction_id: predictionId, source: 'ofalive99', table_id: 'BAG01', shoe_no: '105', round_no: 20,
    strategy_version: strategyVersion, prediction_timing: 'pre_result_context', prediction_issued_at: '2026-08-02T01:00:00.000Z',
    predicted_result: 'banker', same_side_streak: 7, actual_result: settlementFinal ? 'player' : null, settlement_final: settlementFinal,
  })
  const store = writer([
    row('v105-shadow-v9-weighted-v7-v8', 'old-v9'),
    row(VERSION, 'own-final'),
    row(VERSION, 'own-pending', false),
  ])
  const runtime = createV105ShadowV10Runtime({ writer: store })
  assert.equal(runtime.snapshot().pendingIssuances, 0)
  const issued = await runtime.observeTable(table())
  assert.equal(issued.predictionId, 'v10-BAG01-21')
  assert.equal(store.candidates[0].sameSideStreak, 8)
  assert.equal(runtime.snapshot().historyRows, 2)
  assert.equal(runtime.snapshot().pendingIssuances, 1)
})

test('V10 bounds each table observation queue without blocking other tables', async () => {
  const { createV105ShadowV10Runtime } = await import('../src/v105-shadow-v10-runtime.js')
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const store = writer()
  const originalIssue = store.issueV105ShadowV10Prediction
  store.issueV105ShadowV10Prediction = async (candidate) => { await gate; return originalIssue(candidate) }
  const runtime = createV105ShadowV10Runtime({ writer: store, maxQueuedObservationsPerTable: 2 })
  const first = runtime.observeTable(table('BAG01', 20))
  const second = runtime.observeTable(table('BAG01', 21))
  const third = runtime.observeTable(table('BAG01', 22))
  await assert.rejects(
    runtime.observeTable(table('BAG01', 23)),
    (error) => error.code === 'SHADOW_RUNTIME_QUEUE_FULL' && /queue is full/i.test(error.message),
  )
  const otherTable = runtime.observeTable(table('BAG02', 20))
  assert.equal(runtime.snapshot().queuedObservations, 4)
  assert.equal(runtime.snapshot().rejectedObservations, 1)
  release()
  await Promise.all([first, second, third, otherTable])
  assert.deepEqual(
    store.candidates.filter((candidate) => candidate.targetTableId === 'BAG01').map((candidate) => candidate.targetRound),
    [21, 22, 23],
  )
  assert.equal(store.candidates.some((candidate) => candidate.targetTableId === 'BAG02'), true)
})

test('V10 keeps issuance immutable and deduplicates the same Final while rejecting a conflicting in-flight Final', async () => {
  const { createV105ShadowV10Runtime } = await import('../src/v105-shadow-v10-runtime.js')
  let releaseSettlement
  const settlementGate = new Promise((resolve) => { releaseSettlement = resolve })
  const store = writer()
  const originalSettle = store.settleV105ShadowV10Prediction
  store.settleV105ShadowV10Prediction = async (settlement) => { await settlementGate; return originalSettle(settlement) }
  const runtime = createV105ShadowV10Runtime({ writer: store })
  const issued = await runtime.observeTable(table())
  assert.equal(Object.isFrozen(issued), true)
  assert.throws(() => { issued.predictedResult = 'player' }, TypeError)
  const final = { ...table('BAG01', 21), sourceAction: '/summary', winner: 'banker', rawResult: [1, 9, 2, 10, 0, 0, -1, -1, 3, 9] }
  const first = runtime.settleRound(final)
  const duplicate = runtime.settleRound(structuredClone(final))
  await assert.rejects(runtime.settleRound({ ...final, winner: 'player' }), /conflicting in-flight Final/i)
  releaseSettlement()
  const [firstResult, duplicateResult] = await Promise.all([first, duplicate])
  assert.deepEqual(firstResult, duplicateResult)
  assert.equal(store.settlements.length, 1)
  assert.equal(store.settlements[0].strategyVersion, VERSION)
  assert.equal(store.settlements[0].settlementFinal, true)
})

test('V10 restart settlement reads only the immutable V10 issuance identity', async () => {
  const { createV105ShadowV10Runtime } = await import('../src/v105-shadow-v10-runtime.js')
  const store = writer()
  const issuedPrediction = {
    ...(await import('../src/v105-shadow-v10-contract.js')).buildV105ShadowV10Prediction(table()),
    predictionId: 'v10-read-id', issuedAt: '2026-08-02T01:00:00.000Z',
  }
  store.readV105ShadowV10Issuance = async (identity) => { store.reads.push(identity); return issuedPrediction }
  const runtime = createV105ShadowV10Runtime({ writer: store })
  await runtime.settleRound({ ...table('BAG01', 21), sourceAction: '/show_win', winner: 'banker', rawResult: [1, 9, 2, 10, 0, 0, -1, -1, 3, 9] })
  assert.deepEqual(store.reads, [{ source: 'ofalive99', tableId: 'BAG01', shoe: 105, round: 21 }])
  assert.equal(store.settlements[0].predictionId, 'v10-read-id')
})
