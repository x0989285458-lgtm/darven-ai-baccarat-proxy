import test from 'node:test'
import assert from 'node:assert/strict'
import { buildV104FormalPrediction } from '../src/v104-formal-strategy.js'

const historyRows = [
  {
    source: 'ofalive99', table_id: 'BAG01', shoe_no: '88', round_no: 4,
    strategy_version: 'v104', prediction_timing: 'pre_result_context',
    prediction_issued_at: '2026-07-21T00:00:04Z', predicted_result: 'banker', settlement_final: true,
    actual_result: 'player', resolved_at: '2026-07-21T00:00:05Z',
  },
  {
    source: 'ofalive99', table_id: 'BAG01', shoe_no: '88', round_no: 5,
    strategy_version: 'v104', prediction_timing: 'pre_result_context',
    prediction_issued_at: '2026-07-21T00:00:06Z', predicted_result: 'banker', settlement_final: true,
    actual_result: 'banker', resolved_at: '2026-07-21T00:00:07Z',
  },
]

const table = {
  tableId: 'BAG01', shoe: '88', round: 5,
  bankerCount: 8, playerCount: 7, tieCount: 1,
  beadPlateRaw: '02#02#01#02#01', bigRoadRaw: 'B#B#P#B#P',
}

test('v104 formal runtime hydrates formal issuance streaks and advances them only after durable acknowledgement', async () => {
  const module = await import('../src/v104-formal-runtime.js').catch(() => ({}))
  assert.equal(typeof module.createV104FormalRuntime, 'function', 'v104 formal runtime must exist')

  const calls = []
  const runtime = module.createV104FormalRuntime({
    writer: {
      configured: true,
      async getV104FormalHistory(options) {
        calls.push(options)
        return historyRows
      },
    },
  })
  await runtime.start()
  assert.deepEqual(calls, [{ limit: 10000, requestTimeoutMs: 10000 }])

  const expected = buildV104FormalPrediction(table, historyRows, {
    priorShoe: '88', priorDirection: 'banker', priorSameSideStreak: 2,
  })
  const candidate = await runtime.buildPrediction(table)
  assert.equal(candidate.predictedResult, expected.predictedResult)
  assert.equal(candidate.sameSideStreak, expected.sameSideStreak)

  const beforeAck = runtime.snapshot()
  assert.equal(beforeAck.lastIssuanceByTable.BAG01.round, 5)

  runtime.recordIssuance({
    ...candidate,
    predictionId: 'formal-v104-6',
    issuedAt: '2026-07-21T00:00:08Z',
  })
  const afterAck = runtime.snapshot()
  assert.equal(afterAck.lastIssuanceByTable.BAG01.round, 6)
  assert.equal(afterAck.lastIssuanceByTable.BAG01.sameSideStreak, candidate.sameSideStreak)

  const newShoe = await runtime.buildPrediction({ ...table, shoe: '89', round: 0, bankerCount: 0, playerCount: 0 })
  assert.equal(newShoe.sameSideStreak, 1)
  assert.equal(runtime.snapshot().historySource, 'v104_formal_issuance_and_final_only')
})
