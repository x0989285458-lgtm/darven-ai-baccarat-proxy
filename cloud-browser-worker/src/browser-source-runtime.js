export function createBrowserSourceRuntime({
  sourceOwner,
  previousLease,
  renewalMs = 5_000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  stopSocket = async () => {},
} = {}) {
  if (!sourceOwner || typeof sourceOwner.takeover !== 'function' || typeof sourceOwner.renew !== 'function'
    || typeof sourceOwner.nextEventSource !== 'function' || typeof sourceOwner.stop !== 'function') {
    throw new Error('browser_source_runtime_dependencies_required')
  }
  let lease = null
  let timer = null
  let started = false
  let stopping = false
  let lastError = null
  let renewTail = Promise.resolve()

  async function start() {
    if (started) return
    lease = await sourceOwner.takeover({ previous: previousLease })
    started = true
    stopping = false
    timer = setIntervalFn(() => {
      renewTail = renewTail.then(async () => {
        if (!started || stopping) return
        lease = await sourceOwner.renew(sourceOwner.lease?.() ?? lease)
        lastError = null
      }).catch((error) => {
        lastError = String(error?.message ?? error)
      })
      return renewTail
    }, Math.max(1, Number(renewalMs) || 1))
    timer?.unref?.()
  }

  async function nextEventSource() {
    if (!started || stopping) throw new Error('browser_source_runtime_not_active')
    return sourceOwner.nextEventSource(sourceOwner.lease?.() ?? lease)
  }

  async function stop() {
    if (!started) return
    stopping = true
    if (timer) clearIntervalFn(timer)
    timer = null
    await renewTail
    await stopSocket()
    const current = sourceOwner.lease?.() ?? lease
    if (current) await sourceOwner.stop(current)
    lease = null
    started = false
    stopping = false
  }

  return {
    start, stop, nextEventSource,
    lease: () => sourceOwner.lease?.() ?? lease,
    snapshot: () => ({ started, stopping, lastError }),
  }
}
