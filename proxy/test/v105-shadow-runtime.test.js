import test from 'node:test'
import assert from 'node:assert/strict'

const table = (overrides = {}) => ({
  tableId: 'BAG01', shoe: 105, round: 20,
  bankerCount: 12, playerCount: 8,
  beadPlateRaw: '222221', bigRoadRaw: '222221',
  nextBankerRaw: '', nextPlayerRaw: '',
  ...overrides,
})

function writer(history = []) {
  const candidates = []
  const settlements = []
  return {
    configured: true, candidates, settlements,
    async getV105ShadowHistory() { return structuredClone(history) },
    async issueV105ShadowPrediction(candidate) {
      candidates.push(structuredClone(candidate))
      return { ...candidate, predictionId: `v105-shadow-${candidate.targetTableId}-${candidate.targetRound}`, issuedAt: '2026-07-27T10:00:00.000Z' }
    },
    async readV105ShadowIssuance() { return null },
    async settleV105ShadowPrediction(settlement) {
      settlements.push(structuredClone(settlement))
      return { predictionId: settlement.predictionId, settlement_sequence: 1, duplicate: false }
    },
  }
}

test('v105 shadow V6 uses its own enable setting and ignores the retired generic setting', async () => {
  const module = await import('../src/v105-shadow-runtime.js')
  assert.equal(module.resolveV105ShadowEnabled({ V105_SHADOW_V6_ENABLED: 'false', V105_SHADOW_ENABLED: 'true' }), false)
  assert.equal(module.resolveV105ShadowEnabled({ V105_SHADOW_V6_ENABLED: 'true', V105_SHADOW_ENABLED: 'false' }), true)
})

test('v105 shadow V6 issues for the fixed formal ten-table allowlist and ignores every other table', async () => {
  const module = await import('../src/v105-shadow-runtime.js').catch(() => null)
  assert.ok(module, 'v105 shadow runtime must exist')
  const store = writer()
  const runtime = module.createV105ShadowRuntime({ enabled: true, writer: store })
  const issued = await runtime.observeTable(table())
  assert.equal(issued.strategyVersion, 'v105-shadow-v6-road-pattern')
  assert.equal(store.candidates.length, 1)
  assert.equal(await runtime.observeTable(table({ tableId: 'BAG04' })), null)
  assert.equal(store.candidates.length, 1)
})

test('v105 shadow V6 keeps the issued road-pattern evidence deeply immutable after writer roundtrip', async () => {
  const module = await import('../src/v105-shadow-runtime.js')
  const store = writer()
  const runtime = module.createV105ShadowRuntime({ enabled: true, writer: store })
  const issued = await runtime.observeTable(table({
    bigRoadRaw: '0001,0001#0002#0001,0001',
    playerCount: 4,
    bankerCount: 1,
  }))

  assert.equal(issued.roadPatternSignal.direction, 'banker')
  assert.equal(Object.isFrozen(issued), true)
  assert.equal(Object.isFrozen(issued.roadPatternSignal), true)
  assert.equal(Object.isFrozen(issued.decodedRecentRuns), true)
  assert.throws(() => { issued.roadPatternSignal.direction = 'player' }, TypeError)
})

test('v105 shadow V6 restart restores only its compact streak and never rebuilds pending issuance', async () => {
  const module = await import('../src/v105-shadow-runtime.js').catch(() => null)
  assert.ok(module, 'v105 shadow runtime must exist')
  const payload = {
    source: 'ofalive99', strategyVersion: 'v105-shadow-v6-road-pattern', releaseCandidate: 'v105-shadow-v6-road-pattern',
    formalStrategyVersion: 'v105', predictionTiming: 'pre_result_context', shadowOnly: true,
    activationEligible: false, memberVisible: false, writesSideActions: false,
    targetTableId: 'BAG01', targetShoe: '105', targetRound: 21,
    predictedResult: 'banker', confidence: 50, sameSideStreak: 1,
    independentSupportCount: 1, shoeBiasSuppressed: false, lockRisk: false,
    heads: {},
  }
  const history = [
    {
      prediction_id: 'old-v104', strategy_version: 'v104-seven-head-shadow-v5-best-stage-side-reweight',
      prediction_timing: 'pre_result_context', prediction_issued_at: '2026-07-27T09:59:00.000Z',
      source: 'ofalive99', table_id: 'BAG01', shoe_no: '105', round_no: 21,
      settlement_final: false, prediction_payload: { ...payload, strategyVersion: 'v104-seven-head-shadow-v5-best-stage-side-reweight' },
    },
    ...['v105-shadow-v1', 'v105-shadow-v3', 'v105-shadow-v4', 'v105-shadow-v5'].map((strategyVersion) => ({
      prediction_id: `old-${strategyVersion}`, strategy_version: strategyVersion,
      prediction_timing: 'pre_result_context', prediction_issued_at: '2026-07-27T09:59:30.000Z',
      source: 'ofalive99', table_id: 'BAG01', shoe_no: '105', round_no: 21,
      settlement_final: false, prediction_payload: { ...payload, strategyVersion },
    })),
    {
      prediction_id: 'persisted-v105-shadow', strategy_version: 'v105-shadow-v6-road-pattern',
      prediction_timing: 'pre_result_context', prediction_issued_at: '2026-07-27T10:00:00.000Z',
      source: 'ofalive99', table_id: 'BAG01', shoe_no: '105', round_no: 20,
      predicted_result: 'banker', same_side_streak: 7, actual_result: null,
      settlement_final: false, prediction_payload: payload,
    },
  ]
  const store = writer(history)
  const runtime = module.createV105ShadowRuntime({ enabled: true, writer: store })
  await runtime.start()
  assert.deepEqual(runtime.getIssuanceContext('BAG01'), {
    shoe: '105', direction: 'banker', sameSideStreak: 7, round: 20,
  })
  assert.equal(runtime.snapshot().pendingIssuances, 0)
  const issued = await runtime.observeTable(table({ beadPlateRaw: '', bigRoadRaw: 'B#P' }))
  assert.equal(issued.predictionId, 'v105-shadow-BAG01-21')
  assert.equal(store.candidates.length, 1)
  assert.equal(store.candidates[0].sameSideStreak, 8)
  assert.equal(runtime.snapshot().historyRows, 1)
  assert.equal(runtime.snapshot().historySource, 'v105_shadow_v6_only')
})

test('v105 shadow settles only verified Final against the immutable issuance', async () => {
  const module = await import('../src/v105-shadow-runtime.js').catch(() => null)
  assert.ok(module, 'v105 shadow runtime must exist')
  const store = writer()
  const runtime = module.createV105ShadowRuntime({ enabled: true, writer: store })
  await runtime.observeTable(table())
  const result = await runtime.settleRound({
    ...table(), round: 21, sourceAction: '/show_win', winner: 'banker', resolvedAt: '2026-07-27T10:00:01.000Z',
  })
  assert.equal(result.predictionId, 'v105-shadow-BAG01-21')
  assert.equal(store.settlements[0].settlementFinal, true)
  await assert.rejects(runtime.settleRound({
    ...table(), round: 22, sourceAction: '/show_poker', winner: 'banker', resolvedAt: '2026-07-27T10:00:02.000Z',
  }), /verified Final|immutable issuance/i)
})
