import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { scrubDirectDatabaseEnv } from './shadow-process-env.js'

const REQUIRED_RUNTIME_KEYS = new Set(['v103', 'v104', 'v104-iteration', 'v105-v9'])
const V10_RUNTIME_KEY = 'v105-v10'
const RUNTIME_KEYS = new Set([...REQUIRED_RUNTIME_KEYS, V10_RUNTIME_KEY])
const RUNTIME_SCOPES = new Set(['required', V10_RUNTIME_KEY])
const CHILD_ENV_ALLOWLIST = [
  'NODE_ENV', 'TZ',
  'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY', 'SUPABASE_DB_CONNECTION_STRING',
  'SUPABASE_REQUEST_TIMEOUT_MS', 'DURABLE_INGEST_REQUEST_TIMEOUT_MS',
  'V103_SHADOW_ENABLED', 'V104_SHADOW_ENABLED', 'V104_ITERATION_SHADOW_ENABLED',
  'V105_SHADOW_V9_ENABLED', 'V105_SHADOW_V10_ENABLED',
]
const V10_MAX_QUEUED_CAPTURES = 2
const V10_MAX_IDENTITIES = 2000
const DISABLED_READINESS = Object.freeze({ enabled: 0, prepared: 0, pending: 0, queued: 0, failed: 0, disabled: 1 })

function buildChildEnv(source = {}, scope) {
  if (!RUNTIME_SCOPES.has(scope)) throw new Error('unknown shadow process runtime scope')
  const target = { SHADOW_PROCESS_CHILD: '1', SHADOW_PROCESS_RUNTIME_SCOPE: scope }
  for (const key of CHILD_ENV_ALLOWLIST) {
    if (source[key] != null) target[key] = String(source[key])
  }
  if (scope === V10_RUNTIME_KEY) scrubDirectDatabaseEnv(target)
  return target
}

function safeErrorMessage(value) {
  const text = String(value ?? 'shadow process request failed')
  return text
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/(?:password|token|secret|api[_-]?key)\s*[:=]\s*\S+/gi, '[REDACTED]')
    .slice(0, 500)
}

