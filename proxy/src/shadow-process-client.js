import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { scrubDirectDatabaseEnv } from './shadow-process-env.js'
import { V9_WRITER_METHODS } from './shadow-process-ipc-writer.js'
import { V105_SHADOW_V9_TABLE_IDS, V105_SHADOW_V9_VERSION } from './v105-shadow-v9-contract.js'
import { redactShadowErrorMessage as safeErrorMessage } from './shadow-process-error-redaction.js'

const REQUIRED_RUNTIME_KEYS = new Set(['v103', 'v104', 'v104-iteration'])
const V9_RUNTIME_KEY = 'v105-v9'
const V10_RUNTIME_KEY = 'v105-v10'
const RUNTIME_KEYS = new Set([...REQUIRED_RUNTIME_KEYS, V9_RUNTIME_KEY, V10_RUNTIME_KEY])
const RUNTIME_SCOPES = new Set(['required', V9_RUNTIME_KEY, V10_RUNTIME_KEY])
const CHILD_ENV_ALLOWLIST = [
  'NODE_ENV', 'TZ',
  'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY', 'SUPABASE_DB_CONNECTION_STRING',
  'SUPABASE_REQUEST_TIMEOUT_MS', 'DURABLE_INGEST_REQUEST_TIMEOUT_MS',
  'V103_SHADOW_ENABLED', 'V104_SHADOW_ENABLED', 'V104_ITERATION_SHADOW_ENABLED',
  'V105_SHADOW_V9_ENABLED', 'V105_SHADOW_V10_ENABLED',
]
const BEST_EFFORT_MAX_QUEUED_CAPTURES = 2
const BEST_EFFORT_MAX_IDENTITIES = 2000
const V9_PARENT_WRITER_MAX_CONCURRENCY = 4
const V9_PARENT_WRITER_MAX_PAYLOAD_BYTES = 262144
const V9_PARENT_WRITER_MAX_RESULT_BYTES = 2097152
const V9_TABLE_IDS = new Set(V105_SHADOW_V9_TABLE_IDS)
const DISABLED_READINESS = Object.freeze({ enabled: 0, prepared: 0, pending: 0, queued: 0, failed: 0, disabled: 1 })

function buildChildEnv(source = {}, scope) {
  if (!RUNTIME_SCOPES.has(scope)) throw new Error('unknown shadow process runtime scope')
  const target = { SHADOW_PROCESS_CHILD: '1', SHADOW_PROCESS_RUNTIME_SCOPE: scope }
  for (const key of CHILD_ENV_ALLOWLIST) {
    if (source[key] != null) target[key] = String(source[key])
  }
  if (scope === V10_RUNTIME_KEY) scrubDirectDatabaseEnv(target)
  if (scope === V9_RUNTIME_KEY) {
    scrubDirectDatabaseEnv(target)
    delete target.SUPABASE_URL
    delete target.SUPABASE_SERVICE_ROLE_KEY
    delete target.SUPABASE_SECRET_KEY
  }
  return target
}


function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isBoundedIdentity(value, max = 128) {
  const text = String(value ?? '')
  return text.length > 0 && text.length <= max && !/[\u0000-\u001f]/.test(text)
}

function isPositiveRound(value) {
  return Number.isSafeInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 1000
}

