import test from 'node:test'
import assert from 'node:assert/strict'
import { SIDE_PREDICTION_THRESHOLDS, buildSideActions } from '../src/supabase-writer.js'

test('v070 side thresholds allow realistic live MT side scores while dragon stays disabled', () => {
  assert.equal(SIDE_PREDICTION_THRESHOLDS.tie, 40)
  assert.equal(SIDE_PREDICTION_THRESHOLDS.superSix, 50)
  assert.equal(SIDE_PREDICTION_THRESHOLDS.bankerPair, 35)
  assert.equal(SIDE_PREDICTION_THRESHOLDS.playerPair, 35)
  assert.equal(SIDE_PREDICTION_THRESHOLDS.bankerDragon, 101)
  assert.equal(SIDE_PREDICTION_THRESHOLDS.playerDragon, 101)

  const actions = buildSideActions({ tie: 41, superSix: 55, bankerPair: 40, playerPair: 39, bankerDragon: 99, playerDragon: 99 }, 'banker')
  assert.equal(actions.tie, true)
  assert.equal(actions.superSix, true)
  assert.equal(actions.bankerPair, true)
  assert.equal(actions.playerPair, true)
  assert.equal(actions.bankerDragon, false)
  assert.equal(actions.playerDragon, false)
})

test('v070 superSix remains gated by main banker prediction', () => {
  assert.equal(buildSideActions({ superSix: 55 }, 'player').superSix, false)
})