function createScopedProcessLane({
  scope,
  runtimeKeys,
  enabled = true,
  forkImpl,
  workerPath,
  env,
  requestTimeoutMs,
  startupTimeoutMs,
  killGraceMs,
  killConfirmMs,
}) {
  let child = null
  let generation = 0
  let nextId = 1
  let stopping = false
  let terminating = null
  let terminationFailure = null
  let lastFailure = null
  let lastSuccess = null
  const pending = new Map()
  const snapshots = new Map()

  function rejectGeneration(targetGeneration, reason) {
    for (const [id, request] of pending) {
      if (request.generation !== targetGeneration) continue
      pending.delete(id)
      clearTimeout(request.timer)
      request.signal?.removeEventListener?.('abort', request.onAbort)
      request.reject(reason)
    }
  }

  function terminate(target, reason = new Error('shadow process terminated')) {
    if (!target) return Promise.resolve()
    if (target.__terminationPromise) return target.__terminationPromise
    target.__terminating = true
    target.__terminationReason = reason
    const targetGeneration = target.__shadowGeneration
    let forceTimer = null
    let confirmTimer = null
    let settled = false

    const terminationPromise = new Promise((resolve, reject) => {
      const finish = (error = null) => {
        if (settled) return
        settled = true
        clearTimeout(forceTimer)
        clearTimeout(confirmTimer)
        target.removeListener?.('exit', onExit)
        if (error) {
          error.code = 'SHADOW_PROCESS_TERMINATION_UNCONFIRMED'
          terminationFailure = error
          lastFailure = {
            at: new Date().toISOString(),
            kind: 'termination',
            code: error.code,
            diagnostics: [],
          }
          rejectGeneration(targetGeneration, error)
          reject(error)
        } else {
          if (child === target) child = null
          resolve()
        }
      }
      const onExit = () => finish()
      target.once('exit', onExit)
      try { target.kill('SIGTERM') } catch {}
      forceTimer = setTimeout(() => {
        try { if (target.exitCode == null && target.signalCode == null) target.kill('SIGKILL') } catch {}
      }, Math.max(1, Number(killGraceMs) || 1000))
      forceTimer.unref?.()
      confirmTimer = setTimeout(() => {
        finish(new Error('shadow process termination could not be confirmed'))
      }, Math.max(Number(killGraceMs) + 1, Number(killConfirmMs) || 3000))
      confirmTimer.unref?.()
    })
    target.__terminationPromise = terminationPromise
    terminating = terminationPromise
    void terminationPromise.finally(() => {
      if (terminating === terminationPromise) terminating = null
    }).catch(() => {})
    return terminationPromise
  }

  async function ensureChild() {
    if (enabled !== true) throw new Error('shadow process scope is disabled')
    if (stopping) throw new Error('shadow process client is stopping')
    if (terminating) await terminating
    if (terminationFailure) throw terminationFailure
    if (child?.connected && child.exitCode == null && child.signalCode == null && child.__terminating !== true) return child
    const targetGeneration = ++generation
    const resolvedWorkerPath = workerPath ?? fileURLToPath(new URL('./shadow-process-worker.js', import.meta.url))
    const spawned = forkImpl(resolvedWorkerPath, [], {
      env: buildChildEnv(env, scope),
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      serialization: 'advanced',
    })
    spawned.__shadowGeneration = targetGeneration
    spawned.on('message', (message) => {
      if (spawned.__terminating === true || !message || message.type !== 'response') return
      const request = pending.get(message.id)
      if (!request || request.generation !== targetGeneration) return
      pending.delete(message.id)
      clearTimeout(request.timer)
      request.signal?.removeEventListener?.('abort', request.onAbort)
      if (message.snapshots && typeof message.snapshots === 'object') {
        for (const [key, value] of Object.entries(message.snapshots)) {
          if (runtimeKeys.has(key)) snapshots.set(key, value)
        }
      }
      if (message.ok === true) {
        lastSuccess = { at: new Date().toISOString(), kind: request.kind, result: safeResult(message.result) }
        request.resolve(message.result ?? null)
      } else {
        const remoteError = createRemoteError(message.error)
        lastFailure = { at: new Date().toISOString(), kind: request.kind, code: remoteError.code, diagnostics: remoteError.diagnostics }
        request.reject(remoteError)
      }
    })
    spawned.once('error', (error) => { void terminate(spawned, new Error(safeErrorMessage(error?.message))) })
    spawned.once('exit', (code, signal) => {
      if (child === spawned) child = null
      const reason = spawned.__terminationReason ?? new Error(`shadow process exited (${code ?? signal ?? 'unknown'})`)
      rejectGeneration(targetGeneration, reason)
    })
    child = spawned
    return spawned
  }

  async function sendRequest(message, { signal, timeoutMs = requestTimeoutMs } = {}) {
    const target = await ensureChild()
    const id = nextId++
    const targetGeneration = target.__shadowGeneration
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        lastFailure = { at: new Date().toISOString(), kind: message.kind, code: 'SHADOW_PROCESS_REQUEST_ABORTED', diagnostics: [] }
        void terminate(target, new Error('shadow process request aborted'))
      }
      const timer = setTimeout(() => {
        lastFailure = { at: new Date().toISOString(), kind: message.kind, code: 'SHADOW_PROCESS_REQUEST_TIMEOUT', diagnostics: [] }
        void terminate(target, new Error('shadow process request timeout'))
      }, Math.max(1, Number(timeoutMs) || 15000))
      timer.unref?.()
      pending.set(id, { resolve, reject, timer, signal, onAbort, generation: targetGeneration, kind: message.kind })
      if (signal?.aborted) return onAbort()
      signal?.addEventListener?.('abort', onAbort, { once: true })
      try {
        target.send({ type: 'request', id, ...structuredClone(message) }, (error) => {
          if (error) void terminate(target, new Error('shadow process IPC send failed'))
        })
      } catch {
        void terminate(target, new Error('shadow process IPC send failed'))
      }
    })
  }

  function request(runtime, method, payload, options = {}) {
    if (!runtimeKeys.has(runtime)) return Promise.reject(new Error('shadow runtime is outside process scope'))
    if (!['observeTable', 'settleRound'].includes(method)) return Promise.reject(new Error('unknown shadow process method'))
    return sendRequest({ kind: 'runtime', runtime, method, payload }, options)
  }

  function processCapture(payload, options = {}) {
    return sendRequest({ kind: 'capture', payload }, options)
  }

  function prepare(options = {}) {
    if (enabled !== true) return Promise.resolve(structuredClone(DISABLED_READINESS))
    return sendRequest({ kind: 'prepare' }, { timeoutMs: startupTimeoutMs, ...options })
  }

  async function stop() {
    stopping = true
    if (terminating) await terminating
    if (child) await terminate(child, new Error('shadow process client stopped'))
    if (terminationFailure) throw terminationFailure
  }

  function status() {
    return {
      scope,
      enabled: enabled === true,
      running: Boolean(child && (terminationFailure || child.connected)),
      pid: Number.isSafeInteger(child?.pid) && child.pid > 0 ? child.pid : null,
      generation,
      pending: pending.size,
      stopping,
      terminating: Boolean(terminating),
      terminationFailed: Boolean(terminationFailure),
      phase: terminationFailure ? 'fatal' : terminating ? 'terminating' : stopping ? 'stopped' : 'ready',
      code: terminationFailure ? 'SHADOW_PROCESS_TERMINATION_UNCONFIRMED' : null,
      lastFailure: structuredClone(lastFailure),
      lastSuccess: structuredClone(lastSuccess),
    }
  }

  return {
    request,
    prepare,
    processCapture,
    snapshot: (key) => structuredClone(snapshots.get(key) ?? null),
    stop,
    status,
  }
}

