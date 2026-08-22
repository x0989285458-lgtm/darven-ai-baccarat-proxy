import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const DEFAULT_OUTBOX_PROCESS_STARTUP_TIMEOUT_MS = 300000

const CHILD_ENV_KEYS = [
  'NODE_ENV', 'TZ',
  'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY', 'SUPABASE_DB_CONNECTION_STRING',
  'SUPABASE_REQUEST_TIMEOUT_MS', 'DURABLE_INGEST_REQUEST_TIMEOUT_MS',
  'CAPTURE_OUTBOX_WORK_DEADLINE_MS', 'CAPTURE_OUTBOX_BACKOFF_MS',
  'SHADOW_SERVICE_WORK_TIMEOUT_MS', 'SHADOW_SHUTDOWN_DEADLINE_MS',
  'V103_SHADOW_ENABLED', 'V104_SHADOW_ENABLED', 'V104_ITERATION_SHADOW_ENABLED',
  'V105_SHADOW_V9_ENABLED', 'V105_SHADOW_V10_ENABLED', 'SHADOW_PROCESS_ENABLED',
]

function buildChildEnv(source = {}) {
  const env = { OUTBOX_PROCESS_CHILD: '1' }
  for (const key of CHILD_ENV_KEYS) {
    if (source[key] != null) env[key] = String(source[key])
  }
  return env
}

export function createOutboxProcessClient({
  forkImpl = fork,
  workerPath = fileURLToPath(new URL('./outbox-process-worker.js', import.meta.url)),
  env = process.env,
  startupTimeoutMs = Number(process.env.OUTBOX_PROCESS_STARTUP_TIMEOUT_MS ?? DEFAULT_OUTBOX_PROCESS_STARTUP_TIMEOUT_MS),
  stopTimeoutMs = 5000,
  stopKillConfirmMs = 1000,
  restartBaseDelayMs = 250,
  restartMaxDelayMs = 5000,
  restartStableMs = 30000,
} = {}) {
  let child = null
  let ready = false
  let starting = null
  let lastError = null
  let stopping = false
  let restartTimer = null
  let stabilityTimer = null
  let restartAttempts = 0

  function scheduleRestart() {
    if (stopping || restartTimer) return
    restartAttempts += 1
    const delayMs = Math.min(restartMaxDelayMs, restartBaseDelayMs * (2 ** Math.min(restartAttempts - 1, 5)))
    restartTimer = setTimeout(() => {
      restartTimer = null
      void start().then(() => wake()).catch(() => scheduleRestart())
    }, Math.max(1, delayMs))
    restartTimer.unref?.()
  }

  function status() {
    return {
      enabled: true,
      ready,
      running: Boolean(child?.connected && child.exitCode == null && child.signalCode == null),
      lastError,
    }
  }

  function start() {
    if (stopping) return Promise.reject(new Error('outbox process client is stopping'))
    if (ready && child?.connected) return Promise.resolve(status())
    if (starting) return starting
    starting = new Promise((resolve, reject) => {
      const spawned = forkImpl(workerPath, [], {
        env: buildChildEnv(env),
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        serialization: 'advanced',
      })
      child = spawned
      let settled = false
      const timer = setTimeout(() => finish(new Error('outbox process startup timed out')), startupTimeoutMs)
      timer.unref?.()
      const finish = (error = null) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        starting = null
        if (error) {
          lastError = error.message
          ready = false
          try { spawned.kill('SIGKILL') } catch {}
          reject(error)
        } else {
          ready = true
          lastError = null
          if (stabilityTimer) clearTimeout(stabilityTimer)
          stabilityTimer = setTimeout(() => {
            if (child === spawned && ready) restartAttempts = 0
          }, Math.max(1, restartStableMs))
          stabilityTimer.unref?.()
          resolve(status())
        }
      }
      spawned.on('message', (message) => {
        if (message?.type === 'ready') finish()
        if (message?.type === 'fatal') {
          lastError = String(message.error ?? 'outbox process failed')
          ready = false
          try { spawned.kill('SIGKILL') } catch {}
        }
      })
      spawned.once('error', finish)
      spawned.once('exit', (code, signal) => {
        if (stabilityTimer) {
          clearTimeout(stabilityTimer)
          stabilityTimer = null
        }
        ready = false
        if (child === spawned) child = null
        const error = new Error(`outbox process exited (${code ?? signal ?? 'unknown'})`)
        lastError = error.message
        if (!settled) finish(error)
        if (!stopping) scheduleRestart()
      })
    })
    return starting
  }

  function wake() {
    if (!ready || !child?.connected) {
      void start().then(() => wake()).catch((error) => { lastError = error?.message ?? String(error) })
      return true
    }
    try {
      child.send({ type: 'wake' })
      return true
    } catch (error) {
      lastError = error?.message ?? String(error)
      ready = false
      return false
    }
  }

  async function stop() {
    stopping = true
    if (restartTimer) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
    if (stabilityTimer) {
      clearTimeout(stabilityTimer)
      stabilityTimer = null
    }
    const target = child
    if (!target) return { stopped: true }
    ready = false
    await new Promise((resolve, reject) => {
      let settled = false
      let forceTimer = null
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (forceTimer) clearTimeout(forceTimer)
        resolve()
      }
      const forceAndVerify = () => {
        if (settled || forceTimer) return
        clearTimeout(timer)
        try { target.kill('SIGKILL') } catch {}
        forceTimer = setTimeout(() => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(new Error('outbox process stop could not confirm child exit'))
        }, Math.max(1, stopKillConfirmMs))
        forceTimer.unref?.()
      }
      const timer = setTimeout(forceAndVerify, stopTimeoutMs)
      timer.unref?.()
      target.once('exit', finish)
      try { target.send({ type: 'stop' }) } catch { forceAndVerify() }
    })
    if (child === target) child = null
    return { stopped: true }
  }

  return { start, wake, stop, status }
}
