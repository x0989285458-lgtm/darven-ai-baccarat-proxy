import test from 'node:test'
import assert from 'node:assert/strict'
import { createFixedWindowRateLimiter } from '../src/server-policy.js'

test('snapshot limiter permits 12 requests per source per minute then returns Retry-After', () => {
  let now = 1_000
  const limiter = createFixedWindowRateLimiter({ limit: 12, windowMs: 60_000, now: () => now })
  for (let index = 0; index < 12; index += 1) assert.equal(limiter.check('source').allowed, true)
  const blocked = limiter.check('source')
  assert.equal(blocked.allowed, false)
  assert.ok(blocked.retryAfter >= 1)
  now += 60_000
  assert.equal(limiter.check('source').allowed, true)
})
