import { createSupabaseIngestionClient } from './supabase-writer.js'
import { scrubDirectDatabaseEnv } from './shadow-process-env.js'

const RUNTIME_SCOPES = new Set(['required', 'v105-v10'])

export function createShadowProcessWriter({
  scope,
  env = process.env,
  fetchImpl = globalThis.fetch,
  requireVerifiedStrategy = env.NODE_ENV === 'production',
  strategyPoolFactory,
  createClient = createSupabaseIngestionClient,
} = {}) {
  if (!RUNTIME_SCOPES.has(scope)) throw new Error('shadow process runtime scope is missing or invalid')
  if (scope === 'v105-v10') scrubDirectDatabaseEnv(env)
  const options = {
    url: env.SUPABASE_URL,
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SECRET_KEY,
    fetchImpl,
    requireVerifiedStrategy,
    dbConnectionString: env.SUPABASE_DB_CONNECTION_STRING,
    strategyPoolMax: scope === 'required' ? 1 : 10,
    requestTimeoutMs: Number(env.SUPABASE_REQUEST_TIMEOUT_MS ?? 30000),
    durableWriteRequestTimeoutMs: Number(env.DURABLE_INGEST_REQUEST_TIMEOUT_MS ?? 30000),
  }
  if (strategyPoolFactory) options.strategyPoolFactory = strategyPoolFactory
  return createClient(options)
}
