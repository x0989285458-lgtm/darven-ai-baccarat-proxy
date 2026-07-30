import { ALL_MT_EQUAL_STRATEGY_VERSION, createSupabaseIngestionClient } from './supabase-writer.js'
import { createV103ShadowRuntime, resolveV103ShadowEnabled } from './v103-shadow-runtime.js'
import { createV104ShadowRuntime, resolveV104ShadowEnabled } from './v104-shadow-runtime.js'
import { createV104IterationShadowRuntime, resolveV104IterationShadowEnabled } from './v104-iteration-shadow-runtime.js'
import { createV105ShadowRuntime, resolveV105ShadowEnabled } from './v105-shadow-runtime.js'
import { createV105ShadowV7Runtime, resolveV105ShadowV7Enabled } from './v105-shadow-v7-runtime.js'
import { createV105ShadowV8Runtime, resolveV105ShadowV8Enabled } from './v105-shadow-v8-runtime.js'
import { createV105ShadowV9Runtime, resolveV105ShadowV9Enabled } from './v105-shadow-v9-runtime.js'
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
  ['v105', createV105ShadowRuntime({
    enabled: resolveV105ShadowEnabled() && has('getV105ShadowHistory') && has('issueV105ShadowPrediction') && has('readV105ShadowIssuance') && has('settleV105ShadowPrediction'),
    writer,
  })],
  ['v105-v7', createV105ShadowV7Runtime({
    enabled: resolveV105ShadowV7Enabled() && has('getV105ShadowV7History') && has('issueV105ShadowV7Prediction') && has('readV105ShadowV7Issuance') && has('settleV105ShadowV7Prediction'),
    writer,
  })],
  ['v105-v8', createV105ShadowV8Runtime({
    enabled: resolveV105ShadowV8Enabled() && has('getV105ShadowV8History') && has('issueV105ShadowV8Prediction') && has('readV105ShadowV8Issuance') && has('settleV105ShadowV8Prediction'),
    writer,
  })],
  ['v105-v9', createV105ShadowV9Runtime({
    enabled: resolveV105ShadowV9Enabled() && has('getV105ShadowV9History') && has('issueV105ShadowV9Prediction') && has('readV105ShadowV9Issuance') && has('settleV105ShadowV9Prediction'),
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
