const EXPECTED_SETTLEMENT_NOOPS = new Map([
  ['v105-v9', 'v105 shadow v9 settlement has no immutable issuance'],
  ['v105-v10', 'v105 shadow v10 settlement has no immutable issuance'],
])
const NON_BLOCKING_RUNTIME_KEYS = new Set(['v105-v10'])
const MAX_CONCURRENT_RUNTIME_OPERATIONS = 9
const MAX_QUEUED_BEST_EFFORT_CAPTURES = 2
const MAX_MERGED_BEST_EFFORT_IDENTITIES = 2000
const hydrationStates = new WeakMap()
const hydrationSchedulers = new WeakMap()
const bestEffortSchedulers = new WeakMap()

export function prepareShadowRuntimes(runtimes, { nonBlockingRuntimeKeys = NON_BLOCKING_RUNTIME_KEYS } = {}) {
  const entries = enabledRuntimeEntries(runtimes)
  const requiredEntries = entries.filter(([runtimeKey]) => !nonBlockingRuntimeKeys.has(runtimeKey))
  const scheduler = hydrationScheduler(runtimes)
  for (const [, runtime] of entries) {
    const current = hydrationStates.get(runtime)
    queueRuntimeHydration(scheduler, runtime, { retryFailed: current?.status === 'error' && current.failureObserved === true })
  }
  pumpHydrationScheduler(scheduler)
  const states = requiredEntries.map(([, runtime]) => hydrationStates.get(runtime))
  const failures = entries.flatMap(([runtimeKey, runtime]) => {
    const state = hydrationStates.get(runtime)
    if (state?.status !== 'error' || state.failureObserved === true) return []
    state.failureObserved = true
    return [{ runtime: runtimeKey, stage: 'hydrate', code: state.errorCode ?? 'runtime_error' }]
  })
  const blockingFailures = failures.filter((failure) => !nonBlockingRuntimeKeys.has(failure.runtime))
  if (blockingFailures.length > 0) throwRuntimeDiagnostics(blockingFailures)
  return {
    enabled: requiredEntries.length,
    prepared: states.filter((state) => state?.status === 'ready').length,
    pending: states.filter((state) => state?.status === 'pending').length,
    queued: states.filter((state) => state?.status === 'queued').length,
    failed: states.filter((state) => state?.status === 'error').length,
    disabled: Math.max(0, runtimes.size - entries.length),
  }
}

export async function waitForShadowRuntimesReady(runtimes, options = {}) {
  for (;;) {
    const readiness = prepareShadowRuntimes(runtimes, options)
    if (readiness.prepared === readiness.enabled
      && readiness.pending === 0
      && readiness.queued === 0
      && readiness.failed === 0) return readiness

    const pending = enabledRuntimeEntries(runtimes)
      .map(([, runtime]) => hydrationStates.get(runtime)?.promise)
      .filter(Boolean)
    if (pending.length > 0) await Promise.allSettled(pending)
    else await new Promise((resolve) => setImmediate(resolve))
  }
}

export async function processShadowCapture(runtimes, payload = {}, { nonBlockingRuntimeKeys = NON_BLOCKING_RUNTIME_KEYS } = {}) {
  const entries = enabledRuntimeEntries(runtimes)
  const requiredEntries = entries.filter(([runtimeKey]) => !nonBlockingRuntimeKeys.has(runtimeKey))
  const bestEffortEntries = entries.filter(([runtimeKey]) => nonBlockingRuntimeKeys.has(runtimeKey))
  prepareShadowRuntimes(runtimes, { nonBlockingRuntimeKeys })
  await new Promise((resolve) => setImmediate(resolve))
  const readyEntries = requiredEntries.filter(([, runtime]) => hydrationStates.get(runtime)?.status === 'ready')
  const unavailable = requiredEntries.flatMap(([runtimeKey, runtime]) => {
    const state = hydrationStates.get(runtime)
    if (state?.status === 'ready') return []
    return [{ runtime: runtimeKey, stage: 'hydrate', code: state?.errorCode ?? 'not_ready' }]
  })
  const summary = { observed: 0, settled: 0, noops: 0 }
  const tables = Array.isArray(payload.tables) ? payload.tables : []
  const rounds = Array.isArray(payload.rounds) ? payload.rounds : []
  if ((tables.length > 0 || rounds.length > 0) && unavailable.length > 0) throwRuntimeDiagnostics(unavailable)
  await runIdentityPhase(readyEntries, tables, 'observeTable', {}, (results) => {
    summary.observed += results.filter((result) => result.status === 'fulfilled').length
  })
  await runIdentityPhase(readyEntries, rounds, 'settleRound', { allowSettlementNoop: true }, (results) => {
    for (const result of results) {
      if (result.status !== 'fulfilled') continue
      if (result.value?.noop === true) summary.noops += 1
      else summary.settled += 1
    }
  })
  const bestEffort = await enqueueBestEffortCapture(runtimes, bestEffortEntries, tables, rounds)
  if (bestEffort.coalesced > 0) summary.bestEffortCoalesced = bestEffort.coalesced
  if (bestEffort.rejected > 0) summary.bestEffortRejected = bestEffort.rejected
  return summary
}

