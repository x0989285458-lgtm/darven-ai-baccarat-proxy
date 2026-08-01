export function createRetryingStartup({
  start,
  onReady = () => {},
  onError = () => {},
  baseDelayMs = 1000,
  maxDelayMs = 30000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (typeof start !== 'function') throw new Error('startup function is required')
  let stopped = false
  let ready = false
  let attempt = 0
  let timer = null
  let inFlight = null

  function scheduleRetry() {
    if (stopped || ready || timer || inFlight) return
    const delay = Math.min(
      Math.max(1, Number(maxDelayMs) || 30000),
      Math.max(1, Number(baseDelayMs) || 1000) * (2 ** Math.min(attempt - 1, 10)),
    )
    timer = setTimer(() => {
      timer = null
      void begin()
    }, delay)
  }

  function begin() {
    if (stopped || ready) return Promise.resolve(false)
    if (inFlight) return inFlight
    let retry = false
    const current = (async () => {
      try {
        await start()
        if (stopped) return false
        ready = true
        await onReady()
        return true
      } catch (error) {
        if (!stopped) {
          attempt += 1
          try { await onError(error, attempt) } catch {}
          retry = true
        }
        return false
      }
    })()
    const wrapped = current.finally(() => {
      if (inFlight === wrapped) inFlight = null
      if (retry) scheduleRetry()
    })
    inFlight = wrapped
    return wrapped
  }

  async function stop() {
    stopped = true
    if (timer) clearTimer(timer)
    timer = null
    const current = inFlight
    if (current) await current
  }

  return {
    begin,
    stop,
    snapshot: () => ({ stopped, ready, attempt, retryScheduled: Boolean(timer), inFlight: Boolean(inFlight) }),
  }
}
