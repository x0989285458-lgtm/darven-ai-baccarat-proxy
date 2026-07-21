import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  V100_SIDE_DEDUP_VERSION,
  V100_SIDE_SCORE_CALIBRATION_OFFSETS,
  buildLivePrediction,
  buildV100SideActions,
  calculateV100SidePrediction,
} from '../src/supabase-writer.js'

const BASE = Object.freeze({
  T: 20, B: 60, P: 40, R: 80, S: 30,
  Q: 70, XB: 10, XP: 30, DB: 50, DP: 25,
})
const closeTo = (actual, expected, epsilon = 1e-10) => assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`)

function score(primitives = BASE, options = {}) {
  return calculateV100SidePrediction({
    primitives,
    rankAvailable: true,
    rankFallback: 'neutral',
    mainPrediction: 'banker',
    baseSidePredictions: { bankerDragon: 67, playerDragon: 33 },
    ...options,
  })
}

test('v102 audit matrix applies each approved deduplicated side formula exactly once', () => {
  const shadow = score()
  const A = 100 - Math.abs(BASE.B - BASE.P)
  const expectedTie = 0.5068331143232588 * BASE.T + 0.1931668856767411 * A + 0.10 * BASE.S + 0.20 * BASE.R

  assert.equal(V100_SIDE_DEDUP_VERSION, 'v104_副預測沿用v102正式規則')
  closeTo(shadow.diagnostics.rawPredictions.tie, expectedTie)
  closeTo(shadow.diagnostics.rawPredictions.bankerPair, 40.3)
  closeTo(shadow.diagnostics.rawPredictions.playerPair, 34.5)
  closeTo(shadow.diagnostics.rawPredictions.superSix, 50.5)
  assert.equal(shadow.predictions.bankerDragon, 67)
  assert.equal(shadow.predictions.playerDragon, 33)
  assert.deepEqual(shadow.diagnostics.residuals, {
    bankerPair: 48,
    playerPair: 0,
    bankerDragonShared: 42,
    bankerDragonResidual: 8,
  })
  assert.deepEqual(shadow.diagnostics.primitives, { ...BASE, A: 80, Hpair: 50, H6: 30 })
})

test('v102 diagnostics expose rank availability, fallback, and effective coefficients', () => {
  const neutral = score({ ...BASE, Q: Number.NaN, R: undefined }, { rankAvailable: false, rankFallback: 'neutral' })
  assert.deepEqual(neutral.diagnostics.rank, {
    available: false,
    fallback: 'neutral',
    substituted: { Q: 50, R: 50 },
    excluded: [],
  })
  assert.equal(neutral.diagnostics.primitives.Q, 50)
  assert.equal(neutral.diagnostics.primitives.R, 50)
  assert.deepEqual(neutral.diagnostics.effectiveCoefficients.tie, { T: 0.5068331143232588, A: 0.1931668856767411, S: 0.10, R: 0.20 })
  assert.deepEqual(neutral.diagnostics.effectiveCoefficients.bankerPair, { Q: 0.15, S: 0.20, XB: 0.20, RB: 0.35, Hpair: 0.10 })

  const renormalized = score({ ...BASE, Q: Number.NaN, R: Number.NaN }, { rankAvailable: false, rankFallback: 'renormalize' })
  const tieWithoutRank = (0.5068331143232588 * 20 + 0.1931668856767411 * 80 + 0.10 * 30) / 0.80
  closeTo(renormalized.diagnostics.rawPredictions.tie, tieWithoutRank)
  closeTo(renormalized.diagnostics.rawPredictions.bankerPair, (0.20 * 30 + 0.20 * 10 + 0.35 * 48 + 0.10 * 50) / 0.85)
  closeTo(renormalized.diagnostics.rawPredictions.playerPair, (0.15 * 30 + 0.20 * 30 + 0.25 * 0 + 0.20 * 50) / 0.80)
  closeTo(renormalized.diagnostics.rawPredictions.superSix, (0.35 * 60 + 0.35 * 30 + 0.10 * 30) / 0.80)
  assert.equal(renormalized.diagnostics.effectiveCoefficients.tie.R, 0)
  assert.equal(renormalized.diagnostics.rank.substituted, null)
  assert.deepEqual(renormalized.diagnostics.rank.excluded, ['Q', 'R'])
  assert.deepEqual(renormalized.actions, {
    tie: false, superSix: false, bankerPair: false, playerPair: false, bankerDragon: false, playerDragon: false,
  })
  closeTo(Object.values(renormalized.diagnostics.effectiveCoefficients.tie).reduce((sum, value) => sum + value, 0), 1)
  assert.throws(() => score(BASE, { rankAvailable: false, rankFallback: undefined }), /rankFallback/)
})

test('v102 infers null rank primitives as unavailable instead of silently converting unknown to zero', () => {
  const shadow = score({ ...BASE, Q: null, R: null }, { rankAvailable: undefined, rankFallback: 'neutral' })
  assert.equal(shadow.diagnostics.rank.available, false)
  assert.equal(shadow.diagnostics.primitives.Q, 50)
  assert.equal(shadow.diagnostics.primitives.R, 50)
})

test('v102 table mode reads only an explicitly available table.cardShoe and rejects a gap even with 13 counts', () => {
  const counts = Object.fromEntries(['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'].map((face) => [face, 30]))
  const baseTable = { tableId: 'BAG01', round: 12, bankerCount: 6, playerCount: 5, tieCount: 1 }
  const gap = calculateV100SidePrediction({
    table: { ...baseTable, v102RankLedger: { remainingRankCounts: counts, rankDataAvailable: false, status: 'gap' } },
    rankFallback: 'neutral',
    mainPrediction: 'banker',
  })
  assert.equal(gap.diagnostics.rank.available, false)
  assert.deepEqual(gap.diagnostics.rank.substituted, { Q: 50, R: 50 })

  const contiguous = calculateV100SidePrediction({
    table: { ...baseTable, v102RankLedger: { remainingRankCounts: counts, rankDataAvailable: true, status: 'contiguous' } },
    rankFallback: 'neutral',
    mainPrediction: 'banker',
  })
  assert.equal(contiguous.diagnostics.rank.available, true)
  assert.equal(contiguous.diagnostics.rank.fallback, null)
})

test('v102 runtime calibration constants match the reproducible strict train artifact', () => {
  const artifact = JSON.parse(readFileSync(new URL('../config/v101-side-calibration.json', import.meta.url), 'utf8'))
  assert.equal(artifact.method, 'chronological_train_product_runtime_quantile')
  assert.equal(artifact.trainRows, 1182)
  assert.match(artifact.trainIdsSha256, /^[0-9a-f]{64}$/)
  assert.equal(artifact.activationEligible, true)
  assert.equal(artifact.activationBlockReason, null)
  assert.deepEqual(V100_SIDE_SCORE_CALIBRATION_OFFSETS, artifact.offsets)
})

test('v102 applies fixed train-only score calibration without changing thresholds or raw formula lineage', () => {
  const shadow = score()
  for (const key of ['tie', 'superSix', 'bankerPair', 'playerPair', 'bankerDragon', 'playerDragon']) {
    closeTo(shadow.predictions[key], Math.max(0, Math.min(100,
      shadow.diagnostics.rawPredictions[key] + V100_SIDE_SCORE_CALIBRATION_OFFSETS[key])))
  }
  assert.equal(shadow.diagnostics.scoreCalibration.method, 'train_quantile_to_existing_threshold')
  assert.deepEqual(shadow.diagnostics.scoreCalibration.offsets, V100_SIDE_SCORE_CALIBRATION_OFFSETS)
  assert.deepEqual(shadow.diagnostics.scoreCalibration.actionRateTargets, {
    tie: 0.15, superSix: 0.10, bankerPair: 0.20, playerPair: 0.20, bankerDragon: 0.08, playerDragon: 0.08,
  })
})

test('v102 clamps malformed primitives and keeps every numeric output finite in 0..100', () => {
  const shadow = score({ T: Number.NaN, B: Infinity, P: -20, R: 200, S: 'bad', Q: -1, XB: 500, XP: undefined, DB: -Infinity, DP: 101 })
  const numbers = [
    ...Object.values(shadow.predictions),
    ...Object.values(shadow.diagnostics.primitives),
    ...Object.values(shadow.diagnostics.residuals),
  ]
  assert.equal(numbers.every((value) => Number.isFinite(value) && value >= 0 && value <= 100), true)
})

test('v102 formal actions preserve formal thresholds ±1 and main-direction gates', () => {
  const below = buildV100SideActions({ tie: 29, superSix: 49, bankerPair: 49, playerPair: 49, bankerDragon: 39, playerDragon: 39 }, 'banker')
  assert.deepEqual(below, { tie: false, superSix: false, bankerPair: false, playerPair: false, bankerDragon: false, playerDragon: false })

  const banker = buildV100SideActions({ tie: 30, superSix: 50, bankerPair: 50, playerPair: 50, bankerDragon: 40, playerDragon: 100 }, 'banker')
  assert.deepEqual(banker, { tie: true, superSix: true, bankerPair: true, playerPair: true, bankerDragon: true, playerDragon: false })
  const player = buildV100SideActions({ superSix: 100, bankerDragon: 100, playerDragon: 40 }, 'player')
  assert.equal(player.superSix, false)
  assert.equal(player.bankerDragon, false)
  assert.equal(player.playerDragon, true)
})

test('v102 formal buildLivePrediction packages the approved side dedup and live actions', () => {
  const table = {
    tableId: 'BAG100', shoe: 8, round: 20, bankerCount: 11, playerCount: 9, tieCount: 2,
    bankerPairCount: 1, playerPairCount: 2, nextBankerRaw: 'B', nextPlayerRaw: 'P',
    beadPlateRaw: '010203#020102', bigRoadRaw: 'BPBP', bigEyeRaw: '1212', smallRoadRaw: '1122', cockroachRaw: '1221',
  }
  const prediction = buildLivePrediction(table)
  assert.equal(prediction.strategyVersion, 'v104')
  assert.equal(prediction.predictionFeatures.v102_side_policy.strategyVersion, V100_SIDE_DEDUP_VERSION)
  assert.deepEqual(prediction.sideActions, prediction.predictionFeatures.v102_side_policy.actions)
  assert.deepEqual(prediction.sideActions, {
    tie: false, superSix: false, bankerPair: false, playerPair: false, bankerDragon: false, playerDragon: false,
  })
  assert.equal(prediction.predictionFeatures.v102_side_policy.diagnostics.rank.available, false)
})
