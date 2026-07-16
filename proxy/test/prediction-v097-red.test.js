import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ALL_MT_EQUAL_STRATEGY_VERSION,
  SIDE_PREDICTION_THRESHOLDS,
  SIDE_PREDICTION_WEIGHT_PROFILES,
  SIDE_WEIGHT_KEYS,
  buildDefaultEqualStrategy,
  buildFormalActiveStrategy,
  buildLivePrediction,
  buildShortRunAdjustedStrategy,
  buildSideActions,
} from '../src/supabase-writer.js'

const approvedStrategyVersion = 'v098_主信心實際命中校準版'

const approvedSideProfiles = {
  tie: { tie_risk: 0.45, tie_count: 0.10, shoe_stage: 0.10, road_chaos: 0.15, remaining_rank_total: 0.20 },
  superSix: { banker_point: 0.35, remaining_rank_total: 0.20, table_side_history: 0.35, shoe_stage: 0.10 },
  bankerPair: { remaining_rank_pressure: 0.15, table_side_history: 0.10, banker_pair_count: 0.20, shoe_stage: 0.20, pair_risk: 0.35 },
  playerPair: { remaining_rank_pressure: 0.20, table_side_history: 0.20, player_pair_count: 0.20, shoe_stage: 0.15, pair_risk: 0.25 },
  bankerDragon: { point_diff: 0.15, banker_natural: 0.10, banker_point: 0.35, remaining_rank_total: 0.30, big_road: 0.10 },
  playerDragon: { point_diff: 0.15, player_natural: 0.10, player_point: 0.35, remaining_rank_total: 0.30, big_road: 0.10 },
}

const approvedThresholds = {
  tie: 42,
  superSix: 60,
  bankerPair: 48,
  playerPair: 50,
  bankerDragon: 48,
  playerDragon: 52,
}

function activeWeights(profile) {
  return Object.fromEntries(Object.entries(profile).filter(([, weight]) => Number(weight) > 0))
}

function sumWeights(profile) {
  return Object.values(profile).reduce((sum, weight) => sum + Number(weight), 0)
}

test('v097 formal strategy identity is the only live strategy version', () => {
  assert.equal(ALL_MT_EQUAL_STRATEGY_VERSION, approvedStrategyVersion)
  assert.equal(buildLivePrediction({ tableId: 'BAG97', shoe: 97, round: 0 }).strategyVersion, approvedStrategyVersion)
  assert.equal(buildFormalActiveStrategy().version, approvedStrategyVersion)
  assert.equal(buildFormalActiveStrategy().status, 'active')

  for (const legacyStrategy of [buildDefaultEqualStrategy(), buildShortRunAdjustedStrategy()]) {
    assert.notEqual(legacyStrategy.status, 'active', `${legacyStrategy.version} must not remain an active fallback strategy`)
    assert.doesNotMatch(legacyStrategy.version, /^v096\b|^v096_/)
  }
})

test('v097 side prediction weights use exactly the approved existing factors', () => {
  for (const [sideName, expectedWeights] of Object.entries(approvedSideProfiles)) {
    const profile = SIDE_PREDICTION_WEIGHT_PROFILES[sideName]
    assert.deepEqual(activeWeights(profile), expectedWeights, `${sideName} active weighted factors`)
    for (const key of SIDE_WEIGHT_KEYS) {
      if (!Object.hasOwn(expectedWeights, key)) assert.equal(profile[key], 0, `${sideName}.${key} must remain zero`)
    }
    assert.equal(Number(sumWeights(profile).toFixed(12)), 1, `${sideName} weights sum to 1`)
  }
})

test('v097 side prediction thresholds match the approved lowered gates', () => {
  assert.deepEqual(SIDE_PREDICTION_THRESHOLDS, approvedThresholds)
})

test('v097 side prediction boundary gates require scores to reach the threshold', () => {
  const below = Object.fromEntries(Object.entries(approvedThresholds).map(([sideName, threshold]) => [sideName, threshold - 0.1]))
  assert.deepEqual(buildSideActions(below, 'banker'), {
    tie: false,
    superSix: false,
    bankerPair: false,
    playerPair: false,
    bankerDragon: false,
    playerDragon: false,
  })
  assert.deepEqual(buildSideActions(below, 'player'), {
    tie: false,
    superSix: false,
    bankerPair: false,
    playerPair: false,
    bankerDragon: false,
    playerDragon: false,
  })

  const atThreshold = { ...approvedThresholds }
  assert.deepEqual(buildSideActions(atThreshold, 'banker'), {
    tie: true,
    superSix: true,
    bankerPair: true,
    playerPair: true,
    bankerDragon: true,
    playerDragon: false,
  })
  assert.deepEqual(buildSideActions(atThreshold, 'player'), {
    tie: true,
    superSix: false,
    bankerPair: true,
    playerPair: true,
    bankerDragon: false,
    playerDragon: true,
  })
})
