import { ALL_MT_EQUAL_STRATEGY_VERSION, createSupabaseIngestionClient } from './supabase-writer.js'
import { createV103ShadowRuntime, resolveV103ShadowEnabled } from './v103-shadow-runtime.js'
import { createV104ShadowRuntime, resolveV104ShadowEnabled } from './v104-shadow-runtime.js'
import { createV104IterationShadowRuntime, resolveV104IterationShadowEnabled } from './v104-iteration-shadow-runtime.js'
import { createV105ShadowV9Runtime, resolveV105ShadowV9Enabled } from './v105-shadow-v9-runtime.js'
import { createV105ShadowV10Runtime, resolveV105ShadowV10Enabled } from './v105-shadow-v10-runtime.js'
import { prepareShadowRuntimes, processShadowCapture } from './shadow-process-work.js'

const writer = createSupabaseIngestionClient({
  dbConnectionString: process.env.SUPABASE_DB_CONNECTION_STRING,
  requestTimeoutMs: Number(process.env.SUPABASE_REQUEST_TIMEOUT_MS ?? 30000),
  durableWriteRequestTimeoutMs: Number(process.env.DURABLE_INGEST_REQUEST_TIMEOUT_MS ?? 30000),
})

const has = (name) => typeof writer?.[name] === 'function'
const runtimes = new Map([
  ['v103', createV103ShadowRuntime({ enabled: resolveV103ShadowEnabled(), writer })],
  ['v104', createV104ShadowRuntime({ enabled: ALL_MT_EQUAL_STRATEGY_VERSION !== 'v104' && resolveV104ShadowEnabled(), writer })],
  ['v104-iteration', createV104IterationShadowRuntime({ enabled: resolveV104IterationShadowEnabled(), writer })],
  ['v105-v9', createV105ShadowV9Runtime({
    enabled: resolveV105ShadowV9Enabled() && has('getV105ShadowV9History') && has('issueV105ShadowV9Prediction') && has('readV105ShadowV9Issuance') && has('settleV105ShadowV9Prediction'),
    writer,
  })],
  ['v105-v10', createV105ShadowV10Runtime({
    enabled: resolveV105ShadowV10Enabled() && has('getV105ShadowV10History') && has('issueV105ShadowV10Prediction') && has('readV105ShadowV10Issuance') && has('settleV105ShadowV10Prediction'),
    writer,
  })],
])

function safeError(error) {
  return String(error?.message ?? error ?? 'shadow process work failed')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/(?:password|token|secret|api[_-]?key)\s*[:=]\s*\S+/gi, '[REDACTED]')
    .slice(0, 500)
}

function snapshots() {
  return Object.fromEntries([...runtimes.entries()].map(([key, runtime]) => {
    try { return [key, runtime?.snapshot?.() ?? { status: runtime?.enabled === true ? 'ready' : 'disabled' }] }
    catch { return [key, { status: 'error' }] }
  }))
}

process.on('message', async (message) => {
  if (!message || message.type !== 'request') return
  const id = message.id
  try {
    let result = null
    if (message.kind === 'prepare') {
      result = await prepareShadowRuntimes(runtimes)
    } else if (message.kind === 'capture') {
      result = await processShadowCapture(runtimes, structuredClone(message.payload))
    } else {
      const runtime = runtimes.get(message.runtime)
      if (!runtime || runtime.enabled !== true) throw new Error('shadow runtime is disabled')
      if (!['observeTable', 'settleRound'].includes(message.method) || typeof runtime[message.method] !== 'function') {
        throw new Error('shadow runtime method is unavailable')
      }
      await runtime[message.method](structuredClone(message.payload))
    }
    process.send?.({ type: 'response', id, ok: true, result, snapshots: snapshots() })
  } catch (error) {
    process.send?.({
      type: 'response', id, ok: false,
      error: { message: safeError(error), code: String(error?.code ?? 'SHADOW_RUNTIME_FAILED'), diagnostics: error?.diagnostics ?? [] },
      snapshots: snapshots(),
    })
  }
})

process.on('disconnect', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