async function runBestEffortCapture(entries, tables, rounds) {
  await runIdentityPhase(entries, tables, 'observeTable', {}, () => {})
  await runIdentityPhase(entries, rounds, 'settleRound', { allowSettlementNoop: true }, () => {})
}

async function enqueueBestEffortCapture(runtimes, entries, tables, rounds) {
  if (entries.length === 0 || (tables.length === 0 && rounds.length === 0)) return { coalesced: 0, rejected: 0 }
  const scheduler = bestEffortScheduler(runtimes)
  if (scheduler.queue.length >= MAX_QUEUED_BEST_EFFORT_CAPTURES) {
    const pending = scheduler.queue[scheduler.queue.length - 1]
    const mergedTables = mergeBestEffortIdentities(pending.tables, tables, tableObservationIdentity)
    const mergedRounds = mergeBestEffortIdentities(pending.rounds, rounds, settlementIdentity)
    pending.tables = mergedTables.items
    pending.rounds = mergedRounds.items
    return { coalesced: 1, rejected: mergedTables.rejected + mergedRounds.rejected }
  }
  scheduler.queue.push({
    entries: entries.slice(),
    tables: structuredClone(tables),
    rounds: structuredClone(rounds),
  })
  pumpBestEffortScheduler(scheduler)
  return { coalesced: 0, rejected: 0 }
}

export function waitForBestEffortShadowWorkIdle(runtimes) {
  const scheduler = bestEffortScheduler(runtimes)
  if (!scheduler.active && scheduler.queue.length === 0) return Promise.resolve()
  return new Promise((resolve) => scheduler.idleWaiters.add(resolve))
}

function bestEffortScheduler(runtimes) {
  let scheduler = bestEffortSchedulers.get(runtimes)
  if (!scheduler) {
    scheduler = { queue: [], active: null, idleWaiters: new Set() }
    bestEffortSchedulers.set(runtimes, scheduler)
  }
  return scheduler
}

function pumpBestEffortScheduler(scheduler) {
  if (scheduler.active || scheduler.queue.length === 0) return
  const job = scheduler.queue.shift()
  scheduler.active = job
  void runBestEffortWithRetry(job).finally(() => {
    if (scheduler.active === job) scheduler.active = null
    pumpBestEffortScheduler(scheduler)
    if (!scheduler.active && scheduler.queue.length === 0) {
      for (const resolve of scheduler.idleWaiters) resolve()
      scheduler.idleWaiters.clear()
    }
  })
}

function mergeBestEffortIdentities(existing, incoming, identity) {
  const merged = new Map()
  for (const item of existing) merged.set(identity(item), structuredClone(item))
  for (const item of incoming) merged.set(identity(item), structuredClone(item))
  let rejected = 0
  while (merged.size > MAX_MERGED_BEST_EFFORT_IDENTITIES) {
    merged.delete(merged.keys().next().value)
    rejected += 1
  }
  return { items: [...merged.values()], rejected }
}

function tableObservationIdentity(table = {}) {
  return JSON.stringify([
    String(table.source ?? 'ofalive99'), String(table.tableId ?? ''),
    String(table.shoe ?? ''), Number(table.round) + 1,
  ])
}

function settlementIdentity(round = {}) {
  return JSON.stringify([
    String(round.source ?? 'ofalive99'), String(round.tableId ?? ''),
    String(round.shoe ?? ''), Number(round.round),
  ])
}

async function runBestEffortWithRetry(job) {
  for (;;) {
    try {
      await runBestEffortCapture(job.entries, job.tables, job.rounds)
      return
    } catch {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 25)
        timer.unref?.()
      })
    }
  }
}

function hydrationScheduler(runtimes) {
  let scheduler = hydrationSchedulers.get(runtimes)
  if (!scheduler) {
    scheduler = { queue: [], active: null }
    hydrationSchedulers.set(runtimes, scheduler)
  }
  return scheduler
}

function queueRuntimeHydration(scheduler, runtime, { retryFailed = false } = {}) {
  const current = hydrationStates.get(runtime)
  if (current?.status === 'ready' || current?.status === 'pending' || current?.status === 'queued') return current
  if (current?.status === 'error' && retryFailed !== true) return current
  const state = { status: 'queued', errorCode: null, failureObserved: false, promise: null, scheduler }
  hydrationStates.set(runtime, state)
  scheduler.queue.push(runtime)
  return state
}