export function createShadowProcessClient({
  forkImpl = fork,
  workerPath = null,
  env = process.env,
  requestTimeoutMs = Number(process.env.SHADOW_PROCESS_REQUEST_TIMEOUT_MS ?? 15000),
  startupTimeoutMs = Number(process.env.SHADOW_PROCESS_STARTUP_TIMEOUT_MS ?? 60000),
  killGraceMs = Number(process.env.SHADOW_PROCESS_KILL_GRACE_MS ?? 1000),
  killConfirmMs = Number(process.env.SHADOW_PROCESS_KILL_CONFIRM_MS ?? 3000),
} = {}) {
  const v10Enabled = env?.V105_SHADOW_V10_ENABLED !== 'false'
  const laneOptions = { forkImpl, workerPath, env, requestTimeoutMs, startupTimeoutMs, killGraceMs, killConfirmMs }
  const requiredLane = createScopedProcessLane({
    ...laneOptions,
    scope: 'required',
    runtimeKeys: REQUIRED_RUNTIME_KEYS,
  })
  const v10ProcessLane = createScopedProcessLane({
    ...laneOptions,
    scope: V10_RUNTIME_KEY,
    runtimeKeys: new Set([V10_RUNTIME_KEY]),
    enabled: v10Enabled,
  })
  let stopping = false
  let v10PreparePromise = null
  let v10PreparedGeneration = 0
  let v10Readiness = null
  const v10Queue = []
  let v10Active = null
  const v10LaneMetrics = {
    accepted: 0,
    completed: 0,
    coalesced: 0,
    rejected: 0,
    failed: 0,
    droppedOnStop: 0,
  }

  function prepareRequired(options = {}) {
    return requiredLane.prepare(options)
  }

  function prepareV10(options = {}) {
    if (!v10Enabled) return Promise.resolve(structuredClone(DISABLED_READINESS))
    const processStatus = v10ProcessLane.status()
    if (v10Readiness && processStatus.running === true && processStatus.generation === v10PreparedGeneration) {
      return Promise.resolve(structuredClone(v10Readiness))
    }
    if (v10PreparePromise) return v10PreparePromise
    v10PreparePromise = v10ProcessLane.prepare(options)
      .then((readiness) => {
        if (!isFullyPrepared(readiness)) throw new Error('V10 shadow process preparation is incomplete')
        v10PreparedGeneration = v10ProcessLane.status().generation
        v10Readiness = structuredClone(readiness)
        return readiness
      })
      .finally(() => {
        v10PreparePromise = null
      })
    return v10PreparePromise
  }

  function request(runtime, method, payload, options = {}) {
    if (!RUNTIME_KEYS.has(runtime)) return Promise.reject(new Error('unknown shadow runtime'))
    return (runtime === V10_RUNTIME_KEY ? v10ProcessLane : requiredLane).request(runtime, method, payload, options)
  }

  async function processCapture(payload, options = {}) {
    const requiredResult = await requiredLane.processCapture(payload, options)
    let bestEffort = { coalesced: 0, rejected: 0 }
    try {
      if (options.signal?.aborted) return requiredResult
      bestEffort = enqueueV10Capture(payload)
    } catch {
      v10LaneMetrics.failed += 1
    }
    const result = requiredResult && typeof requiredResult === 'object' && !Array.isArray(requiredResult)
      ? { ...requiredResult }
      : {}
    if (bestEffort.coalesced > 0) result.bestEffortCoalesced = bestEffort.coalesced
    if (bestEffort.rejected > 0) result.bestEffortRejected = bestEffort.rejected
    return result
  }

  function enqueueV10Capture(payload = {}) {
    const tables = Array.isArray(payload?.tables) ? payload.tables : []
    const rounds = Array.isArray(payload?.rounds) ? payload.rounds : []
    if (!v10Enabled || stopping || (tables.length === 0 && rounds.length === 0)) return { coalesced: 0, rejected: 0 }
    const coalesced = v10Queue.length >= V10_MAX_QUEUED_CAPTURES ? 1 : 0
    const job = coalesced === 1
      ? v10Queue[v10Queue.length - 1]
      : { payload: { ...structuredClone(payload), tables: [], rounds: [] } }
    const rejected = mergeV10Payload(job.payload, payload, currentV10IdentitySet())
    if (coalesced === 0 && (job.payload.tables.length > 0 || job.payload.rounds.length > 0)) v10Queue.push(job)
    v10LaneMetrics.accepted += 1
    v10LaneMetrics.coalesced += coalesced
    v10LaneMetrics.rejected += rejected
    pumpV10Queue()
    return { coalesced, rejected }
  }

  function currentV10IdentitySet() {
    const identities = new Set()
    const jobs = [v10Active, ...v10Queue].filter(Boolean)
    for (const job of jobs) {
      for (const table of job.payload.tables ?? []) identities.add(`table:${tableObservationIdentity(table)}`)
      for (const round of job.payload.rounds ?? []) identities.add(`settlement:${settlementIdentity(round)}`)
    }
    return identities
  }

  function pumpV10Queue() {
    if (stopping || v10Active || v10Queue.length === 0) return
    const job = v10Queue.shift()
    v10Active = job
    void prepareV10()
      .then(() => v10ProcessLane.processCapture(job.payload))
      .then(() => { v10LaneMetrics.completed += 1 })
      .catch(() => { v10LaneMetrics.failed += 1 })
      .finally(() => {
        if (v10Active === job) v10Active = null
        pumpV10Queue()
      })
  }

  function runtime(key, { enabled = true } = {}) {
    if (!RUNTIME_KEYS.has(key)) throw new Error('unknown shadow runtime')
    const lane = key === V10_RUNTIME_KEY ? v10ProcessLane : requiredLane
    const runtimeEnabled = enabled === true && (key !== V10_RUNTIME_KEY || v10Enabled)
    return {
      enabled: runtimeEnabled,
      observeTable(table, options = {}) {
        if (!runtimeEnabled) return Promise.resolve(null)
        return request(key, 'observeTable', table, options)
      },
      settleRound(round, options = {}) {
        if (!runtimeEnabled) return Promise.resolve(null)
        return request(key, 'settleRound', round, options)
      },
      snapshot() {
        return lane.snapshot(key) ?? { status: runtimeEnabled ? 'remote' : 'disabled', enabled: runtimeEnabled }
      },
    }
  }

  async function stopRequired() {
    return requiredLane.stop()
  }

  async function stopV10() {
    const queuedIdentities = v10Queue.reduce((sum, job) => sum + (job.payload.tables?.length ?? 0) + (job.payload.rounds?.length ?? 0), 0)
    v10LaneMetrics.droppedOnStop += queuedIdentities
    v10Queue.length = 0
    return v10ProcessLane.stop()
  }

  async function stop() {
    beginStop()
    const [requiredResult, v10Result] = await Promise.allSettled([stopRequired(), stopV10()])
    if (requiredResult.status === 'rejected') throw requiredResult.reason
    if (v10Result.status === 'rejected') throw v10Result.reason
  }

  function beginStop() {
    stopping = true
  }

  function status() {
    const required = requiredLane.status()
    const v105V10 = {
      ...v10ProcessLane.status(),
      lane: {
        active: v10Active ? 1 : 0,
        queued: v10Queue.length,
        identities: currentV10IdentitySet().size,
        ...structuredClone(v10LaneMetrics),
      },
    }
    return {
      ...required,
      anyRunning: required.running || v105V10.running,
      required,
      v105V10,
    }
  }

  return {
    request,
    prepare: prepareRequired,
    prepareRequired,
    prepareV10,
    processCapture,
    runtime,
    stop,
    beginStop,
    stopRequired,
    stopV10,
    status,
  }
}

