import test from 'node:test'
import assert from 'node:assert/strict'
import { createV106FormalRuntime } from '../src/v106-formal-runtime.js'

const table = { tableId: 'BAG01', shoe: 'S106', round: 6, bigRoadRaw: 'B#P,P#B,B#P,P' }

test('v106 runtime hydrates only v106 formal issuance/final history and exposes formal status', async () => {
  const calls = []
  const runtime = createV106FormalRuntime({ writer: { configured: true, async getV106FormalHistory(options) { calls.push(options); return [] } } })
  await runtime.start()
  const prediction = await runtime.buildPrediction(table)
  assert.equal(calls.length, 1)
  assert.equal(prediction.strategyVersion, 'v106')
  assert.deepEqual(runtime.snapshot(), {
    strategyVersion: 'v106', status: 'ready', error: null,
    historySource: 'v106_formal_with_v105_read_only_calibration_history', historyRows: 0,
    lastIssuanceByTable: {},
  })
})

test('v106 runtime hydrates predecessor v105 rows as read-only calibration compatibility', async () => {
  const predecessor = {
    id: 'v105-history-1', strategy_version: 'v105', prediction_timing: 'pre_result_context',
    prediction_issued_at: '2026-08-18T00:00:00.000Z', settlement_final: true,
    table_id: 'BAG01', shoe_no: 'S105', round_no: 5,
    predicted_result: 'banker', actual_result: 'banker',
    issued_prediction_payload: { strategyVersion: 'v105', predictionTiming: 'pre_result_context' },
  }
  const runtime = createV106FormalRuntime({
    writer: { configured: true, async getV106FormalHistory() { return [predecessor] } },
  })
  await runtime.start()
  assert.equal(runtime.snapshot().historyRows, 1)
  assert.equal(runtime.snapshot().lastIssuanceByTable.BAG01.direction, 'banker')
  assert.equal(runtime.recordSettlement({ ...predecessor, settlement_final: true, actual_result: 'player' }), true)
})

test('v106 runtime keeps the newest issuance state when DB history is newest-first', async () => {
  const newest = {
    id: 'newest', strategy_version: 'v106', prediction_timing: 'pre_result_context',
    prediction_issued_at: '2026-08-18T02:00:00.000Z', settlement_final: false,
    table_id: 'BAG01', shoe_no: 'S-new', round_no: 9, predicted_result: 'player',
    issued_prediction_payload: { predictionId: 'newest', strategyVersion: 'v106', predictionTiming: 'pre_result_context' },
  }
  const oldest = {
    ...newest, id: 'oldest', prediction_issued_at: '2026-08-18T01:00:00.000Z',
    shoe_no: 'S-old', round_no: 8, predicted_result: 'banker',
    issued_prediction_payload: { predictionId: 'oldest', strategyVersion: 'v106', predictionTiming: 'pre_result_context' },
  }
  const runtime = createV106FormalRuntime({ writer: { configured: true, async getV106FormalHistory() { return [newest, oldest] } } })
  await runtime.start()
  assert.deepEqual(runtime.snapshot().lastIssuanceByTable.BAG01, {
    shoe: 'S-new', round: 9, direction: 'player', sameSideStreak: 1,
  })
})

test('v106 runtime accepts immutable formal issuance once and settlements only from verified Final', async () => {
  const runtime = createV106FormalRuntime({ allowUnconfigured: true })
  const prediction = await runtime.buildPrediction(table)
  const issued = { ...prediction, predictionId: 'v106-1', issuedAt: '2026-08-18T01:00:00.000Z' }
  assert.equal(runtime.recordIssuance(issued), true)
  assert.equal(runtime.recordIssuance(structuredClone(issued)), false)
  assert.throws(() => runtime.recordIssuance({ ...issued, predictedResult: issued.predictedResult === 'banker' ? 'player' : 'banker' }), /immutable|conflicting/i)
  assert.equal(runtime.recordSettlement({ id: 'v106-1', strategy_version: 'v106', settlement_final: false }), false)
  assert.equal(runtime.recordSettlement({ id: 'v106-1', strategy_version: 'v105', settlement_final: true }), false)
  assert.equal(runtime.recordSettlement({ id: 'v106-1', strategy_version: 'v106', settlement_final: true, actual_result: 'banker' }), true)
})
