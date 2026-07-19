import test from 'node:test'
import assert from 'node:assert/strict'
import { SIDE_PREDICTION_THRESHOLDS, buildSideActions } from '../src/supabase-writer.js'

test('side thresholds shrink side actions and dragon remains directional', () => {
  assert.equal(SIDE_PREDICTION_THRESHOLDS.tie, 30)
  assert.equal(SIDE_PREDICTION_THRESHOLDS.superSix, 50)
  assert.equal(SIDE_PREDICTION_THRESHOLDS.bankerPair, 50)
  assert.equal(SIDE_PREDICTION_THRESHOLDS.playerPair, 50)
  assert.equal(SIDE_PREDICTION_THRESHOLDS.bankerDragon, 40)
  assert.equal(SIDE_PREDICTION_THRESHOLDS.playerDragon, 40)

  const actions = buildSideActions({ tie: 55, superSix: 70, bankerPair: 75, playerPair: 75, bankerDragon: 85, playerDragon: 20 }, 'banker')
  assert.equal(actions.tie, true)
  assert.equal(actions.superSix, true)
  assert.equal(actions.bankerPair, true)
  assert.equal(actions.playerPair, true)
  assert.equal(actions.bankerDragon, true)
  assert.equal(actions.playerDragon, false)
})

test('superSix remains gated by main banker prediction', () => {
  assert.equal(buildSideActions({ superSix: 70 }, 'player').superSix, false)
})