function isFullyPrepared(readiness) {
  return readiness && typeof readiness === 'object' && !Array.isArray(readiness)
    && ['enabled', 'prepared', 'pending', 'queued', 'failed']
      .every((key) => Number.isSafeInteger(readiness[key]) && readiness[key] >= 0)
    && readiness.prepared === readiness.enabled
    && readiness.pending === 0
    && readiness.queued === 0
    && readiness.failed === 0
}

function mergeV10Payload(target, incoming, identities) {
  const targetTables = new Map((target.tables ?? []).map((item) => [tableObservationIdentity(item), structuredClone(item)]))
  const targetRounds = new Map((target.rounds ?? []).map((item) => [settlementIdentity(item), structuredClone(item)]))
  let rejected = 0

  for (const table of Array.isArray(incoming?.tables) ? incoming.tables : []) {
    const identity = tableObservationIdentity(table)
    const globalIdentity = `table:${identity}`
    if (!targetTables.has(identity) && !identities.has(globalIdentity) && identities.size >= V10_MAX_IDENTITIES) {
      rejected += 1
      continue
    }
    targetTables.set(identity, structuredClone(table))
    identities.add(globalIdentity)
  }
  for (const round of Array.isArray(incoming?.rounds) ? incoming.rounds : []) {
    const identity = settlementIdentity(round)
    const globalIdentity = `settlement:${identity}`
    if (!targetRounds.has(identity) && !identities.has(globalIdentity) && identities.size >= V10_MAX_IDENTITIES) {
      rejected += 1
      continue
    }
    targetRounds.set(identity, structuredClone(round))
    identities.add(globalIdentity)
  }

  target.tables = [...targetTables.values()]
  target.rounds = [...targetRounds.values()]
  return rejected
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

function createRemoteError(value) {
  const source = value && typeof value === 'object' ? value : { message: value }
  const error = new Error(safeErrorMessage(source.message))
  error.code = /^SHADOW_[A-Z0-9_]+$/.test(String(source.code ?? '')) ? String(source.code) : 'SHADOW_RUNTIME_FAILED'
  error.diagnostics = Array.isArray(source.diagnostics)
    ? source.diagnostics.slice(0, 8).map((item) => ({
        runtime: RUNTIME_KEYS.has(item?.runtime) ? item.runtime : 'unknown',
        stage: ['hydrate', 'observeTable', 'settleRound'].includes(item?.stage) ? item.stage : 'unknown',
        code: /^[a-z0-9_]+$/.test(String(item?.code ?? '')) ? String(item.code) : 'runtime_error',
      }))
    : []
  return error
}

function safeResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const allowed = {}
  for (const key of ['enabled', 'prepared', 'pending', 'queued', 'failed', 'disabled', 'observed', 'settled', 'noops', 'bestEffortCoalesced', 'bestEffortRejected']) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) allowed[key] = value[key]
  }
  return allowed
}
