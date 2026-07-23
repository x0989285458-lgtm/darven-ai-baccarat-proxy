import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildLivePrediction, createSupabaseIngestionClient } from '../src/supabase-writer.js'
import { createApp } from '../src/server.js'

const table = { tableId: 'BAG01', shoe: 88, round: 20, bankerCount: 10, playerCount: 9 }
const completed = { tableId: 'BAG01', shoe: 88, round: 21, winner: 'banker', rawResult: [1, 9, 2, 10, -1, -1, -1, -1, 1, 9], sourceAction: '/api/v1/gametype/*/game/*/room/*/table/*/summary' }

test('configured writer refuses persistence until the active strategy is verified', async () => {
  const requests = []
  const client = createSupabaseIngestionClient({
    url: 'https://example.invalid', serviceKey: 'fixture-key', retryAttempts: 1,
    requireVerifiedStrategy: true,
    fetchImpl: async (url) => {
      requests.push(String(url))
      return { ok: true, status: 200, text: async () => JSON.stringify({ persisted: true, roadmapDurable: true, predictionDurable: true }) }
    },
  })

  await assert.rejects(
    client.persistRound(completed, table, buildLivePrediction(table)),
    /active[_ ]strategy[_ ]not[_ ]verified/i,
  )
  assert.deepEqual(requests, [])
})

test('persistence failure retries the identical pending snapshot without recomputing it', async () => {
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

test('Supabase writer does not acknowledge or write either row for a mismatched pending target', async () => {
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

test('Supabase writer atomically persists both settlement rows through one RPC and retries the identical payload', async () => {
  const requests = []
  let transactionFailures = 1
  const client = createSupabaseIngestionClient({
    url: 'https://example.invalid',
    serviceKey: 'fixture-key',
    retryAttempts: 1,
    fetchImpl: async (url, options) => {
      const path = new URL(url).pathname
      requests.push({ path, body: JSON.parse(options.body) })
      if (path.endsWith('/rpc/persist_v105_settled_round') && transactionFailures-- > 0) {
        return { ok: false, status: 500, text: async () => 'fixture failure' }
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ persisted: true, roadmapDurable: true, predictionDurable: true }) }
    },
  })
  const pending = buildLivePrediction(table)

  await assert.rejects(client.persistRound(completed, table, pending), /persist_v105_settled_round failed/)
  const result = await client.persistRound(completed, table, pending)

  assert.equal(result.prediction.prediction_features.prediction_timing, 'pre_result_context')
  assert.deepEqual(requests.map(({ path }) => path), [
    '/rest/v1/rpc/persist_v105_settled_round',
    '/rest/v1/rpc/persist_v105_settled_round',
  ])
  assert.deepEqual(requests[1].body, requests[0].body)
  assert.deepEqual(Object.keys(requests[0].body).sort(), ['p_prediction', 'p_roadmap'])
})

test('Supabase writer rejects an RPC acknowledgement unless both rows are confirmed durable', async () => {
  const client = createSupabaseIngestionClient({
    url: 'https://example.invalid', serviceKey: 'fixture-key', retryAttempts: 1,
    fetchImpl: async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({ persisted: true, roadmapDurable: true, predictionDurable: false }),
    }),
  })

  await assert.rejects(client.persistRound(completed, table, buildLivePrediction(table)), /durable settlement acknowledgement/i)
})

test('RPC persists the complete immutable pre-result feature snapshot without compact recomputation', async () => {
  let rpcBody
  const client = createSupabaseIngestionClient({
    url: 'https://example.invalid', serviceKey: 'fixture-key', retryAttempts: 1,
    fetchImpl: async (_url, options) => {
      rpcBody = JSON.parse(options.body)
      return { ok: true, status: 200, text: async () => JSON.stringify({ persisted: true, roadmapDurable: true, predictionDurable: true }) }
    },
  })
  const pending = buildLivePrediction({ ...table, beadPlateRaw: '0102', cardShoe: { remainingRankCounts: { A: 31 } } })

  await client.persistRound(completed, table, pending)

  for (const key of ['mt_context', 'derived_main_features', 'unified_main_scores', 'road_features', 'card_shoe_features', 'side_card_rank_features', 'side_prediction_rank_inputs']) {
    assert.deepEqual(rpcBody.p_prediction.prediction_features[key], pending.predictionFeatures[key])
  }
  assert.deepEqual(rpcBody.p_prediction.probabilities, pending.probabilities)
})

test('writer bounds completed-round memory and rebuilds an evicted payload instead of retaining it forever', async () => {
  const bodies = []
  const client = createSupabaseIngestionClient({
    url: 'https://example.invalid', serviceKey: 'fixture-key', retryAttempts: 1, maxCompletedRoundKeys: 1,
    fetchImpl: async (_url, options) => {
      bodies.push(JSON.parse(options.body))
      return { ok: true, status: 200, text: async () => JSON.stringify({ persisted: true, roadmapDurable: true, predictionDurable: true }) }
    },
  })
  const secondTable = { ...table, round: 21 }
  const secondCompleted = { ...completed, round: 22 }
  const original = buildLivePrediction(table)

  await client.persistRound(completed, table, original)
  await client.persistRound(secondCompleted, secondTable, buildLivePrediction(secondTable))
  await client.persistRound(completed, table, { ...original, confidence: original.confidence + 1 })

  assert.equal(bodies.length, 3)
  assert.equal(bodies[2].p_prediction.confidence, original.confidence + 1)
})

