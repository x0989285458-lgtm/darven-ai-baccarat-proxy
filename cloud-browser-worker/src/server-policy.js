export function createFixedWindowRateLimiter({ limit = 12, windowMs = 60000, maxSources = 10000, now = Date.now } = {}) {
  const sources = new Map()

  function check(source = '') {
    const timestamp = Number(now())
    const key = String(source || 'unknown')
    const current = sources.get(key)
    if (!current || timestamp >= current.resetAt) {
      if (!current && sources.size >= Math.max(1, Number(maxSources) || 10000)) {
        for (const [sourceKey, bucket] of sources) {
          if (timestamp >= bucket.resetAt) sources.delete(sourceKey)
        }
        while (sources.size >= Math.max(1, Number(maxSources) || 10000)) {
          sources.delete(sources.keys().next().value)
        }
      }
      sources.set(key, { count: 1, resetAt: timestamp + windowMs })
      return { allowed: true, retryAfter: 0 }
    }
    if (current.count >= limit) {
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((current.resetAt - timestamp) / 1000)) }
    }
    current.count += 1
    return { allowed: true, retryAfter: 0 }
  }

  return { check }
}
