import test from 'node:test'
import assert from 'node:assert/strict'
import { createRecentTablePerformanceStore } from '../src/recent-table-performance.js'
import { createApp } from '../src/server.js'

test('hydrates and updates an 18-round settled real-card performance window per table', () => {
  const store = createRecentTablePerformanceStore({ windowSize: 18 })
  const rows = Array.from({ length: 22 }, (_, index) => ({
    table_id: 'BAG01', shoe_no: '1', round_no: index + 1,
    strategy_version: index < 10 ? 'v097_副預測命中校準與門檻降5版' : 'v98',
    predicted_result: 'banker', actual_result: index % 3 === 0 ? 'player' : 'banker',
    created_at: new Date(Date.UTC(2026, 6, 14, 0, index)).toISOString(),
  }))
  rows.splice(5, 0, { ...rows[5], round_no: 99, actual_result: 'tie' })
  rows.push(structuredClone(rows.at(-1)))

  store.hydrate(rows.reverse())
  assert.deepEqual(store.summary('BAG01'), {
    recentHitRate: 2 / 3,
    recentPredictionCount: 18,
    source: 'settled_real_card_window',
  })

  store.record({ table_id: 'BAG01', shoe_no: '1', round_no: 23, strategy_version: 'v98', predicted_result: 'player', actual_result: 'banker', created_at: '2026-07-14T01:00:00.000Z' })
  assert.equal(store.summary('BAG01').recentPredictionCount, 18)
  assert.equal(store.summary('BAG01').recentHitRate < 2 / 3, true)
})

test('returns an unavailable summary before a table has settled banker/player rows', () => {
  const store = createRecentTablePerformanceStore()
  store.hydrate([{ table_id: 'BAG02', shoe_no: '1', round_no: 1, predicted_result: 'banker', actual_result: 'tie' }])
  assert.deepEqual(store.summary('BAG02'), { recentHitRate: null, recentPredictionCount: 0, source: 'settled_real_card_window' })
})

test('proxy warms settled performance before creating a live prediction', async (t) => {
  const rows = Array.from({ length: 18 }, (_, index) => ({
    table_id: 'BAG01', shoe_no: '7', round_no: index + 1,
    strategy_version: 'v097_副預測命中校準與門檻降5版', predicted_result: 'banker',
    actual_result: index < 13 ? 'banker' : 'player', created_at: new Date(Date.UTC(2026, 6, 14, 0, index)).toISOString(),
  }))
  const issuedAt = '2026-07-17T01:00:00.000Z'
  let futureCandidate = null
  const supabaseClient = {
    configured: true,
    ensureInitialStrategy: async () => ({ ok: true }),
    getRuntimeStatus: () => ({ ready: true, degraded: false, activeStrategyVersion: 'v98' }),
    getRecentPredictionRows: async () => rows,
    issuePrediction: async (candidate) => {
      futureCandidate = candidate
      return { ...candidate, predictionId: 'warmup-future', issuedAt }
    },
    readIssuedPrediction: async ({ round }) => ({ ...futureCandidate, targetRound: round, predictionId: 'warmup-screen', issuedAt }),
  }
  const app = createApp({ autoConnect: false, port: 0, production: true, memberAuthRequired: false, supabaseClient })
  await app.start()
  t.after(() => app.stop())
  app.state.setTables([{ tableId: 'BAG01', shoe: 8, round: 1, bankerCount: 8, playerCount: 8, tieCount: 1, beadPlateRaw: '02010102' }])
  const response = await app.inject({ method: 'GET', url: '/api/tables', headers: { 'x-forwarded-proto': 'https' } })
  const prediction = JSON.parse(response.body)[0].prediction
  assert.equal(prediction.targetRound, 1)
  assert.equal(prediction.predictionFeatures.confidence_calibration.reason, 'settled-hit-rate-calibration')
  assert.equal(prediction.predictionFeatures.confidence_calibration.recentPredictionCount, 18)
  assert.equal(prediction.confidence >= 60, true)
})
