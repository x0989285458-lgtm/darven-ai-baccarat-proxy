import test from 'node:test'
import assert from 'node:assert/strict'

const VERSION = 'v105-shadow-v9-weighted-v7-v8'
const TABLE_IDS = ['BAG01', 'BAG02', 'BAG03', 'BAG03A', 'BAG05', 'BAG06', 'BAG07', 'BAG08', 'BAG09', 'BAG10']
const table = (tableId = 'BAG01') => ({ tableId, shoe: 105, round: 20, bankerCount: 12, playerCount: 8, bigRoadRaw: 'B#P' })

function writer(history = []) {
  const candidates = []
  const settlements = []
  return {
    configured: true, candidates, settlements,
    async getV105ShadowV9History() { return structuredClone(history) },
    async issueV105ShadowV9Prediction(candidate) {
      candidates.push(structuredClone(candidate))
      return { ...candidate, predictionId: `v9-${candidate.targetTableId}-${candidate.targetRound}`, issuedAt: '2026-07-29T01:00:00.000Z' }
    },
    async readV105ShadowV9Issuance() { return null },
    async settleV105ShadowV9Prediction(settlement) {
      settlements.push(structuredClone(settlement))
      return { predictionId: settlement.predictionId, settlement_sequence: 1 }
    },
  }
}

test('V9 has an independent default-enabled runtime switch', async () => {
  const { resolveV105ShadowV9Enabled } = await import('../src/v105-shadow-v9-runtime.js')
  assert.equal(resolveV105ShadowV9Enabled({}), true)
  assert.equal(resolveV105ShadowV9Enabled({ V105_SHADOW_V9_ENABLED: 'false', V105_SHADOW_V8_ENABLED: 'true' }), false)
  assert.equal(resolveV105ShadowV9Enabled({ V105_SHADOW_V9_ENABLED: 'true', V105_SHADOW_V8_ENABLED: 'false' }), true)
})

test('V9 independently issues only the fixed ten tables', async () => {
  const { createV105ShadowV9Runtime } = await import('../src/v105-shadow-v9-runtime.js')
  const store = writer()
  const runtime = createV105ShadowV9Runtime({ writer: store })
  await Promise.all(TABLE_IDS.map((tableId) => runtime.observeTable(table(tableId))))
  assert.deepEqual(store.candidates.map((candidate) => candidate.targetTableId), TABLE_IDS)
  assert.equal(await runtime.observeTable(table('BAG04')), null)
  assert.equal(runtime.snapshot().historySource, 'v105_shadow_v9_only')
})

test('V9 restart hydrates only its own history and rejects old identities', async () => {
  const { createV105ShadowV9Runtime } = await import('../src/v105-shadow-v9-runtime.js')
  const payload = { source: 'ofalive99', strategyVersion: VERSION, releaseCandidate: VERSION, formalStrategyVersion: 'v105', predictionTiming: 'pre_result_context', shadowOnly: true, activationEligible: false, memberVisible: false, writesSideActions: false, targetTableId: 'BAG01', targetShoe: '105', targetRound: 21, predictedResult: 'banker', sameSideStreak: 1 }
  const row = (strategyVersion, predictionId) => ({ prediction_id: predictionId, strategy_version: strategyVersion, prediction_timing: 'pre_result_context', prediction_issued_at: '2026-07-29T01:00:00.000Z', settlement_final: false, prediction_payload: { ...payload, strategyVersion } })
  const store = writer([
    row('v105-shadow-v7-ask-road', 'old-v7'),
    row('v105-shadow-v8-run-length-ask-road', 'old-v8'),
    row(VERSION, 'own-v9'),
  ])
  const runtime = createV105ShadowV9Runtime({ writer: store })
  assert.equal((await runtime.observeTable(table())).predictionId, 'own-v9')
  assert.equal(store.candidates.length, 0)
  assert.equal(runtime.snapshot().historyRows, 1)
})

test('V9 settles verified Final through only the V9 writer', async () => {
  const { createV105ShadowV9Runtime } = await import('../src/v105-shadow-v9-runtime.js')
  const store = writer()
  const runtime = createV105ShadowV9Runtime({ writer: store })
  await runtime.observeTable(table())
  await runtime.settleRound({ ...table(), round: 21, sourceAction: '/show_win', winner: 'banker', rawResult: [1, 9, 2, 10, 0, 0, -1, -1, 3, 9] })
  assert.equal(store.settlements.length, 1)
  assert.equal(store.settlements[0].strategyVersion, VERSION)
  assert.equal(store.settlements[0].settlementFinal, true)
})