function pumpHydrationScheduler(scheduler) {
  if (scheduler.active) return
  let runtime = null
  while (scheduler.queue.length > 0 && !runtime) {
    const candidate = scheduler.queue.shift()
    if (hydrationStates.get(candidate)?.status === 'queued') runtime = candidate
  }
  if (!runtime) return
  const state = hydrationStates.get(runtime)
  scheduler.active = runtime
  state.status = 'pending'
  state.promise = Promise.resolve()
    .then(() => runtime.start?.())
    .then(() => {
      state.status = 'ready'
      state.errorCode = null
    })
    .catch((error) => {
      state.status = 'error'
      state.errorCode = classifyRuntimeError(error)
    })
    .finally(() => {
      state.promise = null
      if (scheduler.active === runtime) scheduler.active = null
      pumpHydrationScheduler(scheduler)
    })
}

function enabledRuntimeEntries(runtimes) {
  return [...runtimes.entries()].filter(([, runtime]) => runtime?.enabled === true)
}

async function runIdentityPhase(entries, payloads, method, options, summarize) {
  const groups = []
  const byTable = new Map()
  for (const payload of payloads) {
    const tableId = String(payload?.tableId ?? '')
    let group = byTable.get(tableId)
    if (!group) {
      group = []
      byTable.set(tableId, group)
      groups.push(group)
    }
    group.push(payload)
  }
  const concurrency = Math.max(1, Math.floor(MAX_CONCURRENT_RUNTIME_OPERATIONS / Math.max(1, entries.length)))
  for (let offset = 0; offset < groups.length; offset += concurrency) {
    const batch = await Promise.allSettled(groups.slice(offset, offset + concurrency).map(async (group) => {
      for (const payload of group) {
        const results = await runRuntimeWave(entries, method, payload, options)
        throwRuntimeFailures(entries, results, method)
        summarize(results)
      }
    }))
    throwIdentityFailures(batch)
  }
}

function runRuntimeWave(entries, method, payload, { allowSettlementNoop = false } = {}) {
  return Promise.allSettled(entries.map(async ([runtimeKey, runtime]) => {
    const startedAt = Date.now()
    try {
      await runtime[method](structuredClone(payload))
      return { runtime: runtimeKey, elapsedMs: Date.now() - startedAt, noop: false }
    } catch (error) {
      if (allowSettlementNoop && String(error?.message ?? error) === EXPECTED_SETTLEMENT_NOOPS.get(runtimeKey)) {
        return { runtime: runtimeKey, elapsedMs: Date.now() - startedAt, noop: true }
      }
      throw error
    }
  }))
}

function throwRuntimeFailures(entries, results, stage) {
  const diagnostics = []
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index]
    if (result.status !== 'rejected') continue
    diagnostics.push({
      runtime: entries[index][0],
      stage,
      code: classifyRuntimeError(result.reason),
    })
  }
  if (diagnostics.length === 0) return
  throwRuntimeDiagnostics(diagnostics)
}

function throwRuntimeDiagnostics(diagnostics) {
  const error = new Error(`shadow runtime batch failed (${diagnostics.map((item) => `${item.runtime}:${item.stage}:${item.code}`).join(',')})`)
  error.code = 'SHADOW_RUNTIME_BATCH_FAILED'
  error.diagnostics = diagnostics
  throw error
}

function throwIdentityFailures(results) {
  const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason)
  if (failures.length === 0) return
  if (failures.length === 1) throw failures[0]
  const diagnostics = failures.flatMap((error) => Array.isArray(error?.diagnostics) ? error.diagnostics : [])
  const error = new Error(`shadow runtime batch failed (${diagnostics.map((item) => `${item.runtime}:${item.stage}:${item.code}`).join(',')})`)
  error.code = 'SHADOW_RUNTIME_BATCH_FAILED'
  error.diagnostics = diagnostics
  throw error
}

function classifyRuntimeError(error) {
  const text = String(error?.message ?? error ?? '').toLowerCase()
  if (/timeout|timed out|abort/.test(text)) return 'timeout'
  if (/ssl|tls|certificate|self signed/.test(text)) return 'db_ssl'
  if (/econn|enotfound|fetch failed|network|socket|connect/.test(text)) return 'db_connection'
  if (/\b(?:401|403)\b|unauthori|forbidden/.test(text)) return 'db_auth'
  if (/\b(?:429)\b|rate limit/.test(text)) return 'rate_limited'
  if (/\b5\d\d\b|database|postgrest|rpc/.test(text)) return 'db_request'
  return 'runtime_error'
}
