import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveProductionConcurrency } from '../src/server.js'

test('production runtime defaults identity to nine and priority to eight while accepting bounded overrides', () => {
  assert.deepEqual(resolveProductionConcurrency({}), {
    formalIdentityConcurrency: 9,
    strategyPriorityConcurrency: 8,
  })
  assert.deepEqual(resolveProductionConcurrency({
    V100_FORMAL_IDENTITY_CONCURRENCY: '6',
    STRATEGY_PRIORITY_CONCURRENCY: '6',
  }), {
    formalIdentityConcurrency: 6,
    strategyPriorityConcurrency: 6,
  })
})

test('production runtime concurrency rejects environment values outside 1 through 9', () => {
  for (const value of ['0', '10', '1.5', 'nope']) {
    assert.throws(
      () => resolveProductionConcurrency({ V100_FORMAL_IDENTITY_CONCURRENCY: value }),
      /V100_FORMAL_IDENTITY_CONCURRENCY.*1.*9/,
    )
    assert.throws(
      () => resolveProductionConcurrency({ STRATEGY_PRIORITY_CONCURRENCY: value }),
      /STRATEGY_PRIORITY_CONCURRENCY.*1.*8/,
    )
  }
  assert.throws(
    () => resolveProductionConcurrency({ STRATEGY_PRIORITY_CONCURRENCY: '9' }),
    /STRATEGY_PRIORITY_CONCURRENCY.*1.*8/,
  )
})
