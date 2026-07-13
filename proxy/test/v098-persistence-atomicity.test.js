import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildLivePrediction, createSupabaseIngestionClient } from '../src/supabase-writer.js'
import { createApp } from '../src/server.js'

const table = { tableId: 'BAG01', shoe: 88, round: 20, bankerCount: 10, playerCount: 9 }
const completed = { tableId: 'BAG01', shoe: 88, round: 21, winner: 'banker', rawResult: [1, 9, 2, 10, -1, -1, -1, -1, 1, 9] }

test('v098 settlement RPC inserts both required rows in one database transaction', () => {
  const sql = readFileSync(new URL('../../frontend/supabase/schema_v098_snapshot_safety.sql', import.meta.url), 'utf8')
  const rpc = sql.match(/create or replace function public\.persist_v098_settled_round[\s\S]*?\$\$;/i)?.[0] ?? ''

  assert.match(rpc, /insert into public\.daily_roadmap_events/i)
  assert.match(rpc, /insert into public\.daily_prediction_results/i)
  assert.match(rpc, /on conflict \(source, table_id, shoe_no, round_no\)/i)
  assert.match(rpc, /on conflict \(source, table_id, shoe_no, round_no, strategy_version\)/i)
  assert.equal((rpc.match(/on conflict[\s\S]*?do nothing/gi) ?? []).length, 2)
  assert.doesNotMatch(rpc, /do update/i)
  assert.match(rpc, /raise exception 'settlement identity mismatch'/i)
  assert.match(rpc, /select\s+exists[\s\S]*daily_roadmap_events/i)
  assert.match(rpc, /select\s+exists[\s\S]*daily_prediction_results/i)
  assert.match(rpc, /if\s+not\s+roadmap_durable\s+or\s+not\s+prediction_durable/i)
  assert.doesNotMatch(rpc, /return\s+jsonb_build_object\('persisted',\s*true\)\s*;/i)
})

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

test('v098 Supabase writer atomically persists both settlement rows through one RPC and retries the identical payload', async () => {
  const requests = []
  let transactionFailures = 1
  const client = createSupabaseIngestionClient({
    url: 'https://example.invalid',
    serviceKey: 'fixture-key',
    retryAttempts: 1,
    fetchImpl: async (url, options) => {
      const path = new URL(url).pathname
      requests.push({ path, body: JSON.parse(options.body) })
      if (path.endsWith('/rpc/persist_v098_settled_round') && transactionFailures-- > 0) {
        return { ok: false, status: 500, text: async () => 'fixture failure' }
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ persisted: true, roadmapDurable: true, predictionDurable: true }) }
    },
  })
  const pending = buildLivePrediction(table)

  await assert.rejects(client.persistRound(completed, table, pending), /persist_v098_settled_round failed/)
  const result = await client.persistRound(completed, table, pending)

  assert.equal(result.prediction.prediction_features.prediction_timing, 'pre_result_context')
  assert.deepEqual(requests.map(({ path }) => path), [
    '/rest/v1/rpc/persist_v098_settled_round',
    '/rest/v1/rpc/persist_v098_settled_round',
  ])
  assert.deepEqual(requests[1].body, requests[0].body)
  assert.deepEqual(Object.keys(requests[0].body).sort(), ['p_prediction', 'p_roadmap'])
})

test('v098 Supabase writer rejects an RPC acknowledgement unless both rows are confirmed durable', async () => {
  const client = createSupabaseIngestionClient({
    url: 'https://example.invalid', serviceKey: 'fixture-key', retryAttempts: 1,
    fetchImpl: async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({ persisted: true, roadmapDurable: true, predictionDurable: false }),
    }),
  })

  await assert.rejects(client.persistRound(completed, table, buildLivePrediction(table)), /durable settlement acknowledgement/i)
})

test('v098 RPC persists the complete immutable pre-result feature snapshot without compact recomputation', async () => {
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

