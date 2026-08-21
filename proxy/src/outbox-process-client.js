import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'

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
  startupTimeoutMs = 10000,
  stopTimeoutMs = 5000,
} = {}) {
  let child = null
  let ready = false
  let starting = null
  let lastError = null

  function status() {
    return {
      enabled: true,
      ready,
      running: Boolean(child?.connected && child.exitCode == null && child.signalCode == null),
      lastError,
    }
  }

  function start() {
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
          resolve(status())
        }
      }
      spawned.on('message', (message) => {
        if (message?.type === 'ready') finish()
        if (message?.type === 'fatal') {
          lastError = String(message.error ?? 'outbox process failed')
          ready = false
        }
      })
      spawned.once('error', finish)
      spawned.once('exit', (code, signal) => {
        ready = false
        if (child === spawned) child = null
        const error = new Error(`outbox process exited (${code ?? signal ?? 'unknown'})`)
        lastError = error.message
        if (!settled) finish(error)
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
    const target = child
    if (!target) return { stopped: true }
    ready = false
    await new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        try { target.kill('SIGKILL') } catch {}
        finish()
      }, stopTimeoutMs)
      timer.unref?.()
      target.once('exit', finish)
      try { target.send({ type: 'stop' }) } catch { finish() }
    })
    if (child === target) child = null
    return { stopped: true }
  }

  return { start, wake, stop, status }
}
