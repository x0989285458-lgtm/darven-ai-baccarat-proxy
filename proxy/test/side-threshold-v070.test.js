import test from 'node:test'
import assert from 'node:assert/strict'
import { SIDE_PREDICTION_THRESHOLDS, buildSideActions } from '../src/supabase-writer.js'

test('v071 side thresholds allow MT side scores and dragon is enabled', () => {
  assert.equal(SIDE_PREDICTION_THRESHOLDS.tie, 45)
  assert.equal(SIDE_PREDICTION_THRESHOLDS.superSix, 55)
  assert.equal(SIDE_PREDICTION_THRESHOLDS.bankerPair, 40)
  assert.equal(SIDE_PREDICTION_THRESHOLDS.playerPair, 40)
  assert.equal(SIDE_PREDICTION_THRESHOLDS.bankerDragon, 50)
  assert.equal(SIDE_PREDICTION_THRESHOLDS.playerDragon, 50)

  const actions = buildSideActions({ tie: 45, superSix: 55, bankerPair: 40, playerPair: 40, bankerDragon: 70, playerDragon: 20 }, 'banker')
  assert.equal(actions.tie, true)
  assert.equal(actions.superSix, true)
  assert.equal(actions.bankerPair, true)
  assert.equal(actions.playerPair, true)
  assert.equal(actions.bankerDragon, true)
  assert.equal(actions.playerDragon, false)
})

test('v071 superSix remains gated by main banker prediction', () => {
  assert.equal(buildSideActions({ superSix: 55 }, 'player').superSix, false)
})
