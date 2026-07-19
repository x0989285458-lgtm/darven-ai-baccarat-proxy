import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SIDE_PREDICTION_THRESHOLDS,
  SIDE_PREDICTION_WEIGHT_PROFILES,
  buildSideFeatureScores,
} from '../src/supabase-writer.js'

test('tie risk uses tie rate only and is invariant to road chaos', () => {
  const balanced = buildSideFeatureScores({ bankerCount: 45, playerCount: 45, tieCount: 10 })
  const imbalanced = buildSideFeatureScores({ bankerCount: 80, playerCount: 10, tieCount: 10 })

  assert.notEqual(balanced.road_chaos, imbalanced.road_chaos)
  assert.equal(balanced.tie_count, 10)
  assert.equal(imbalanced.tie_count, 10)
  assert.equal(balanced.tie_risk, 16)
  assert.equal(imbalanced.tie_risk, 16)
})

test('tie-risk dedup keeps every formal side threshold and tie weight unchanged', () => {
  assert.deepEqual(SIDE_PREDICTION_THRESHOLDS, {
    tie: 30,
    superSix: 50,
    bankerPair: 50,
    playerPair: 50,
    bankerDragon: 40,
    playerDragon: 40,
  })
  assert.deepEqual(
    Object.fromEntries(Object.entries(SIDE_PREDICTION_WEIGHT_PROFILES.tie).filter(([, value]) => value !== 0)),
    { tie_risk: 0.45, tie_count: 0.10, shoe_stage: 0.10, road_chaos: 0.15, remaining_rank_total: 0.20 },
  )
})