function assertV9WriterArgs(method, rawArgs) {
  const args = structuredClone(Array.isArray(rawArgs) ? rawArgs : [])
  const encoded = JSON.stringify(args)
  if (Buffer.byteLength(encoded ?? '', 'utf8') > V9_PARENT_WRITER_MAX_PAYLOAD_BYTES) throw Object.assign(new Error('V9 writer payload is too large'), { code: 'V9_WRITER_PAYLOAD_TOO_LARGE' })
  if (method === 'getV105ShadowV9Counters') {
    if (args.length !== 0) throw Object.assign(new Error('V9 counters arguments are invalid'), { code: 'V9_WRITER_ARGUMENT_INVALID' })
    return args
  }
  if (args.length !== 1 || !isRecord(args[0])) throw Object.assign(new Error('V9 writer arguments are invalid'), { code: 'V9_WRITER_ARGUMENT_INVALID' })
  const value = args[0]
  const tableId = value.targetTableId ?? value.tableId
  const shoe = value.targetShoe ?? value.shoe
  const round = value.targetRound ?? value.round
  if (method === 'getV105ShadowV9History') {
    if (!Number.isInteger(value.perTableLimit) || value.perTableLimit < 1 || value.perTableLimit > 60) throw Object.assign(new Error('V9 history arguments are invalid'), { code: 'V9_WRITER_ARGUMENT_INVALID' })
    if (value.requestTimeoutMs != null && (!Number.isFinite(Number(value.requestTimeoutMs)) || Number(value.requestTimeoutMs) < 1 || Number(value.requestTimeoutMs) > 60000)) throw Object.assign(new Error('V9 history timeout is invalid'), { code: 'V9_WRITER_ARGUMENT_INVALID' })
    return args
  }
  if (!V9_TABLE_IDS.has(String(tableId ?? '')) || !isBoundedIdentity(shoe, 64) || !isPositiveRound(round)) throw Object.assign(new Error('V9 writer identity is invalid'), { code: 'V9_WRITER_IDENTITY_INVALID' })
  if (value.source != null && !isBoundedIdentity(value.source, 64)) throw Object.assign(new Error('V9 writer source is invalid'), { code: 'V9_WRITER_IDENTITY_INVALID' })
  if (method === 'issueV105ShadowV9Prediction') {
    if (value.strategyVersion !== V105_SHADOW_V9_VERSION || value.predictionTiming !== 'pre_result_context' || !['banker', 'player'].includes(String(value.predictedResult ?? '').toLowerCase())) throw Object.assign(new Error('V9 issuance contract is invalid'), { code: 'V9_WRITER_CONTRACT_INVALID' })
  } else if (method === 'settleV105ShadowV9Prediction') {
    if (!isBoundedIdentity(value.predictionId, 128) || value.strategyVersion !== V105_SHADOW_V9_VERSION || value.settlementFinal !== true || !['banker', 'player', 'tie'].includes(String(value.actualResult ?? '').toLowerCase())) throw Object.assign(new Error('V9 settlement contract is invalid'), { code: 'V9_WRITER_CONTRACT_INVALID' })
  } else if (method !== 'readV105ShadowV9Issuance') {
    throw Object.assign(new Error('V9 writer method is unavailable'), { code: 'V9_WRITER_METHOD_UNAVAILABLE' })
  }
  return args
}

