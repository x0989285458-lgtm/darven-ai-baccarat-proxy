import test from 'node:test'
import assert from 'node:assert/strict'
import {
  V103_SHADOW_MAIN_WEIGHTS,
  buildV103ShadowHistory,
  buildV103ShadowPrediction,
  buildV103ShadowSettlement,
} from '../src/v103-shadow-strategy.js'

const table = (overrides = {}) => ({
  tableId: 'BAG01', shoe: 103, round: 20,
  bankerCount: 12, playerCount: 8,
  beadPlateRaw: '010201', bigRoadRaw: '010201',
  nextBankerRaw: '1', nextPlayerRaw: '2',
  ...overrides,
})

test('v103 shadow main weights are exact, sum to one, and always issue banker or player', () => {
  assert.deepEqual(V103_SHADOW_MAIN_WEIGHTS, {
    roadmap_trend_signals: 0.05,
    ask_road_signals: 0.05,
    recent_practical_calibration: 0.45,
    shoe_banker_player_bias: 0.35,
    neutral_reserve: 0.10,
  })
  assert.equal(Object.values(V103_SHADOW_MAIN_WEIGHTS).reduce((sum, value) => sum + value, 0), 1)
  for (const candidate of [table(), table({ bankerCount: 0, playerCount: 0, beadPlateRaw: '', bigRoadRaw: '', nextBankerRaw: '', nextPlayerRaw: '' })]) {
    assert.match(buildV103ShadowPrediction(candidate, []).predictedResult, /^(banker|player)$/)
  }
  const shadow = buildV103ShadowPrediction(table(), [])
  assert.equal(shadow.shadowOnly, true)
  assert.equal(shadow.activationEligible, false)
  assert.equal(shadow.memberVisible, false)
  assert.equal(shadow.writesSideActions, false)
})

test('v103 history accepts only its own immutable pre-result Final settlements', () => {
  const valid = {
    strategy_version: 'v103', prediction_timing: 'pre_result_context',
    prediction_issued_at: '2026-07-20T10:00:00Z', settlement_final: true,
    predicted_result: 'banker', actual_result: 'banker', settlement_status: 'hit',
  }
  const history = buildV103ShadowHistory([
    valid,
    { ...valid, strategy_version: 'v102' },
    { ...valid, strategy_version: 'v101' },
    { ...valid, prediction_timing: 'post_result' },
    { ...valid, prediction_issued_at: null },
    { ...valid, settlement_final: false },
    { ...valid, actual_result: 'tie', settlement_status: 'push' },
  ])

  assert.deepEqual(history, {
    banker: { settledPredictionCount: 1, hitRate: 1 },
    player: { settledPredictionCount: 0, hitRate: null },
  })
})

test('v103 calibration history is isolated per table and bounded to the latest sixty Finals', () => {
  const row = (tableId, actualResult, resolvedAt) => ({
    table_id: tableId,
    strategy_version: 'v103',
    prediction_timing: 'pre_result_context',
    prediction_issued_at: resolvedAt,
    settlement_final: true,
    predicted_result: 'banker',
    actual_result: actualResult,
    settlement_status: actualResult === 'banker' ? 'hit' : 'miss',
    resolved_at: resolvedAt,
  })
  const atMinute = (index) => new Date(Date.parse('2026-07-20T00:00:00Z') + index * 60000).toISOString()
  const bag01 = [row('BAG01', 'banker', atMinute(0))]
  for (let index = 1; index <= 60; index += 1) bag01.push(row('BAG01', 'player', atMinute(index)))
  const bag02 = Array.from({ length: 20 }, (_, index) => row('BAG02', 'banker', atMinute(120 + index)))

  assert.deepEqual(buildV103ShadowHistory([...bag01, ...bag02], { tableId: 'BAG01', windowSize: 60 }), {
    banker: { settledPredictionCount: 60, hitRate: 0 },
    player: { settledPredictionCount: 0, hitRate: null },
  })
})

test('v103 recent calibration uses neutral shrinkage until twenty directional shadow Finals', () => {
  const row = (isHit) => ({
    table_id: 'BAG01',
    strategy_version: 'v103', prediction_timing: 'pre_result_context',
    prediction_issued_at: '2026-07-20T10:00:00Z', settlement_final: true,
    predicted_result: 'banker', actual_result: isHit ? 'banker' : 'player',
    settlement_status: isHit ? 'hit' : 'miss',
  })
  const insufficient = buildV103ShadowPrediction(table(), Array.from({ length: 19 }, () => row(true)))
  const sufficient = buildV103ShadowPrediction(table(), [...Array.from({ length: 16 }, () => row(true)), ...Array.from({ length: 4 }, () => row(false))])

  assert.deepEqual(insufficient.scoreSources.recent_practical_calibration, { banker: 0.5, player: 0.5 })
  assert.equal(insufficient.calibration.sampleCount, 19)
  assert.equal(insufficient.calibration.mode, 'neutral_shrinkage')
  assert.notDeepEqual(sufficient.scoreSources.recent_practical_calibration, { banker: 0.5, player: 0.5 })
  assert.equal(sufficient.calibration.mode, 'v103_shadow_final_history')
})

test('v103 Final settlement accepts summary/show_win, rejects provisional/unknown, and tie is PUSH outside accuracy denominator', () => {
  const issued = buildV103ShadowPrediction(table(), [])
  issued.predictionId = '10300000-0000-0000-0000-000000000001'
  issued.issuedAt = '2026-07-20T10:00:00Z'
  const final = (sourceAction, winner) => ({ tableId: 'BAG01', shoe: 103, round: 21, sourceAction, winner })

  assert.equal(buildV103ShadowSettlement(final('/summary', 'banker'), issued).settlementStatus, issued.predictedResult === 'banker' ? 'hit' : 'miss')
  assert.equal(buildV103ShadowSettlement(final('/show_win', 'tie'), issued).settlementStatus, 'push')
  assert.equal(buildV103ShadowSettlement(final('/show_win', 'tie'), issued).isHit, null)
  assert.throws(() => buildV103ShadowSettlement(final('/show_poker', 'banker'), issued), /verified Final/i)
  assert.throws(() => buildV103ShadowSettlement(final('/unknown', 'banker'), issued), /verified Final/i)
})
