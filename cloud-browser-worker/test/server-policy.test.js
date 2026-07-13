import test from 'node:test'
import assert from 'node:assert/strict'
import { createFixedWindowRateLimiter } from '../src/server-policy.js'

test('snapshot limiter allows 12 requests per source per minute and returns Retry-After', () => {
  let clock = 0
  const limiter = createFixedWindowRateLimiter({ limit: 12, windowMs: 60000, now: () => clock })

  for (let count = 0; count < 12; count += 1) {
    assert.deepEqual(limiter.check('source-a'), { allowed: true, retryAfter: 0 })
  }
  assert.deepEqual(limiter.check('source-a'), { allowed: false, retryAfter: 60 })
  assert.deepEqual(limiter.check('source-b'), { allowed: true, retryAfter: 0 })

  clock = 60000
  assert.deepEqual(limiter.check('source-a'), { allowed: true, retryAfter: 0 })
})

test('snapshot limiter bounds retained source state', () => {
  const limiter = createFixedWindowRateLimiter({ limit: 1, windowMs: 60000, maxSources: 2, now: () => 0 })

  assert.equal(limiter.check('source-a').allowed, true)
  assert.equal(limiter.check('source-a').allowed, false)
  assert.equal(limiter.check('source-b').allowed, true)
  assert.equal(limiter.check('source-c').allowed, true)
  assert.equal(limiter.check('source-a').allowed, true, 'oldest source bucket is evicted once capacity is reached')
})
