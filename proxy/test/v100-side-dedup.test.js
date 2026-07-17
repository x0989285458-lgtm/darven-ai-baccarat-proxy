import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  V100_SIDE_DEDUP_VERSION,
  buildLivePrediction,
  buildV100SideShadowActions,
  calculateV100SidePredictionShadow,
} from '../src/supabase-writer.js'

const BASE = Object.freeze({
  T: 20, B: 60, P: 40, R: 80, S: 30,
  Q: 70, XB: 10, XP: 30, DB: 50, DP: 25,
})
const closeTo = (actual, expected, epsilon = 1e-10) => assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`)

function score(primitives = BASE, options = {}) {
  return calculateV100SidePredictionShadow({
    primitives,
    rankAvailable: true,
    rankFallback: 'neutral',
    mainPrediction: 'banker',
    v98SidePredictions: { bankerDragon: 67, playerDragon: 33 },
    ...options,
  })
}

test('v100 audit matrix applies each approved deduplicated side formula exactly once', () => {
  const shadow = score()
  const A = 100 - Math.abs(BASE.B - BASE.P)
  const expectedTie = 0.5068331143232588 * BASE.T + 0.1931668856767411 * A + 0.10 * BASE.S + 0.20 * BASE.R

  assert.equal(V100_SIDE_DEDUP_VERSION, 'v100_主副訊號去重與8副牌階完整性版')
  closeTo(shadow.predictions.tie, expectedTie)
  closeTo(shadow.predictions.bankerPair, 40.3)
  closeTo(shadow.predictions.playerPair, 34.5)
  closeTo(shadow.predictions.superSix, 50.5)
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

test('v100 diagnostics expose rank availability, fallback, and effective coefficients', () => {
  const neutral = score({ ...BASE, Q: Number.NaN, R: undefined }, { rankAvailable: false, rankFallback: 'neutral' })
  assert.deepEqual(neutral.diagnostics.rank, {
    available: false,
    fallback: 'neutral',
    substituted: { Q: 50, R: 50 },
  })
  assert.equal(neutral.diagnostics.primitives.Q, 50)
  assert.equal(neutral.diagnostics.primitives.R, 50)
  assert.deepEqual(neutral.diagnostics.effectiveCoefficients.tie, { T: 0.5068331143232588, A: 0.1931668856767411, S: 0.10, R: 0.20 })
  assert.deepEqual(neutral.diagnostics.effectiveCoefficients.bankerPair, { Q: 0.15, S: 0.20, XB: 0.20, RB: 0.35, Hpair: 0.10 })

  const renormalized = score({ ...BASE, Q: Number.NaN, R: Number.NaN }, { rankAvailable: false, rankFallback: 'renormalize' })
  const tieWithoutRank = (0.5068331143232588 * 20 + 0.1931668856767411 * 80 + 0.10 * 30) / 0.80
  closeTo(renormalized.predictions.tie, tieWithoutRank)
  closeTo(renormalized.predictions.bankerPair, (0.20 * 30 + 0.20 * 10 + 0.35 * 48 + 0.10 * 50) / 0.85)
  closeTo(renormalized.predictions.playerPair, (0.15 * 30 + 0.20 * 30 + 0.25 * 0 + 0.20 * 50) / 0.80)
  closeTo(renormalized.predictions.superSix, (0.35 * 60 + 0.35 * 30 + 0.10 * 30) / 0.80)
  assert.equal(renormalized.diagnostics.effectiveCoefficients.tie.R, 0)
  closeTo(Object.values(renormalized.diagnostics.effectiveCoefficients.tie).reduce((sum, value) => sum + value, 0), 1)
  assert.throws(() => score(BASE, { rankAvailable: false, rankFallback: undefined }), /rankFallback/)
})

test('v100 infers null rank primitives as unavailable instead of silently converting unknown to zero', () => {
  const shadow = score({ ...BASE, Q: null, R: null }, { rankAvailable: undefined, rankFallback: 'neutral' })
  assert.equal(shadow.diagnostics.rank.available, false)
  assert.equal(shadow.diagnostics.primitives.Q, 50)
  assert.equal(shadow.diagnostics.primitives.R, 50)
})

test('v100 clamps malformed primitives and keeps every numeric output finite in 0..100', () => {
  const shadow = score({ T: Number.NaN, B: Infinity, P: -20, R: 200, S: 'bad', Q: -1, XB: 500, XP: undefined, DB: -Infinity, DP: 101 })
  const numbers = [
    ...Object.values(shadow.predictions),
    ...Object.values(shadow.diagnostics.primitives),
    ...Object.values(shadow.diagnostics.residuals),
  ]
  assert.equal(numbers.every((value) => Number.isFinite(value) && value >= 0 && value <= 100), true)
})

test('v100 shadow actions preserve formal thresholds ±1 and main-direction gates', () => {
  const below = buildV100SideShadowActions({ tie: 24, superSix: 44, bankerPair: 42, playerPair: 42, bankerDragon: 29, playerDragon: 29 }, 'banker')
  assert.deepEqual(below, { tie: false, superSix: false, bankerPair: false, playerPair: false, bankerDragon: false, playerDragon: false })

  const banker = buildV100SideShadowActions({ tie: 25, superSix: 45, bankerPair: 43, playerPair: 43, bankerDragon: 30, playerDragon: 100 }, 'banker')
  assert.deepEqual(banker, { tie: true, superSix: true, bankerPair: true, playerPair: true, bankerDragon: true, playerDragon: false })
  const player = buildV100SideShadowActions({ superSix: 100, bankerDragon: 100, playerDragon: 30 }, 'player')
  assert.equal(player.superSix, false)
  assert.equal(player.bankerDragon, false)
  assert.equal(player.playerDragon, true)
})

test('v100 leaves the complete v98 buildLivePrediction fixture byte-for-byte unchanged', () => {
  const table = {
    tableId: 'BAG100', shoe: 8, round: 20, bankerCount: 11, playerCount: 9, tieCount: 2,
    bankerPairCount: 1, playerPairCount: 2, nextBankerRaw: 'B', nextPlayerRaw: 'P',
    beadPlateRaw: '010203#020102', bigRoadRaw: 'BPBP', bigEyeRaw: '1212', smallRoadRaw: '1122', cockroachRaw: '1221',
  }
  const digest = createHash('sha256').update(JSON.stringify(buildLivePrediction(table))).digest('hex')
  assert.equal(digest, 'cf0b1146c7a8d6d9c17d3d85ddae5179867a6eecadaafde45cf09c5c2fdd4d4a')
})
