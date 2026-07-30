import test from 'node:test'
import assert from 'node:assert/strict'

const TABLE_IDS = ['BAG01','BAG02','BAG03','BAG03A','BAG05','BAG06','BAG07','BAG08','BAG09','BAG10']
const table = (tableId = 'BAG01') => ({ tableId, shoe: 105, round: 20, bankerCount: 12, playerCount: 8, bigRoadRaw: 'B#P' })

function writer(history = []) {
  const candidates = []
  const settlements = []
  return {
    configured: true, candidates, settlements,
    async getV105ShadowV7History() { return structuredClone(history) },
    async issueV105ShadowV7Prediction(candidate) {
      candidates.push(structuredClone(candidate))
      return { ...candidate, predictionId: `v7-${candidate.targetTableId}-${candidate.targetRound}`, issuedAt: '2026-07-27T10:00:00.000Z' }
    },
    async readV105ShadowV7Issuance() { return null },
    async settleV105ShadowV7Prediction(settlement) {
      settlements.push(structuredClone(settlement))
      return { predictionId: settlement.predictionId, settlement_sequence: 1 }
    },
  }
}

test('V7 has its own default-enabled environment switch', async () => {
  const module = await import('../src/v105-shadow-v7-runtime.js')
  assert.equal(module.resolveV105ShadowV7Enabled({}), true)
  assert.equal(module.resolveV105ShadowV7Enabled({ V105_SHADOW_V7_ENABLED: 'false', V105_SHADOW_V6_ENABLED: 'true' }), false)
  assert.equal(module.resolveV105ShadowV7Enabled({ V105_SHADOW_V7_ENABLED: 'true', V105_SHADOW_V6_ENABLED: 'false' }), true)
})

test('V7 independently issues the fixed ten tables and no others', async () => {
  const { createV105ShadowV7Runtime } = await import('../src/v105-shadow-v7-runtime.js')
  const store = writer()
  const runtime = createV105ShadowV7Runtime({ writer: store })
  await Promise.all(TABLE_IDS.map((id) => runtime.observeTable(table(id))))
  assert.deepEqual(store.candidates.map((item) => item.targetTableId), TABLE_IDS)
  assert.equal(await runtime.observeTable(table('BAG04')), null)
  assert.equal(runtime.snapshot().historySource, 'v105_shadow_v7_only')
})

test('V7 restart hydrates only its own Final compact streak and never rebuilds pending issuance', async () => {
  const { createV105ShadowV7Runtime } = await import('../src/v105-shadow-v7-runtime.js')
  const row = (strategyVersion, id) => ({
    prediction_id: id, source: 'ofalive99', table_id: 'BAG01', shoe_no: '105', round_no: 20,
    strategy_version: strategyVersion, prediction_timing: 'pre_result_context',
    prediction_issued_at: '2026-07-27T10:00:00.000Z', predicted_result: 'banker', same_side_streak: 7,
    actual_result: 'player', settlement_final: true,
  })
  const store = writer([row('v105-shadow-v6-road-pattern', 'old-v6'), row('v105-shadow-v7-ask-road', 'own-v7')])
  const runtime = createV105ShadowV7Runtime({ writer: store })
  assert.equal(runtime.snapshot().pendingIssuances, 0)
  assert.equal((await runtime.observeTable(table())).predictionId, 'v7-BAG01-21')
  assert.equal(store.candidates[0].sameSideStreak, 8)
  assert.equal(runtime.snapshot().historyRows, 2)
})

test('V7 settles verified summary/show_win Final without sharing formal or V6 state', async () => {
  const { createV105ShadowV7Runtime } = await import('../src/v105-shadow-v7-runtime.js')
  const store = writer()
  const runtime = createV105ShadowV7Runtime({ writer: store })
  await runtime.observeTable(table())
  const result = await runtime.settleRound({ ...table(), round: 21, sourceAction: '/show_win', winner: 'banker', resolvedAt: '2026-07-27T10:00:01.000Z' })
  assert.equal(result.predictionId, 'v7-BAG01-21')
  assert.equal(store.settlements[0].strategyVersion, 'v105-shadow-v7-ask-road')
  assert.equal(store.settlements[0].settlementFinal, true)
})
