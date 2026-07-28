import test from 'node:test'
import assert from 'node:assert/strict'
import {
  V104_ITERATION_SHADOW_VERSION,
  buildV104IterationShadowPrediction,
} from '../src/v104-iteration-shadow-contract.js'

const table = {
  tableId: 'BAG01', shoe: 105, round: 20,
  bankerCount: 12, playerCount: 8,
  beadPlateRaw: '222221', bigRoadRaw: '222221',
  nextBankerRaw: '', nextPlayerRaw: '',
}

test('v105-shadow-v6-road-pattern preserves all six approved v104-v5 side heads', async () => {
  const module = await import('../src/v105-shadow-contract.js').catch(() => null)
  assert.ok(module, 'v105 shadow contract must exist')

  const baseline = buildV104IterationShadowPrediction(table)
  const shadow = module.buildV105ShadowPrediction(table)
  assert.equal(shadow.strategyVersion, 'v105-shadow-v6-road-pattern')
  assert.equal(shadow.releaseCandidate, 'v105-shadow-v6-road-pattern')
  assert.equal(shadow.formalStrategyVersion, 'v105')
  for (const key of ['tie', 'superSix', 'bankerDragon', 'playerDragon', 'bankerPair', 'playerPair']) {
    assert.deepEqual(shadow.heads[key], baseline.heads[key])
  }
})

test('v105-shadow-v6-road-pattern makes a clear repeated-column pattern the main direction with immutable evidence', async () => {
  const module = await import('../src/v105-shadow-contract.js')
  const patterned = {
    ...table,
    bankerCount: 6,
    playerCount: 2,
    bigRoadRaw: '0001#0002,0002,0002#0001#0002,0002,0002',
  }
  const baseline = buildV104IterationShadowPrediction(patterned)
  const shadow = module.buildV105ShadowPrediction(patterned)

  assert.equal(baseline.predictedResult, 'banker', 'fixture must prove V6 overrides the v5 fallback direction')
  assert.equal(shadow.predictedResult, 'player')
  assert.equal(shadow.heads.main.predictedResult, 'player')
  assert.equal(shadow.roadPatternSignal.direction, 'player')
  assert.deepEqual(shadow.decodedRecentRuns.map(({ side, length }) => [side, length]), [
    ['player', 1], ['banker', 3], ['player', 1], ['banker', 3],
  ])
  assert.deepEqual(shadow.roadPatternWindows.near6, ['banker', 'banker', 'player', 'banker', 'banker', 'banker'])
  assert.equal(Object.hasOwn(shadow.roadPatternSignal, 'askRoadSignal'), false)
  assert.equal(Object.isFrozen(shadow), true)
  assert.equal(Object.isFrozen(shadow.roadPatternSignal), true)
  assert.throws(() => { shadow.roadPatternSignal.direction = 'banker' }, TypeError)
})

test('v105-shadow-v6-road-pattern conservatively falls back to the original v5 main logic', async () => {
  const module = await import('../src/v105-shadow-contract.js')
  const unclear = { ...table, bigRoadRaw: '0001,0001#0002,0002,0002#0001' }
  const baseline = buildV104IterationShadowPrediction(unclear)
  const shadow = module.buildV105ShadowPrediction(unclear)

  assert.equal(shadow.roadPatternSignal.clear, false)
  assert.equal(shadow.predictedResult, baseline.predictedResult)
  assert.equal(shadow.confidence, baseline.confidence)
  assert.equal(shadow.sameSideStreak, baseline.sameSideStreak)
  assert.deepEqual(shadow.heads.main, baseline.heads.main)
})

test('v105-shadow-v6-road-pattern ignores unrelated history before cloning its large payload', async () => {
  const module = await import('../src/v105-shadow-contract.js')
  const unrelated = Array.from({ length: 1000 }, (_, index) => {
    const row = {
      strategy_version: 'v105-shadow-v6-road-pattern',
      prediction_timing: 'pre_result_context',
      prediction_issued_at: new Date(index * 1000).toISOString(),
      settlement_final: true,
      table_id: 'BAG02',
      predicted_result: 'banker',
      actual_result: 'banker',
    }
    Object.defineProperty(row, 'prediction_payload', {
      enumerable: true,
      get() { throw new Error('unrelated V6 history payload was cloned') },
    })
    return row
  })
  const prediction = module.buildV105ShadowPrediction(table, unrelated)
  assert.equal(prediction.targetTableId, 'BAG01')
  assert.equal(prediction.strategyVersion, 'v105-shadow-v6-road-pattern')
})

test('V6 history requires pre-result timing, issued timestamp, final settlement, target table, and newest 60', async () => {
  const module = await import('../src/v105-shadow-contract.js')
  const invalidRows = [
    { prediction_issued_at: '2026-07-27T00:00:00Z', settlement_final: true },
    { prediction_timing: 'post_result_context', prediction_issued_at: '2026-07-27T00:00:00Z', settlement_final: true },
    { prediction_timing: 'pre_result_context', settlement_final: true },
    { prediction_timing: 'pre_result_context', prediction_issued_at: '2026-07-27T00:00:00Z', settlement_final: false },
    { prediction_timing: 'pre_result_context', prediction_issued_at: '2026-07-27T00:00:00Z', settlement_final: true, table_id: 'BAG02' },
  ].map((fields) => {
    const row = { strategy_version: 'v105-shadow-v6-road-pattern', table_id: 'BAG01', ...fields }
    Object.defineProperty(row, 'prediction_payload', {
      enumerable: true,
      get() { throw new Error('invalid V6 history payload was cloned') },
    })
    return row
  })
  const validRows = Array.from({ length: 61 }, (_, index) => ({
    strategy_version: 'v105-shadow-v6-road-pattern', table_id: 'BAG01',
    prediction_timing: 'pre_result_context', prediction_issued_at: new Date(index * 1000).toISOString(),
    settlement_final: true, predicted_result: index === 60 ? 'player' : 'banker', actual_result: 'banker',
  }))
  assert.doesNotThrow(() => module.buildV105ShadowPrediction(table, [...invalidRows, ...validRows]))
})

test('v105-shadow-v6-road-pattern settlement accepts verified Final and rejects every old shadow identity', async () => {
  const module = await import('../src/v105-shadow-contract.js').catch(() => null)
  assert.ok(module, 'v105 shadow contract must exist')
  const prediction = module.buildV105ShadowPrediction(table)
  const issued = { ...prediction, predictionId: 'v105-shadow-pid', issuedAt: '2026-07-27T10:00:00.000Z' }
  const settled = module.buildV105ShadowSettlement({
    ...table, round: 21, sourceAction: '/summary', winner: 'banker', resolvedAt: '2026-07-27T10:00:01.000Z',
  }, issued)
  assert.equal(settled.strategyVersion, 'v105-shadow-v6-road-pattern')
  assert.equal(settled.settlementFinal, true)

  for (const strategyVersion of [
    'v105-shadow-v1', 'v105-shadow-v3', 'v105-shadow-v4', 'v105-shadow-v5', V104_ITERATION_SHADOW_VERSION,
  ]) {
    await assert.rejects(async () => module.buildV105ShadowSettlement({
      ...table, round: 21, sourceAction: '/summary', winner: 'banker', resolvedAt: '2026-07-27T10:00:01.000Z',
    }, { ...issued, strategyVersion }), /v105-shadow-v6-road-pattern identity/i)
  }
})
