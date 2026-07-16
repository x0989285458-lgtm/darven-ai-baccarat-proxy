import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'
import { buildLivePrediction } from '../src/supabase-writer.js'

const strategyVersion = 'v098.20_六階段權重門檻整合版'
const issuedAt = '2026-07-17T01:00:00.000Z'

function table(round) {
  return {
    tableId: 'BAG08', shoe: 18885, round,
    sourceUpdatedAt: '2026-07-17T01:00:00.000Z',
    beadPlateRaw: '0102', bigRoadRaw: 'BP',
  }
}

function durablePrediction(sourceTable, predictedResult, predictionId) {
  return {
    ...buildLivePrediction(sourceTable),
    predictedResult,
    predictionId,
    issuedAt,
  }
}

test('v098.22 decorates visible round with its exact durable issuance while pre-issuing the future round', async () => {
  const exact35 = durablePrediction(table(34), 'banker', 'pid-round-35')
  const issued = new Map([[35, exact35]])
  const writer = {
    configured: true,
    async issuePrediction(candidate) {
      const durable = {
        ...candidate,
        predictedResult: candidate.targetRound === 36 ? 'player' : candidate.predictedResult,
        predictionId: `pid-round-${candidate.targetRound}`,
        issuedAt,
      }
      issued.set(candidate.targetRound, durable)
      return durable
    },
    async readIssuedPrediction({ tableId, shoe, round, strategyVersion: requestedStrategy }) {
      assert.equal(tableId, 'BAG08')
      assert.equal(String(shoe), '18885')
      assert.equal(requestedStrategy, strategyVersion)
      return issued.get(round) ?? null
    },
  }
  const app = createApp({ autoConnect: false, supabaseClient: writer, now: () => Date.parse('2026-07-17T01:00:30.000Z') })

  app.state.setTables([table(35)])
  const visible35 = JSON.parse((await app.inject({ url: '/api/tables' })).body)[0]
  assert.equal(issued.get(36)?.predictedResult, 'player', 'future round 36 should still be pre-issued')
  assert.equal(visible35.prediction.targetRound, 35)
  assert.equal(visible35.prediction.predictedResult, 'banker')
  assert.equal(visible35.prediction.predictionId, 'pid-round-35')

  app.state.setTables([table(36)])
  const visible36 = JSON.parse((await app.inject({ url: '/api/tables' })).body)[0]
  assert.equal(visible36.prediction.targetRound, 36)
  assert.equal(visible36.prediction.predictedResult, 'player')
  assert.equal(visible36.prediction.predictionId, 'pid-round-36')
})

test('v098.22 returns null when no exact durable issuance exists instead of exposing a generated future candidate', async () => {
  const writer = {
    configured: true,
    async issuePrediction(candidate) {
      return { ...candidate, predictionId: `pid-round-${candidate.targetRound}`, issuedAt }
    },
    async readIssuedPrediction() {
      return null
    },
  }
  const app = createApp({ autoConnect: false, supabaseClient: writer, now: () => Date.parse('2026-07-17T01:00:30.000Z') })
  app.state.setTables([table(35)])

  const visible = JSON.parse((await app.inject({ url: '/api/tables' })).body)[0]
  assert.equal(visible.prediction, null)
})

test('v098.22 local non-durable mode exposes only an exact screen-round prediction', async () => {
  const app = createApp({ autoConnect: false, supabaseClient: { configured: false } })
  app.state.setTables([table(35)])

  const visible = JSON.parse((await app.inject({ url: '/api/tables' })).body)[0]
  assert.equal(visible.prediction.targetRound, 35)
  assert.equal(visible.prediction.targetShoe, '18885')
  assert.equal(visible.prediction.targetTableId, 'BAG08')
})
