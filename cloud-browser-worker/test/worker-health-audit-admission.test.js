import test from 'node:test'
import assert from 'node:assert/strict'
import { buildWorkerHealth } from '../src/worker-health.js'

test('public health preserves exact audit admission counters rather than dropping them', () => {
  for (const counters of [{ inFlight: 0, archivedRoundKeyCount: 0 }, { inFlight: 1, archivedRoundKeyCount: 7 }]) {
    const health = buildWorkerHealth({ push: counters })
    assert.equal(health.push.inFlight, counters.inFlight)
    assert.equal(health.push.archivedRoundKeyCount, counters.archivedRoundKeyCount)
  }
})

test('unknown audit admission counters never become a false zero', () => {
  for (const value of [undefined, null, false, true, '0', -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const health = buildWorkerHealth({ push: { inFlight: value, archivedRoundKeyCount: value } })
    assert.equal(health.push.inFlight, null)
    assert.equal(health.push.archivedRoundKeyCount, null)
  }
})
