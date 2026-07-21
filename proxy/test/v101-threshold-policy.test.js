import test from 'node:test'
import assert from 'node:assert/strict'
import { ALL_MT_EQUAL_STRATEGY_VERSION, SIDE_PREDICTION_THRESHOLDS, buildSideActions } from '../src/supabase-writer.js'

test('v102 uses the user-approved formal side thresholds', () => {
  assert.equal(ALL_MT_EQUAL_STRATEGY_VERSION, 'v104')
  assert.deepEqual(SIDE_PREDICTION_THRESHOLDS, {
    tie: 30,
    superSix: 50,
    bankerPair: 50,
    playerPair: 50,
    bankerDragon: 40,
    playerDragon: 40,
  })
})

test('v102 acts only at or above each approved threshold and preserves directional gates', () => {
  assert.equal(buildSideActions({ tie: 29.999 }, 'player').tie, false)
  assert.equal(buildSideActions({ tie: 30 }, 'player').tie, true)
  assert.equal(buildSideActions({ bankerPair: 49.999 }, 'banker').bankerPair, false)
  assert.equal(buildSideActions({ bankerPair: 50 }, 'banker').bankerPair, true)
  assert.equal(buildSideActions({ playerPair: 49.999 }, 'player').playerPair, false)
  assert.equal(buildSideActions({ playerPair: 50 }, 'player').playerPair, true)
  assert.equal(buildSideActions({ superSix: 50 }, 'player').superSix, false)
  assert.equal(buildSideActions({ superSix: 49.999 }, 'banker').superSix, false)
  assert.equal(buildSideActions({ superSix: 50 }, 'banker').superSix, true)
  assert.equal(buildSideActions({ bankerDragon: 40 }, 'player').bankerDragon, false)
  assert.equal(buildSideActions({ bankerDragon: 39.999 }, 'banker').bankerDragon, false)
  assert.equal(buildSideActions({ bankerDragon: 40 }, 'banker').bankerDragon, true)
  assert.equal(buildSideActions({ playerDragon: 40 }, 'banker').playerDragon, false)
  assert.equal(buildSideActions({ playerDragon: 39.999 }, 'player').playerDragon, false)
  assert.equal(buildSideActions({ playerDragon: 40 }, 'player').playerDragon, true)
})
