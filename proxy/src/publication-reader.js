// A commit hint wakes a bounded waiter; it is never data or write authority.
export function createPublicationReader({ load, waitMs = 1000, cacheMs = 100, now = Date.now } = {}) {
  if (typeof load !== 'function') throw new TypeError('publication loader is required')
  const budget = Math.max(1, Number(waitMs) || 1000)
  const refreshMs = Math.min(100, Math.max(1, Math.floor(budget / 4)))
  let stopped = false, epoch = 0, flight = null, cached = null
  const wake = new Set(), stopWaiters = new Set()
  const error = (code) => Object.assign(new Error(code), { code })
  function snapshot() {
    const ttl = cached?.rows.every(row => row?.publication?.state === 'ready') ? cacheMs : Math.min(cacheMs, refreshMs)
    if (cached && cached.epoch === epoch && now() - cached.at < ttl) return Promise.resolve({ rows: cached.rows, epoch: cached.epoch })
    if (flight) return flight
    const startedEpoch = epoch
    const current = Promise.resolve().then(load).then(rows => {
      if (!Array.isArray(rows)) throw error('PUBLICATION_INVALID_SNAPSHOT')
      const copy = structuredClone(rows)
      if (!stopped && epoch === startedEpoch) cached = { rows: copy, epoch, at: now() }
      return { rows: copy, epoch: startedEpoch }
    }).finally(() => { if (flight === current) flight = null })
    flight = current
    return current
  }
  function awaitRead(promise, deadline) {
    return new Promise((resolve, reject) => {
      let done = false
      const finish = (fn, value) => {
        if (done) return
        done = true; clearTimeout(timer); stopWaiters.delete(onStop); fn(value)
      }
      const onStop = () => finish(reject, error('PUBLICATION_READER_STOPPED'))
      // Only the caller's deadline ends polling. Loader failures still reject;
      // the read loop decides whether its last snapshot is safe to return.
      const timer = setTimeout(() => finish(resolve, null), Math.max(0, deadline - now()))
      stopWaiters.add(onStop)
      promise.then(value => finish(resolve, value), cause => finish(reject, cause))
      if (stopped) onStop()
    })
  }
  function awaitHint(observed, deadline) {
    return new Promise(resolve => {
      let done = false
      const finish = () => {
        if (done) return
        done = true; clearTimeout(timer); wake.delete(finish); stopWaiters.delete(finish); resolve()
      }
      const timer = setTimeout(finish, Math.max(0, deadline - now()))
      wake.add(finish); stopWaiters.add(finish)
      if (epoch !== observed || stopped) finish()
    })
  }
  return {
    async read() {
      if (stopped) throw error('PUBLICATION_READER_STOPPED')
      const deadline = now() + budget
      // Lost hints cannot strand a commit after the first refresh. Pending
      // snapshots expire on a shared cadence; all waiters retain one flight
      // and the original deadline, without clearing another waiter's cache.
      let last = null, lastEpoch = -1
      while (!stopped && now() < deadline) {
        const observed = epoch
        const result = await awaitRead(snapshot(), deadline)
        if (result === null) break
        last = result.rows
        lastEpoch = result.epoch
        if (stopped) throw error('PUBLICATION_READER_STOPPED')
        // A hint received during a read requires a serial fresh snapshot, never
        // eviction of the unsettled IO or a second parallel database read.
        if (epoch !== observed || lastEpoch !== epoch) continue
        if (last.length && last.every(row => row?.publication?.state === 'ready')) return structuredClone(last)
        await awaitHint(observed, Math.min(deadline, now() + refreshMs))
      }
      if (stopped) throw error('PUBLICATION_READER_STOPPED')
      if (last && lastEpoch === epoch) return structuredClone(last)
      throw error('PUBLICATION_READ_TIMEOUT')
    },
    notify() {
      if (stopped) return
      epoch += 1; cached = null
      for (const resume of [...wake]) resume()
    },
    stop() {
      if (stopped) return
      stopped = true; cached = null
      for (const cancel of [...stopWaiters]) cancel()
    },
  }
}
