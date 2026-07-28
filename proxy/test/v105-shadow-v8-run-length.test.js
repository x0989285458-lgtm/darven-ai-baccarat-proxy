import test from 'node:test'
import assert from 'node:assert/strict'
import {
  decodeV105ShadowV8DerivedRoad,
  analyzeV105ShadowV8RoadRhythm,
} from '../src/v105-shadow-v8-contract.js'

const seq = (...runs) => runs.flatMap(([color, length]) => Array(length).fill(color))

test('V8 derived-road decoder keeps a six-down two-tail blue dragon before the next red', () => {
  const raw = '2,2,2,2,2,2#1,,,,,2#,,,,,2'
  assert.deepEqual(decodeV105ShadowV8DerivedRoad(raw), seq(['2', 8], ['1', 1]))
})

test('V8 6/12/24 rhythm continues red2-blue1 after the current blue1', () => {
  const current = seq(['2', 1], ['1', 3], ['2', 6], ['1', 4], ['2', 1], ['1', 2], ['2', 1])
  const result = analyzeV105ShadowV8RoadRhythm(current)
  assert.equal(result.expectedColor, '1')
  assert.deepEqual(result.windows.near6, seq(['1', 2], ['2', 1], ['1', 2], ['2', 1]))
  assert.equal(result.reason, 'repeated_run_rhythm')
})

test('V8 recognizes red1-blue3 twice and expects red after the completed blue3', () => {
  const current = seq(['1', 2], ['2', 1], ['1', 2], ['2', 1], ['1', 3], ['2', 2], ['1', 1], ['2', 3], ['1', 1], ['2', 3])
  const result = analyzeV105ShadowV8RoadRhythm(current)
  assert.equal(result.expectedColor, '1')
  assert.equal(result.reason, 'repeated_run_rhythm')
})

test('V8 never assumes a five-blue dragon is finished before an actual color change', () => {
  const current = seq(['1', 2], ['2', 1], ['1', 1], ['2', 2], ['1', 1], ['2', 5])
  const result = analyzeV105ShadowV8RoadRhythm(current)
  assert.equal(result.expectedColor, '2')
  assert.equal(result.reason, 'long_run_continuation')
})

test('V8 abstains when near6 just changed and near12 supports two plausible continuations', () => {
  const current = seq(['2', 4], ['1', 4], ['2', 1], ['1', 1], ['2', 2])
  const result = analyzeV105ShadowV8RoadRhythm(current)
  assert.equal(result.expectedColor, null)
  assert.equal(result.reason, 'transition_ambiguous')
})

test('V8 near12 main window cannot inherit a same-color run hidden behind twenty old opposite beads', () => {
  const current = seq(['1', 10], ['2', 20], ['1', 1])
  const result = analyzeV105ShadowV8RoadRhythm(current)
  assert.deepEqual(result.windows.near12, seq(['2', 11], ['1', 1]))
  assert.equal(result.expectedColor, null)
  assert.equal(result.reason, 'insufficient_rhythm_data')
})
