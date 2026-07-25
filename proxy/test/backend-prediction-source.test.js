import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'
import { buildLivePrediction } from '../src/supabase-writer.js'

const issuedAt = '2026-07-17T01:00:00.000Z'

test('tables expose only a complete backend prediction for the exact screen round', async () => {
  const tableState = { tableId: 'BAG01', shoe: 88, round: 20, sourceUpdatedAt: issuedAt }
  const exact = {
    ...buildLivePrediction({ ...tableState, round: 19 }),
    predictionId: 'pid-screen-round-20',
    issuedAt,
  }
  const app = createApp({
    autoConnect: false,
    supabaseClient: {
      configured: true,
      issuePrediction: async (candidate) => ({ ...candidate, predictionId: `pid-${candidate.targetRound}`, issuedAt }),
      readIssuedPrediction: async () => exact,
    },
  })
  app.state.setTables([tableState])
  const [table] = JSON.parse((await app.inject({ url: '/api/tables' })).body)
  assert.equal(table.prediction.source, 'backend')
  assert.equal(table.prediction.targetRound, 20)
  assert.equal(table.prediction.predictionId, 'pid-screen-round-20')
  assert.equal(table.prediction.issuedAt, issuedAt)
  assert.deepEqual(Object.keys(table.prediction.sideActions).sort(), ['bankerDragon', 'bankerPair', 'playerDragon', 'playerPair', 'superSix', 'tie'])
})

test('tables return current live data without waiting for a hung durable prediction issuance', async () => {
  let issuanceStarted = false
  const never = new Promise(() => {})
  const app = createApp({
    autoConnect: false,
    supabaseClient: {
      configured: true,
      issuePrediction: async () => {
        issuanceStarted = true
        return never
      },
      readIssuedPrediction: async () => never,
    },
  })
  app.state.setTables([{ tableId: 'BAG01', shoe: 88, round: 20, sourceUpdatedAt: issuedAt }])
  await new Promise((resolve) => setImmediate(resolve))

  const response = await Promise.race([
    app.inject({ url: '/api/tables' }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('tables read waited for issuance')), 100)),
  ])
  const [table] = JSON.parse(response.body)
  assert.equal(issuanceStarted, true)
  assert.equal(table.tableId, 'BAG01')
  assert.equal(table.prediction, null)
})

test('missing durable screen prediction is negatively cached to avoid repeated database reads', async () => {
  let readCalls = 0
  const app = createApp({
    autoConnect: false,
    supabaseClient: {
      configured: true,
      issuePrediction: async (candidate) => ({ ...candidate, predictionId: 'future', issuedAt }),
      readIssuedPrediction: async () => { readCalls += 1; return null },
    },
  })
  app.state.setTables([{ tableId: 'BAG01', shoe: 89, round: 20, sourceUpdatedAt: issuedAt }])

  assert.equal((await app.inject({ url: '/api/tables' })).statusCode, 200)
  assert.equal((await app.inject({ url: '/api/tables' })).statusCode, 200)
  assert.equal(readCalls, 1)
})
