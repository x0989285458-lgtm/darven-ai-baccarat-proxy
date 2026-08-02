import test from 'node:test'
import assert from 'node:assert/strict'
import { createSupabaseIngestionClient } from '../src/supabase-writer.js'
import { DIRECT_DATABASE_ENV_KEYS } from '../src/shadow-process-env.js'
import { createShadowProcessWriter } from '../src/shadow-process-writer.js'

const VERSION = 'v105-shadow-v10-uncommon-road-structure'
const candidate = {
  source: 'ofalive99', strategyVersion: VERSION, releaseCandidate: VERSION, formalStrategyVersion: 'v105',
  predictionTiming: 'pre_result_context', shadowOnly: true, activationEligible: false, memberVisible: false,
  writesSideActions: false, targetTableId: 'BAG01', targetShoe: '105', targetRound: 21,
  predictedResult: 'banker', confidence: 50, sameSideStreak: 1,
}
const response = (payload) => ({ ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload })

test('createSupabaseIngestionClient eagerly constructs its Direct DB pool when configured', () => {
  let poolConstructions = 0
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co',
    serviceKey: 'test-only',
    requireVerifiedStrategy: false,
    dbConnectionString: 'postgresql://direct.invalid/db',
    strategyPoolFactory(config) {
      poolConstructions += 1
      return { config, async query() { return { rows: [] } } }
    },
  })

  assert.equal(poolConstructions, 1)
  assert.equal(client.configured, true)
})

test('required worker retains Direct DB pool while V10 scrubs every Direct DB env before writer construction', () => {
  const poolConfigs = []
  class PgPoolConstructorTrap {
    constructor(config) {
      poolConfigs.push(structuredClone(config))
    }
    async query() { return { rows: [] } }
  }
  const strategyPoolFactory = (config) => new PgPoolConstructorTrap(config)
  const baseEnv = {
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-only',
    SUPABASE_DB_CONNECTION_STRING: 'postgresql://supabase-direct.invalid/db',
    DATABASE_URL: 'postgresql://database.invalid/db',
    POSTGRES_URL: 'postgresql://postgres.invalid/db',
    POSTGRES_PRISMA_URL: 'postgresql://prisma.invalid/db',
    POSTGRES_URL_NON_POOLING: 'postgresql://non-pooling.invalid/db',
    PGHOST: 'pg.invalid', PGPORT: '5432', PGDATABASE: 'postgres',
    PGUSER: 'postgres', PGPASSWORD: 'test-only', PGSERVICE: 'direct', PGSERVICEFILE: 'test-only',
  }
  const requiredEnv = { ...baseEnv }
  createShadowProcessWriter({
    scope: 'required', env: requiredEnv, strategyPoolFactory,
    fetchImpl: async () => response([]), requireVerifiedStrategy: false,
  })
  assert.equal(poolConfigs.length, 1)
  assert.equal(requiredEnv.SUPABASE_DB_CONNECTION_STRING, baseEnv.SUPABASE_DB_CONNECTION_STRING)

  const v10Env = { ...baseEnv }
  const writer = createShadowProcessWriter({
    scope: 'v105-v10', env: v10Env, strategyPoolFactory,
    fetchImpl: async () => response([]), requireVerifiedStrategy: false,
  })
  assert.equal(poolConfigs.length, 1, 'V10 constructed a pg.Pool')
  assert.equal(writer.configured, true)
  for (const key of DIRECT_DATABASE_ENV_KEYS) assert.equal(key in v10Env, false, `V10 retained ${key}`)
  assert.equal(v10Env.SUPABASE_URL, baseEnv.SUPABASE_URL)
  assert.equal(v10Env.SUPABASE_SERVICE_ROLE_KEY, baseEnv.SUPABASE_SERVICE_ROLE_KEY)
})

test('V10 scoped worker uses only PostgREST and RPC for issuance, read, Final, counter, and history', async () => {
  const requests = []
  const env = {
    SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-only',
    SUPABASE_DB_CONNECTION_STRING: 'postgresql://must-not-construct.invalid/db',
    DATABASE_URL: 'postgresql://must-not-construct.invalid/database',
  }
  const writer = createShadowProcessWriter({
    scope: 'v105-v10', env, requireVerifiedStrategy: false,
    strategyPoolFactory() { assert.fail('V10 must not construct pg.Pool') },
    fetchImpl: async (url) => {
      const path = new URL(url).pathname
      requests.push(path)
      if (path.endsWith('/rpc/issue_v105_shadow_v10_prediction')) {
        return response({ prediction_id: 'v10-id', prediction_issued_at: '2026-08-02T01:00:00.000Z', prediction: candidate })
      }
      if (path.endsWith('/v105_shadow_v10_issuances')) {
        return response([{ id: 'v10-id', source: 'ofalive99', table_id: 'BAG01', shoe_no: '105', round_no: 21, strategy_version: VERSION, prediction_timing: 'pre_result_context', prediction_issued_at: '2026-08-02T01:00:00.000Z', prediction_payload: candidate }])
      }
      if (path.endsWith('/rpc/settle_v105_shadow_v10_prediction')) return response({ prediction_id: 'v10-id', settlement_sequence: 1 })
      if (path.endsWith('/v105_shadow_v10_sequence_counters')) return response([{ settlement_count: 1 }])
      return response([])
    },
  })

  assert.equal((await writer.issueV105ShadowV10Prediction(candidate)).predictionId, 'v10-id')
  assert.equal((await writer.readV105ShadowV10Issuance({ tableId: 'BAG01', shoe: '105', round: 21 })).predictionId, 'v10-id')
  assert.equal((await writer.settleV105ShadowV10Prediction({ ...candidate, predictionId: 'v10-id' })).predictionId, 'v10-id')
  assert.equal((await writer.getV105ShadowV10Counters()).settlement_count, 1)
  assert.deepEqual(await writer.getV105ShadowV10History(), [])
  assert.deepEqual(requests, [
    '/rest/v1/rpc/issue_v105_shadow_v10_prediction',
    '/rest/v1/v105_shadow_v10_issuances',
    '/rest/v1/rpc/settle_v105_shadow_v10_prediction',
    '/rest/v1/v105_shadow_v10_sequence_counters',
    '/rest/v1/rpc/get_v105_shadow_v10_compact_history',
  ])
})
