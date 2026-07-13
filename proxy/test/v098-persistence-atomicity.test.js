import test from 'node:test'
import assert from 'node:assert/strict'
import { buildLivePrediction, createSupabaseIngestionClient } from '../src/supabase-writer.js'
import { createApp } from '../src/server.js'

const table = { tableId: 'BAG01', shoe: 88, round: 20, bankerCount: 10, playerCount: 9 }
const completed = { tableId: 'BAG01', shoe: 88, round: 21, winner: 'banker', rawResult: [1, 9, 2, 10, -1, -1, -1, -1, 1, 9] }

test('v098 persistence failure retries the identical pending snapshot without recomputing it', async () => {
  const attempts = []
  let call = 0
  const app = createApp({
    autoConnect: false,
    supabaseClient: {
      configured: true,
      ensureInitialStrategy: async () => {},
      persistRound: async (_round, _table, pending) => {
        attempts.push(structuredClone(pending))
        call += 1
        if (call === 1) throw new Error('temporary persistence failure')
      },
    },
  })
  app.state.setTables([table])
  app.state.upsertRoundEvent(completed)
  await new Promise((resolve) => setImmediate(resolve))
  app.state.upsertRoundEvent(completed)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(attempts.length, 2)
  assert.deepEqual(attempts[1], attempts[0])
})

test('v098 Supabase writer does not acknowledge or write either row for a mismatched pending target', async () => {
  const requests = []
  const client = createSupabaseIngestionClient({
    url: 'https://example.invalid',
    serviceKey: 'fixture-key',
    retryAttempts: 1,
    fetchImpl: async (url) => {
      requests.push(String(url))
      return { ok: true, status: 201, text: async () => '' }
    },
  })
  const mismatched = { ...buildLivePrediction(table), targetRound: 22 }

  await assert.rejects(client.persistRound(completed, table, mismatched), /prediction target mismatch/)
  assert.deepEqual(requests, [])
})

test('v098 Supabase writer retries both idempotent rows after prediction persistence fails', async () => {
  const requests = []
  let predictionFailures = 1
  const client = createSupabaseIngestionClient({
    url: 'https://example.invalid',
    serviceKey: 'fixture-key',
    retryAttempts: 1,
    fetchImpl: async (url, options) => {
      const path = new URL(url).pathname
      requests.push({ path, body: JSON.parse(options.body) })
      if (path.endsWith('/daily_prediction_results') && predictionFailures-- > 0) {
        return { ok: false, status: 500, text: async () => 'fixture failure' }
      }
      return { ok: true, status: 201, text: async () => '' }
    },
  })
  const pending = buildLivePrediction(table)

  await assert.rejects(client.persistRound(completed, table, pending), /daily_prediction_results failed/)
  const result = await client.persistRound(completed, table, pending)

  assert.equal(result.prediction.prediction_features.prediction_timing, 'pre_result_context')
  assert.deepEqual(requests.map(({ path }) => path), [
    '/rest/v1/daily_roadmap_events',
    '/rest/v1/daily_prediction_results',
    '/rest/v1/daily_roadmap_events',
    '/rest/v1/daily_prediction_results',
  ])
  assert.deepEqual(requests[3].body, requests[1].body)
})

