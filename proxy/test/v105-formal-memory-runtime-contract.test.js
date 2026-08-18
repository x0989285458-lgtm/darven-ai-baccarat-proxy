import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'
import { buildLivePrediction } from '../src/supabase-writer.js'
import { createOnlineCoreClient } from '../src/online-core.js'

test('durable authoritative Final triggers daily rollover without allowing memory failure to block settlement', async () => {
  const table = { tableId: 'BAG01', shoe: 88, round: 20 }
  const issued = { ...buildLivePrediction(table), predictionId: 'pid-daily-rollover', issuedAt: '2026-07-24T15:59:50.000Z' }
  const readStrategyVersions = []
  const observed = []
  let persisted = 0
  const writer = {
    configured: true,
    async readIssuedPrediction({ strategyVersion }) {
      readStrategyVersions.push(strategyVersion)
      return strategyVersion === 'v105' ? issued : null
    },
    async persistRound() {
      persisted += 1
      return { prediction: {
        table_id: 'BAG01', shoe_no: '88', round_no: 21, strategy_version: 'v105',
        predicted_result: issued.predictedResult, actual_result: 'banker', is_hit: true,
        prediction_features: { settlement_final: true }, resolved_at: '2026-07-24T16:00:01.000Z',
      } }
    },
  }
  const dailyMemoryRollover = {
    async observe(event) {
      observed.push(event)
      throw new Error('memory write must not block settlement')
    },
  }
  const app = createApp({ autoConnect: false, supabaseClient: writer, dailyMemoryRollover })

  app.state.upsertRoundEvent({
    tableId: 'BAG01', shoe: 88, round: 21, winner: 'banker',
    rawResult: [1, 9, 2, 10, 0, 0, -1, -1, 3, 9],
    sourceAction: '/api/v1/gametype/*/game/*/room/*/table/*/summary',
  })
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.equal(persisted, 1)
  assert.deepEqual(readStrategyVersions, ['v106', 'v105'])
  assert.deepEqual(observed, [{ settlementFinal: true, resolvedAt: '2026-07-24T16:00:01.000Z' }])
  assert.equal(app.state.snapshot().status.persistenceStatus, 'ok')
  assert.equal(app.state.snapshot().status.persistenceError, null)
})

test('server assembles the default rollover from Online Core and Online Core exposes its DB loader', async () => {
  const dbOnlineCore = createOnlineCoreClient({ dbConnectionString: 'postgresql://unused:unused@localhost:5432/unused', url: '', serviceKey: '' })
  assert.equal(typeof dbOnlineCore.loadDailySummary, 'function', 'Online Core DB daily loader bridge is not implemented')

  const table = { tableId: 'BAG01', shoe: 88, round: 20 }
  const issued = { ...buildLivePrediction(table), predictionId: 'pid-default-daily-rollover', issuedAt: '2026-07-24T15:59:50.000Z' }
  const loadedDates = []
  const writtenDates = []
  const onlineCoreClient = {
    configured: true,
    async loadDailySummary(reportDate) {
      loadedDates.push(reportDate)
      return { rounds: 1, hits: 1, misses: 0, pushes: 0, mainEvaluated: 1, mainHitRate: 100, sideActions: 0, sideHits: 0, sideHitRate: null, categories: {} }
    },
    async upsertDailySummary(summary) {
      writtenDates.push(summary.reportDate)
      return { ok: true }
    },
  }
  const writer = {
    configured: true,
    async readIssuedPrediction() { return issued },
    async persistRound() {
      return { prediction: { table_id: 'BAG01', shoe_no: '88', round_no: 21, strategy_version: 'v105', predicted_result: issued.predictedResult, actual_result: 'banker', is_hit: true, prediction_features: { settlement_final: true }, resolved_at: '2026-07-24T16:00:01.000Z' } }
    },
  }
  const app = createApp({ autoConnect: false, supabaseClient: writer, onlineCoreClient })
  app.state.upsertRoundEvent({ tableId: 'BAG01', shoe: 88, round: 21, winner: 'banker', rawResult: [1, 9, 2, 10, 0, 0, -1, -1, 3, 9], sourceAction: '/api/v1/gametype/*/game/*/room/*/table/*/summary' })
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.deepEqual(loadedDates, ['2026-07-24'])
  assert.deepEqual(writtenDates, ['2026-07-24'])
})
