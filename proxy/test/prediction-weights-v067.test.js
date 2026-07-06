import test from 'node:test'
import assert from 'node:assert/strict'
import { ALL_MT_EQUAL_MAIN_WEIGHTS, ALL_MT_EQUAL_SIDE_WEIGHTS, SIDE_PREDICTION_THRESHOLDS, buildPredictionResultRow } from '../src/supabase-writer.js'

const sum = (weights) => Object.values(weights).reduce((acc, value) => acc + Number(value), 0)

test('v067 main recommendation weights strongly favor empirically higher-hit signals', () => {
  assert.equal(Object.keys(ALL_MT_EQUAL_MAIN_WEIGHTS).length, 27)
  assert.ok(Math.abs(sum(ALL_MT_EQUAL_MAIN_WEIGHTS) - 1) < 1e-9)
  assert.equal(ALL_MT_EQUAL_MAIN_WEIGHTS.big_road, 0.11)
  assert.equal(ALL_MT_EQUAL_MAIN_WEIGHTS.big_eye_road, 0.04)
  assert.equal(ALL_MT_EQUAL_MAIN_WEIGHTS.next_player_road, 0.025)
  assert.equal(ALL_MT_EQUAL_MAIN_WEIGHTS.shoe_stage, 0.035)
  assert.ok(ALL_MT_EQUAL_MAIN_WEIGHTS.card_points > 0)
  assert.ok(ALL_MT_EQUAL_MAIN_WEIGHTS.shoe_remaining_points > 0)
  assert.equal(Object.hasOwn(ALL_MT_EQUAL_MAIN_WEIGHTS, 'table_id'), false)
})

test('v067 side recommendation weights and thresholds suppress low-hit bonus noise', () => {
  assert.equal(Object.keys(ALL_MT_EQUAL_SIDE_WEIGHTS).length, 40)
  assert.ok(Math.abs(sum(ALL_MT_EQUAL_SIDE_WEIGHTS) - 1) < 1e-9)
  assert.equal(ALL_MT_EQUAL_SIDE_WEIGHTS.pair_risk, 0.25)
  assert.equal(ALL_MT_EQUAL_SIDE_WEIGHTS.banker_pair_count, 0.15)
  assert.equal(ALL_MT_EQUAL_SIDE_WEIGHTS.remaining_rank_pressure, 0.25)
  assert.equal(SIDE_PREDICTION_THRESHOLDS.bankerPair, 40)
  assert.equal(SIDE_PREDICTION_THRESHOLDS.playerPair, 40)
  assert.equal(SIDE_PREDICTION_THRESHOLDS.tie, 45)
  assert.equal(SIDE_PREDICTION_THRESHOLDS.superSix, 55)
  assert.equal(SIDE_PREDICTION_THRESHOLDS.bankerDragon, 50)
  assert.equal(SIDE_PREDICTION_THRESHOLDS.playerDragon, 50)
})

test('v067 prediction row records high-hit weight strategy version and keeps banker/player output', () => {
  const row = buildPredictionResultRow(
    { tableId: 'BAG67', shoe: 7, round: 8, rawResult: [1, 1, 2, 2], winner: 'player' },
    {
      tableId: 'BAG67', displayName: 'MT百家樂第67桌', tableType: 'BAC', roomId: 'R67', dealerName: 'T', totalPlayers: 30,
      state: 0, orderState: 1, sourceUpdatedAt: '2026-07-05T00:00:00Z', shoe: 7, round: 8,
      bankerCount: 20, playerCount: 40, tieCount: 1, bankerPairCount: 1, playerPairCount: 8,
      beadPlateRaw: '020202020202', bigRoadRaw: 'P#P#P#P#P', bigEyeRaw: '222222', smallRoadRaw: '222222', cockroachRaw: '222222',
      nextBankerRaw: 'weak', nextPlayerRaw: '2222222222',
    },
  )
  assert.match(row.strategy_version, /v074/)
  assert.ok(['banker', 'player'].includes(row.predicted_result))
  assert.equal(row.short_run_adjustment.rule, 'v074_同出手率權重清理版')
})
