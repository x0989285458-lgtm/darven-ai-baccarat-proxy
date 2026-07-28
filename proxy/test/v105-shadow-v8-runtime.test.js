import test from 'node:test'
import assert from 'node:assert/strict'

const TABLE_IDS = ['BAG01','BAG02','BAG03','BAG03A','BAG05','BAG06','BAG07','BAG08','BAG09','BAG10']
const table = (tableId = 'BAG01') => ({ tableId, shoe: 105, round: 20, bankerCount: 12, playerCount: 8, bigRoadRaw: 'B#P' })

function writer(history = []) {
  const candidates = []; const settlements = []
  return {
    configured: true, candidates, settlements,
    async getV105ShadowV8History() { return structuredClone(history) },
    async issueV105ShadowV8Prediction(candidate) { candidates.push(structuredClone(candidate)); return { ...candidate, predictionId: `v8-${candidate.targetTableId}-${candidate.targetRound}`, issuedAt: '2026-07-27T10:00:00.000Z' } },
    async readV105ShadowV8Issuance() { return null },
    async settleV105ShadowV8Prediction(settlement) { settlements.push(structuredClone(settlement)); return { predictionId: settlement.predictionId, settlement_sequence: 1 } },
  }
}

test('V8 has its own default-enabled environment switch', async () => {
  const module = await import('../src/v105-shadow-v8-runtime.js')
  assert.equal(module.resolveV105ShadowV8Enabled({}), true)
  assert.equal(module.resolveV105ShadowV8Enabled({ V105_SHADOW_V8_ENABLED: 'false', V105_SHADOW_V7_ENABLED: 'true' }), false)
  assert.equal(module.resolveV105ShadowV8Enabled({ V105_SHADOW_V8_ENABLED: 'true', V105_SHADOW_V7_ENABLED: 'false' }), true)
})

test('V8 independently issues only the fixed ten tables', async () => {
  const { createV105ShadowV8Runtime } = await import('../src/v105-shadow-v8-runtime.js')
  const store = writer(); const runtime = createV105ShadowV8Runtime({ writer: store })
  await Promise.all(TABLE_IDS.map((id) => runtime.observeTable(table(id))))
  assert.deepEqual(store.candidates.map((item) => item.targetTableId), TABLE_IDS)
  assert.equal(await runtime.observeTable(table('BAG04')), null)
  assert.equal(runtime.snapshot().historySource, 'v105_shadow_v8_only')
})

test('V8 restart hydrates only V8 pending issuance and rejects old identities', async () => {
  const { createV105ShadowV8Runtime } = await import('../src/v105-shadow-v8-runtime.js')
  const payload = { source:'ofalive99', strategyVersion:'v105-shadow-v8-run-length-ask-road', releaseCandidate:'v105-shadow-v8-run-length-ask-road', formalStrategyVersion:'v105', predictionTiming:'pre_result_context', shadowOnly:true, activationEligible:false, memberVisible:false, writesSideActions:false, targetTableId:'BAG01', targetShoe:'105', targetRound:21, predictedResult:'banker', sameSideStreak:1 }
  const row = (strategyVersion, id) => ({ prediction_id:id, strategy_version:strategyVersion, prediction_timing:'pre_result_context', prediction_issued_at:'2026-07-27T10:00:00.000Z', settlement_final:false, prediction_payload:{ ...payload, strategyVersion } })
  const store = writer([row('v105-shadow-v7-ask-road','old-v7'), row('v105-shadow-v8-run-length-ask-road','own-v8')])
  const runtime = createV105ShadowV8Runtime({ writer: store })
  assert.equal((await runtime.observeTable(table())).predictionId, 'own-v8')
  assert.equal(store.candidates.length, 0)
  assert.equal(runtime.snapshot().historyRows, 1)
})

test('V8 settles verified Final with its own identity', async () => {
  const { createV105ShadowV8Runtime } = await import('../src/v105-shadow-v8-runtime.js')
  const store = writer(); const runtime = createV105ShadowV8Runtime({ writer: store })
  await runtime.observeTable(table())
  const result = await runtime.settleRound({ ...table(), round:21, sourceAction:'/show_win', winner:'banker', resolvedAt:'2026-07-27T10:00:01.000Z' })
  assert.equal(result.predictionId, 'v8-BAG01-21')
  assert.equal(store.settlements[0].strategyVersion, 'v105-shadow-v8-run-length-ask-road')
  assert.equal(store.settlements[0].settlementFinal, true)
})

test('V8 rejects a conflicting concurrent Final instead of sharing the in-flight settlement', async () => {
  const { createV105ShadowV8Runtime } = await import('../src/v105-shadow-v8-runtime.js')
  let entered
  let release
  const enteredGate = new Promise((resolve) => { entered = resolve })
  const writeGate = new Promise((resolve) => { release = resolve })
  const store = writer()
  let calls = 0
  store.settleV105ShadowV8Prediction = async (settlement) => {
    calls += 1
    store.settlements.push(structuredClone(settlement))
    entered()
    await writeGate
    return { predictionId: settlement.predictionId, settlement_sequence: 1 }
  }
  const runtime = createV105ShadowV8Runtime({ writer: store })
  await runtime.observeTable(table())
  const first = runtime.settleRound({ ...table(), round:21, sourceAction:'/summary', winner:'banker', resolvedAt:'2026-07-27T10:00:01.000Z' })
  await enteredGate
  const conflict = runtime.settleRound({ ...table(), round:21, sourceAction:'/summary', winner:'player', resolvedAt:'2026-07-27T10:00:01.000Z' })
  release()
  await assert.rejects(conflict, /conflicting in-flight Final/)
  await first
  assert.equal(calls, 1)
})

test('V8 bounds pending issuances and live history without losing the newest identities', async () => {
  const { createV105ShadowV8Runtime } = await import('../src/v105-shadow-v8-runtime.js')
  const store = writer()
  const runtime = createV105ShadowV8Runtime({ writer: store, maxPendingIssuances: 2, maxHistoryRows: 3 })
  for (const round of [20, 21, 22, 23]) await runtime.observeTable({ ...table(), round })
  assert.equal(runtime.snapshot().pendingIssuances, 2)
  assert.equal(runtime.snapshot().historyRows, 3)
  assert.deepEqual(store.candidates.slice(-2).map((item) => item.targetRound), [23, 24])
})

test('V8 caps each table at one active plus one queued observation', async () => {
  const { createV105ShadowV8Runtime } = await import('../src/v105-shadow-v8-runtime.js')
  let releaseFirst
  const gate = new Promise((resolve) => { releaseFirst = resolve })
  let calls = 0
  const store = writer()
  store.issueV105ShadowV8Prediction = async (candidate) => {
    calls += 1
    if (calls === 1) await gate
    store.candidates.push(structuredClone(candidate))
    return { ...candidate, predictionId: `v8-${candidate.targetTableId}-${candidate.targetRound}`, issuedAt: '2026-07-27T10:00:00.000Z' }
  }
  const runtime = createV105ShadowV8Runtime({ writer: store, maxQueuedObservationsPerTable: 2 })
  const first = runtime.observeTable({ ...table(), round: 20 })
  const second = runtime.observeTable({ ...table(), round: 21 })
  const rejectedOverflow = runtime.observeTable({ ...table(), round: 22 })
  assert.equal(await rejectedOverflow, null)
  releaseFirst()
  await Promise.all([first, second])
  assert.deepEqual(store.candidates.map((item) => item.targetRound), [21, 22])
})
