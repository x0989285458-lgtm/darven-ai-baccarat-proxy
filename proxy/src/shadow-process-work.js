const EXPECTED_SETTLEMENT_NOOPS = new Map([
  ['v105', 'v105 shadow settlement has no immutable issuance'],
  ['v105-v7', 'v105 shadow v7 settlement has no immutable issuance'],
  ['v105-v8', 'v105 shadow v8 settlement has no immutable issuance'],
  ['v105-v9', 'v105 shadow v9 settlement has no immutable issuance'],
])
const MAX_CONCURRENT_RUNTIME_OPERATIONS = 9

export async function prepareShadowRuntimes(runtimes) {
  const entries = enabledRuntimeEntries(runtimes)
  const results = await Promise.allSettled(entries.map(async ([runtimeKey, runtime]) => {
    const startedAt = Date.now()
    await runtime.start?.()
    return { runtime: runtimeKey, elapsedMs: Date.now() - startedAt }
  }))
  throwRuntimeFailures(entries, results, 'hydrate')
  return { prepared: entries.length, disabled: Math.max(0, runtimes.size - entries.length) }
}

export async function processShadowCapture(runtimes, payload = {}) {
  const entries = enabledRuntimeEntries(runtimes)
  const summary = { observed: 0, settled: 0, noops: 0 }
  await runIdentityPhase(entries, Array.isArray(payload.tables) ? payload.tables : [], 'observeTable', {}, (results) => {
    summary.observed += results.filter((result) => result.status === 'fulfilled').length
  })
  await runIdentityPhase(entries, Array.isArray(payload.rounds) ? payload.rounds : [], 'settleRound', { allowSettlementNoop: true }, (results) => {
    for (const result of results) {
      if (result.status !== 'fulfilled') continue
      if (result.value?.noop === true) summary.noops += 1
      else summary.settled += 1
    }
  })
  return summary
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
