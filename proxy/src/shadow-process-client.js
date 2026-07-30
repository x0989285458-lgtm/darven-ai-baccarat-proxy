import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const RUNTIME_KEYS = new Set(['v103', 'v104', 'v104-iteration', 'v105', 'v105-v7', 'v105-v8', 'v105-v9'])
const CHILD_ENV_ALLOWLIST = [
  'NODE_ENV', 'TZ',
  'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY', 'SUPABASE_DB_CONNECTION_STRING',
  'SUPABASE_REQUEST_TIMEOUT_MS', 'DURABLE_INGEST_REQUEST_TIMEOUT_MS',
  'V103_SHADOW_ENABLED', 'V104_SHADOW_ENABLED', 'V104_ITERATION_SHADOW_ENABLED',
  'V105_SHADOW_V6_ENABLED', 'V105_SHADOW_V7_ENABLED', 'V105_SHADOW_V8_ENABLED', 'V105_SHADOW_V9_ENABLED',
]

function buildChildEnv(source = {}) {
  const target = { SHADOW_PROCESS_CHILD: '1' }
  for (const key of CHILD_ENV_ALLOWLIST) {
    if (source[key] != null) target[key] = String(source[key])
  }
  return target
}

function safeErrorMessage(value) {
  const text = String(value ?? 'shadow process request failed')
  return text
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/(?:password|token|secret|api[_-]?key)\s*[:=]\s*\S+/gi, '[REDACTED]')
    .slice(0, 500)
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
    if (stopping) throw new Error('shadow process client is stopping')
    if (terminating) await terminating
    if (terminationFailure) throw terminationFailure
    if (child?.connected && child.exitCode == null && child.signalCode == null && child.__terminating !== true) return child
    const targetGeneration = ++generation
    const resolvedWorkerPath = workerPath ?? fileURLToPath(new URL('./shadow-process-worker.js', import.meta.url))
    const spawned = forkImpl(resolvedWorkerPath, [], {
      env: buildChildEnv(env),
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
        for (const [key, value] of Object.entries(message.snapshots)) snapshots.set(key, value)
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
    if (!RUNTIME_KEYS.has(runtime)) return Promise.reject(new Error('unknown shadow runtime'))
    if (!['observeTable', 'settleRound'].includes(method)) return Promise.reject(new Error('unknown shadow process method'))
    return sendRequest({ kind: 'runtime', runtime, method, payload }, options)
  }

  function processCapture(payload, options = {}) {
    return sendRequest({ kind: 'capture', payload }, options)
  }

  function prepare(options = {}) {
    return sendRequest({ kind: 'prepare' }, { timeoutMs: startupTimeoutMs, ...options })
  }

  function runtime(key, { enabled = true } = {}) {
    if (!RUNTIME_KEYS.has(key)) throw new Error('unknown shadow runtime')
    return {
      enabled: enabled === true,
      observeTable(table, options = {}) {
        if (enabled !== true) return Promise.resolve(null)
        return request(key, 'observeTable', table, options)
      },
      settleRound(round, options = {}) {
        if (enabled !== true) return Promise.resolve(null)
        return request(key, 'settleRound', round, options)
      },
      snapshot() {
        return structuredClone(snapshots.get(key) ?? { status: enabled === true ? 'remote' : 'disabled', enabled: enabled === true })
      },
    }
  }

  async function stop() {
    stopping = true
    if (terminating) await terminating
    if (child) await terminate(child, new Error('shadow process client stopped'))
    if (terminationFailure) throw terminationFailure
  }

  return {
    request,
    prepare,
    processCapture,
    runtime,
    stop,
    status: () => ({
      running: Boolean(child && (terminationFailure || child.connected)),
      generation,
      pending: pending.size,
      stopping,
      terminating: Boolean(terminating),
      terminationFailed: Boolean(terminationFailure),
      phase: terminationFailure ? 'fatal' : terminating ? 'terminating' : 'ready',
      code: terminationFailure ? 'SHADOW_PROCESS_TERMINATION_UNCONFIRMED' : null,
      lastFailure: structuredClone(lastFailure),
      lastSuccess: structuredClone(lastSuccess),
    }),
  }
}

function createRemoteError(value) {
  const source = value && typeof value === 'object' ? value : { message: value }
  const error = new Error(safeErrorMessage(source.message))
  error.code = /^SHADOW_[A-Z0-9_]+$/.test(String(source.code ?? '')) ? String(source.code) : 'SHADOW_RUNTIME_FAILED'
  error.diagnostics = Array.isArray(source.diagnostics)
    ? source.diagnostics.slice(0, 7).map((item) => ({
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
  for (const key of ['prepared', 'disabled', 'observed', 'settled', 'noops']) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) allowed[key] = value[key]
  }
  return allowed
}
