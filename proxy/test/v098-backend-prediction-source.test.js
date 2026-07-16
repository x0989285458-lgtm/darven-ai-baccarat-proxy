import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'
import { buildLivePrediction } from '../src/supabase-writer.js'

const issuedAt = '2026-07-17T01:00:00.000Z'

test('v098.22 tables expose only a complete backend prediction for the exact screen round', async () => {
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