function boundedV9WriterResult(value) {
  const result = structuredClone(value ?? null)
  const encoded = JSON.stringify(result)
  if (Buffer.byteLength(encoded ?? '', 'utf8') > V9_PARENT_WRITER_MAX_RESULT_BYTES) throw Object.assign(new Error('V9 writer result is too large'), { code: 'V9_WRITER_RESULT_TOO_LARGE' })
  return result
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
  writer = null,
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
  const writerPending = new Set()
  let highestWriterRequestId = 0

  function rejectGeneration(targetGeneration, reason) {
    for (const [id, request] of pending) {
      if (request.generation !== targetGeneration) continue
      pending.delete(id)
      clearTimeout(request.timer)
      request.signal?.removeEventListener?.('abort', request.onAbort)
      request.reject(reason)
    }
  }

  function sendWriterResponse(target, payload) {
    if (!target.connected || target.__terminating === true) {
      lastFailure = { at: new Date().toISOString(), kind: 'writer_response', code: 'V9_WRITER_RESPONSE_DROPPED', diagnostics: [] }
      return
    }
    try {
      target.send(payload, (error) => {
        if (!error) return
        lastFailure = { at: new Date().toISOString(), kind: 'writer_response', code: 'V9_WRITER_RESPONSE_SEND_FAILED', diagnostics: [] }
      })
    } catch {
      lastFailure = { at: new Date().toISOString(), kind: 'writer_response', code: 'V9_WRITER_RESPONSE_SEND_FAILED', diagnostics: [] }
    }
  }

  function handleWriterRequest(target, message) {
    const method = String(message?.method ?? '')
    const id = message?.id
    const operation = (async () => {
      try {
        if (!Number.isSafeInteger(id) || id <= highestWriterRequestId) throw Object.assign(new Error('V9 writer request identity is invalid'), { code: 'V9_WRITER_REQUEST_ID_INVALID' })
        highestWriterRequestId = id
        if (scope !== V9_RUNTIME_KEY || !V9_WRITER_METHODS.includes(method) || !writer || typeof writer[method] !== 'function') throw Object.assign(new Error('V9 parent writer method is unavailable'), { code: 'V9_WRITER_METHOD_UNAVAILABLE' })
        if (stopping || writerPending.size >= V9_PARENT_WRITER_MAX_CONCURRENCY) throw Object.assign(new Error('V9 parent writer is busy'), { code: 'V9_WRITER_BUSY' })
        const args = assertV9WriterArgs(method, message.args)
        const result = boundedV9WriterResult(await writer[method](...args))
        sendWriterResponse(target, { type: 'writer_response', id, ok: true, result })
      } catch (error) {
        sendWriterResponse(target, {
          type: 'writer_response', id: message?.id, ok: false,
          error: { message: safeErrorMessage(error?.message), code: String(error?.code ?? 'V9_WRITER_REQUEST_FAILED') },
        })
      }
    })()
    writerPending.add(operation)
    void operation.finally(() => writerPending.delete(operation))
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
    highestWriterRequestId = 0
    const resolvedWorkerPath = workerPath ?? fileURLToPath(new URL('./shadow-process-worker.js', import.meta.url))
    const spawned = forkImpl(resolvedWorkerPath, [], {
      env: buildChildEnv(env, scope),
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      serialization: 'advanced',
    })
    spawned.__shadowGeneration = targetGeneration
    spawned.on('message', (message) => {
      if (spawned.__terminating === true || !message) return
      if (message.type === 'writer_request') {
        void handleWriterRequest(spawned, message)
        return
      }
      if (message.type !== 'response') return
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
    if (writerPending.size > 0) await Promise.allSettled([...writerPending])
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
      writerPending: writerPending.size,
      stopping,
      terminating: Boolean(terminating),
      terminationFailed: Boolean(terminationFailure),
      phase: terminationFailure ? 'fatal' : terminating ? 'terminating' : stopping && writerPending.size > 0 ? 'draining_writer' : stopping ? 'stopped' : 'ready',
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
  v9Writer = null,
} = {}) {
  const v9Enabled = env?.V105_SHADOW_V9_ENABLED !== 'false'
  const v10Enabled = env?.V105_SHADOW_V10_ENABLED !== 'false'
  const laneOptions = { forkImpl, workerPath, env, requestTimeoutMs, startupTimeoutMs, killGraceMs, killConfirmMs }
  const requiredLane = createScopedProcessLane({
    ...laneOptions,
    scope: 'required',
    runtimeKeys: REQUIRED_RUNTIME_KEYS,
  })
  const v9ProcessLane = createScopedProcessLane({
    ...laneOptions,
    scope: V9_RUNTIME_KEY,
    runtimeKeys: new Set([V9_RUNTIME_KEY]),
    enabled: v9Enabled,
    writer: v9Writer,
  })
  const v10ProcessLane = createScopedProcessLane({
    ...laneOptions,
    scope: V10_RUNTIME_KEY,
    runtimeKeys: new Set([V10_RUNTIME_KEY]),
    enabled: v10Enabled,
  })
  let stopping = false

  function createBestEffortCaptureLane({ runtimeKey, processLane, enabled }) {
    let preparePromise = null
    let preparedGeneration = 0
    let readiness = null
    const queue = []
    let active = null
    const metrics = {
      accepted: 0,
      completed: 0,
      coalesced: 0,
      rejected: 0,
      failed: 0,
      interruptedIdentities: 0,
      droppedOnStop: 0,
    }

    function prepare(options = {}) {
      if (!enabled) return Promise.resolve(structuredClone(DISABLED_READINESS))
      const processStatus = processLane.status()
      if (readiness && processStatus.running === true && processStatus.generation === preparedGeneration) {
        return Promise.resolve(structuredClone(readiness))
      }
      if (preparePromise) return preparePromise
      preparePromise = processLane.prepare(options)
        .then((result) => {
          if (!isFullyPrepared(result)) throw new Error(`${runtimeKey} shadow process preparation is incomplete`)
          preparedGeneration = processLane.status().generation
          readiness = structuredClone(result)
          return result
        })
        .finally(() => { preparePromise = null })
      return preparePromise
    }

    function currentIdentitySet() {
      const identities = new Set()
      for (const job of [active, ...queue].filter(Boolean)) {
        for (const table of job.payload.tables ?? []) identities.add(`table:${tableObservationIdentity(table)}`)
        for (const round of job.payload.rounds ?? []) identities.add(`settlement:${settlementIdentity(round)}`)
      }
      return identities
    }

    function enqueueCapture(payload = {}) {
      const tables = Array.isArray(payload?.tables) ? payload.tables : []
      const rounds = Array.isArray(payload?.rounds) ? payload.rounds : []
      if (!enabled || stopping || (tables.length === 0 && rounds.length === 0)) return { coalesced: 0, rejected: 0 }
      const coalesced = queue.length >= BEST_EFFORT_MAX_QUEUED_CAPTURES ? 1 : 0
      const job = coalesced === 1
        ? queue[queue.length - 1]
        : { payload: { ...structuredClone(payload), tables: [], rounds: [] } }
      const rejected = mergeBestEffortPayload(job.payload, payload, currentIdentitySet())
      if (coalesced === 0 && (job.payload.tables.length > 0 || job.payload.rounds.length > 0)) queue.push(job)
      metrics.accepted += 1
      metrics.coalesced += coalesced
      metrics.rejected += rejected
      pump()
      return { coalesced, rejected }
    }

    function pump() {
      if (stopping || active || queue.length === 0) return
      const job = queue.shift()
      active = job
      void prepare()
        .then(() => processLane.processCapture(job.payload))
        .then(() => { metrics.completed += 1 })
        .catch(() => {
          metrics.failed += 1
          metrics.interruptedIdentities += (job.payload.tables?.length ?? 0) + (job.payload.rounds?.length ?? 0)
        })
        .finally(() => {
          if (active === job) active = null
          pump()
        })
    }

    function runtime({ enabled: requestedEnabled = true } = {}) {
      const runtimeEnabled = requestedEnabled === true && enabled
      return {
        enabled: runtimeEnabled,
        observeTable(table, options = {}) {
          if (!runtimeEnabled) return Promise.resolve(null)
          return processLane.request(runtimeKey, 'observeTable', table, options)
        },
        settleRound(round, options = {}) {
          if (!runtimeEnabled) return Promise.resolve(null)
          return processLane.request(runtimeKey, 'settleRound', round, options)
        },
        snapshot() {
          return processLane.snapshot(runtimeKey) ?? { status: runtimeEnabled ? 'remote' : 'disabled', enabled: runtimeEnabled }
        },
      }
    }

    async function stop() {
      const droppedIdentities = queue
        .reduce((sum, job) => sum + (job.payload.tables?.length ?? 0) + (job.payload.rounds?.length ?? 0), 0)
      metrics.droppedOnStop += droppedIdentities
      queue.length = 0
      return processLane.stop()
    }

    function recordEnqueueFailure(payload) {
      metrics.failed += 1
      metrics.interruptedIdentities += (payload?.tables?.length ?? 0) + (payload?.rounds?.length ?? 0)
    }

    function status() {
      return {
        ...processLane.status(),
        lane: {
          active: active ? 1 : 0,
          queued: queue.length,
          identities: currentIdentitySet().size,
          ...structuredClone(metrics),
        },
      }
    }

    return { prepare, enqueueCapture, recordEnqueueFailure, runtime, stop, status }
  }

  const v9BestEffort = createBestEffortCaptureLane({ runtimeKey: V9_RUNTIME_KEY, processLane: v9ProcessLane, enabled: v9Enabled })
  const v10BestEffort = createBestEffortCaptureLane({ runtimeKey: V10_RUNTIME_KEY, processLane: v10ProcessLane, enabled: v10Enabled })

  function prepareRequired(options = {}) {
    return requiredLane.prepare(options)
  }

  function prepareV9(options = {}) {
    return v9BestEffort.prepare(options)
  }

  function prepareV10(options = {}) {
    return v10BestEffort.prepare(options)
  }

  function request(runtime, method, payload, options = {}) {
    if (!RUNTIME_KEYS.has(runtime)) return Promise.reject(new Error('unknown shadow runtime'))
    if (runtime === V9_RUNTIME_KEY) return v9ProcessLane.request(runtime, method, payload, options)
    if (runtime === V10_RUNTIME_KEY) return v10ProcessLane.request(runtime, method, payload, options)
    return requiredLane.request(runtime, method, payload, options)
  }

  async function processCapture(payload, options = {}) {
    const requiredResult = await requiredLane.processCapture(payload, options)
    if (options.signal?.aborted) return requiredResult
    let v9Result = { coalesced: 0, rejected: 0 }
    let v10Result = { coalesced: 0, rejected: 0 }
    try { v9Result = v9BestEffort.enqueueCapture(payload) } catch { v9BestEffort.recordEnqueueFailure(payload) }
    try { v10Result = v10BestEffort.enqueueCapture(payload) } catch { v10BestEffort.recordEnqueueFailure(payload) }
    const result = requiredResult && typeof requiredResult === 'object' && !Array.isArray(requiredResult)
      ? { ...requiredResult }
      : {}
    if (v9Result.coalesced > 0) result.bestEffortV9Coalesced = v9Result.coalesced
    if (v9Result.rejected > 0) result.bestEffortV9Rejected = v9Result.rejected
    if (v10Result.coalesced > 0) result.bestEffortCoalesced = v10Result.coalesced
    if (v10Result.rejected > 0) result.bestEffortRejected = v10Result.rejected
    return result
  }

  function runtime(key, options = {}) {
    if (!RUNTIME_KEYS.has(key)) throw new Error('unknown shadow runtime')
    if (key === V9_RUNTIME_KEY) return v9BestEffort.runtime(options)
    if (key === V10_RUNTIME_KEY) return v10BestEffort.runtime(options)
    const runtimeEnabled = options.enabled !== false
    return {
      enabled: runtimeEnabled,
      observeTable(table, requestOptions = {}) {
        if (!runtimeEnabled) return Promise.resolve(null)
        return requiredLane.request(key, 'observeTable', table, requestOptions)
      },
      settleRound(round, requestOptions = {}) {
        if (!runtimeEnabled) return Promise.resolve(null)
        return requiredLane.request(key, 'settleRound', round, requestOptions)
      },
      snapshot() {
        return requiredLane.snapshot(key) ?? { status: runtimeEnabled ? 'remote' : 'disabled', enabled: runtimeEnabled }
      },
    }
  }

  async function stopRequired() {
    return requiredLane.stop()
  }

  async function stopV9() {
    return v9BestEffort.stop()
  }

  async function stopV10() {
    return v10BestEffort.stop()
  }

  async function stop() {
    beginStop()
    const results = await Promise.allSettled([stopRequired(), stopV9(), stopV10()])
    const failure = results.find((result) => result.status === 'rejected')
    if (failure) throw failure.reason
  }

  function beginStop() {
    stopping = true
  }

  function status() {
    const required = requiredLane.status()
    const v105V9 = v9BestEffort.status()
    const v105V10 = v10BestEffort.status()
    return {
      ...required,
      anyRunning: required.running || v105V9.running || v105V10.running,
      required,
      v105V9,
      v105V10,
    }
  }

  return {
    request,
    prepare: prepareRequired,
    prepareRequired,
    prepareV9,
    prepareV10,
    processCapture,
    runtime,
    stop,
    beginStop,
    stopRequired,
    stopV9,
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

function mergeBestEffortPayload(target, incoming, identities) {
  const targetTables = new Map((target.tables ?? []).map((item) => [tableObservationIdentity(item), structuredClone(item)]))
  const targetRounds = new Map((target.rounds ?? []).map((item) => [settlementIdentity(item), structuredClone(item)]))
  let rejected = 0

  for (const table of Array.isArray(incoming?.tables) ? incoming.tables : []) {
    const identity = tableObservationIdentity(table)
    const globalIdentity = `table:${identity}`
    if (!targetTables.has(identity) && !identities.has(globalIdentity) && identities.size >= BEST_EFFORT_MAX_IDENTITIES) {
      rejected += 1
      continue
    }
    targetTables.set(identity, structuredClone(table))
    identities.add(globalIdentity)
  }
  for (const round of Array.isArray(incoming?.rounds) ? incoming.rounds : []) {
    const identity = settlementIdentity(round)
    const globalIdentity = `settlement:${identity}`
    if (!targetRounds.has(identity) && !identities.has(globalIdentity) && identities.size >= BEST_EFFORT_MAX_IDENTITIES) {
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
  for (const key of [
    'enabled', 'prepared', 'pending', 'queued', 'failed', 'disabled', 'observed', 'settled', 'noops',
    'bestEffortCoalesced', 'bestEffortRejected', 'bestEffortV9Coalesced', 'bestEffortV9Rejected',
  ]) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) allowed[key] = value[key]
  }
  return allowed
}
