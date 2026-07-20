import test from 'node:test'
import assert from 'node:assert/strict'
import {
  V104_SHADOW_DIRECTION_WEIGHTS,
  V104_SHADOW_SHOE_BIAS,
  buildV104ShadowPrediction,
  buildV104ShoeBias,
  calculateV104Direction,
} from '../src/v104-shadow-strategy.js'

const baseTable = (overrides = {}) => ({
  tableId: 'BAG08', shoe: 104, round: 20,
  bankerCount: 12, playerCount: 8,
  beadPlateRaw: '222221', bigRoadRaw: '222221',
  nextBankerRaw: '1', nextPlayerRaw: '2',
  ...overrides,
})

const historyRow = (actualResult) => ({
  table_id: 'BAG08', strategy_version: 'v104', prediction_timing: 'pre_result_context',
  prediction_issued_at: '2026-07-21T10:00:00Z', settlement_final: true,
  predicted_result: 'banker', actual_result: actualResult,
  settlement_status: actualResult === 'banker' ? 'hit' : 'miss',
})

test('v104 direction weights are exact and calibration has zero direction contribution', () => {
  assert.deepEqual(V104_SHADOW_DIRECTION_WEIGHTS, {
    roadmap_trend_signals: 0.275,
    ask_road_signals: 0.275,
    shoe_banker_player_bias: 0.35,
    neutral_reserve: 0.10,
  })
  assert.equal(Object.values(V104_SHADOW_DIRECTION_WEIGHTS).reduce((sum, value) => sum + value, 0), 1)

  const losingHistory = Array.from({ length: 20 }, () => historyRow('player'))
  const winningHistory = Array.from({ length: 20 }, () => historyRow('banker'))
  const losing = buildV104ShadowPrediction(baseTable(), losingHistory)
  const winning = buildV104ShadowPrediction(baseTable(), winningHistory)

  assert.equal(losing.predictedResult, winning.predictedResult)
  assert.notEqual(losing.confidence, winning.confidence)
  assert.equal(losing.diagnostics.calibration.directionContribution, 0)
  assert.equal(winning.diagnostics.calibration.directionContribution, 0)
})

test('v104 new shoe is neutral and cannot inherit the previous shoe bias', () => {
  assert.deepEqual(buildV104ShoeBias({ tableId: 'BAG08', shoe: 105, bankerCount: 0, playerCount: 0 }), {
    banker: 0.5,
    player: 0.5,
    sampleCount: 0,
    rawBankerRate: 0.5,
    posteriorBankerRate: 0.5,
    capped: false,
  })
  const fresh = buildV104ShadowPrediction(baseTable({ shoe: 105, bankerCount: 0, playerCount: 0 }), [], {
    priorShoe: '104', priorDirection: 'banker', priorSameSideStreak: 9,
  })
  assert.deepEqual(fresh.scoreSources.shoe_banker_player_bias, { banker: 0.5, player: 0.5 })
  assert.equal(fresh.sameSideStreak, 1)
})

test('v104 shoe bias applies fixed Bayesian shrinkage and transparent symmetric cap boundaries', () => {
  assert.deepEqual(V104_SHADOW_SHOE_BIAS, { priorSampleSize: 8, maximumEdge: 0.08 })
  assert.deepEqual(buildV104ShoeBias({ bankerCount: 5, playerCount: 3 }), {
    banker: 0.5625, player: 0.4375, sampleCount: 8,
    rawBankerRate: 0.625, posteriorBankerRate: 0.5625, capped: false,
  })
  assert.deepEqual(buildV104ShoeBias({ bankerCount: 8, playerCount: 0 }), {
    banker: 0.58, player: 0.42, sampleCount: 8,
    rawBankerRate: 1, posteriorBankerRate: 0.75, capped: true,
  })
  assert.deepEqual(buildV104ShoeBias({ bankerCount: 0, playerCount: 8 }), {
    banker: 0.42, player: 0.58, sampleCount: 8,
    rawBankerRate: 0, posteriorBankerRate: 0.25, capped: true,
  })
})

test('v104 fifth same-side issuance suppresses shoe and recomputes when independent support is insufficient', () => {
  const decision = calculateV104Direction({
    tableIdentity: 'BAG08:104:25',
    scoreSources: {
      roadmap_trend_signals: { banker: 0.5, player: 0.5 },
      ask_road_signals: { banker: 0.5, player: 0.5 },
      shoe_banker_player_bias: { banker: 0.58, player: 0.42 },
      neutral_reserve: { banker: 0.5, player: 0.5 },
    },
    priorDirection: 'banker', priorSameSideStreak: 4,
  })
  assert.equal(decision.shoeBiasSuppressed, true)
  assert.equal(decision.independentSupportCount, 0)
  assert.equal(decision.lockRisk, true)
  assert.deepEqual(decision.appliedScoreSources.shoe_banker_player_bias, { banker: 0.5, player: 0.5 })
  assert.match(decision.predictedResult, /^(banker|player)$/)
})

test('v104 lock guard prefers direct roadmap when roadmap and derived ask-road conflict', () => {
  const decision = calculateV104Direction({
    tableIdentity: 'BAG03A:15819:58',
    scoreSources: {
      roadmap_trend_signals: { banker: 0.45, player: 0.55 },
      ask_road_signals: { banker: 0.56, player: 0.44 },
      shoe_banker_player_bias: { banker: 0.58, player: 0.42 },
      neutral_reserve: { banker: 0.5, player: 0.5 },
    },
    priorDirection: 'banker', priorSameSideStreak: 57,
  })
  assert.equal(decision.lockRisk, true)
  assert.equal(decision.shoeBiasSuppressed, true)
  assert.equal(decision.askRoadSuppressed, true)
  assert.equal(decision.predictedResult, 'player')
  assert.equal(decision.sameSideStreak, 1)
  assert.deepEqual(decision.appliedScoreSources.ask_road_signals, { banker: 0.5, player: 0.5 })
})

test('v104 two independent road supports allow the fifth same-side issuance to continue', () => {
  const decision = calculateV104Direction({
    tableIdentity: 'BAG08:104:25',
    scoreSources: {
      roadmap_trend_signals: { banker: 0.56, player: 0.44 },
      ask_road_signals: { banker: 0.56, player: 0.44 },
      shoe_banker_player_bias: { banker: 0.58, player: 0.42 },
      neutral_reserve: { banker: 0.5, player: 0.5 },
    },
    priorDirection: 'banker', priorSameSideStreak: 4,
  })
  assert.equal(decision.predictedResult, 'banker')
  assert.equal(decision.sameSideStreak, 5)
  assert.equal(decision.independentSupportCount, 2)
  assert.equal(decision.shoeBiasSuppressed, false)
  assert.equal(decision.lockRisk, false)
})

test('BAG08 minimal replay cannot remain locked by calibration plus shoe alone', () => {
  const calibrationLocked = calculateV104Direction({
    tableIdentity: 'BAG08:104:25',
    scoreSources: {
      roadmap_trend_signals: { banker: 0.44, player: 0.56 },
      ask_road_signals: { banker: 0.5, player: 0.5 },
      recent_practical_calibration: { banker: 0.55, player: 0.45 },
      shoe_banker_player_bias: { banker: 0.58, player: 0.42 },
      neutral_reserve: { banker: 0.5, player: 0.5 },
    },
    priorDirection: 'banker', priorSameSideStreak: 4,
  })
  assert.equal(calibrationLocked.shoeBiasSuppressed, true)
  assert.equal(calibrationLocked.predictedResult, 'player')
  assert.equal(calibrationLocked.sameSideStreak, 1)
})
