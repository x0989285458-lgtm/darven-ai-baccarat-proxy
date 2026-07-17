import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildStrictTemporalRankState,
  deriveTrainOnlyCalibrationOffsets,
  reconstructV100BacktestTable,
} from '../src/v100-backtest.js'
import { calculateV100SidePredictionShadow } from '../src/supabase-writer.js'

const FINAL = '/api/v1/gametype/*/game/*/room/*/table/*/summary'

test('backtest table uses the product bead-road pair fallback when persisted pair count is zero', () => {
  const row = {
    table_id: 'BAG01', shoe_no: 'S1', round_no: 3,
    prediction_features: {
      mt_context: { tableId: 'BAG01', shoe: 'S1', round: 2, bankerCount: 1, playerCount: 1, tieCount: 0, bankerPairCount: 0, playerPairCount: 0 },
      road_features: { beadPlateRaw: '011101020201' },
      side_predictions: { tie: 0, superSix: 0, bankerPair: 0, playerPair: 0, bankerDragon: 0, playerDragon: 0 },
    },
  }
  const table = reconstructV100BacktestTable(row)
  const scored = calculateV100SidePredictionShadow({
    table,
    rankAvailable: false,
    rankFallback: 'renormalize',
    mainPrediction: 'banker',
    v98SidePredictions: row.prediction_features.side_predictions,
  })
  assert.equal(table.bankerPairCount, 0)
  assert.equal(scored.diagnostics.primitives.XB > 0, true, 'must use bead-road pair fallback instead of hard-coded zero')
})

test('strict temporal rank state excludes a later-arriving prior-round event', () => {
  const prediction = { source: 'ofalive99', table_id: 'BAG01', shoe_no: 'S1', round_no: 2, created_at: '2026-07-17T10:00:00.000Z' }
  const event = {
    source: 'ofalive99', table_id: 'BAG01', shoe_no: 'S1', round_no: 1,
    received_at: '2026-07-17T10:00:01.000Z',
    raw_event: { tableId: 'BAG01', shoe: 'S1', round: 1, sourceAction: FINAL, rawResult: [1, 14, 2, 15, -1, -1, -1, -1, 4, 5], winner: 'banker' },
  }
  assert.equal(buildStrictTemporalRankState(prediction, [event]), null)
  assert.equal(buildStrictTemporalRankState({ ...prediction, created_at: '2026-07-17T10:00:02.000Z' }, [event])?.rankDataAvailable, true)
})

test('calibration offsets are derived from train rows only', () => {
  const train = [
    { raw: { tie: 10, superSix: 20, bankerPair: 30, playerPair: 40 }, main: 'banker' },
    { raw: { tie: 20, superSix: 30, bankerPair: 40, playerPair: 50 }, main: 'player' },
    { raw: { tie: 30, superSix: 40, bankerPair: 50, playerPair: 60 }, main: 'banker' },
    { raw: { tie: 40, superSix: 50, bankerPair: 60, playerPair: 70 }, main: 'player' },
  ]
  const first = deriveTrainOnlyCalibrationOffsets(train)
  const second = deriveTrainOnlyCalibrationOffsets(train, [{ raw: { tie: 100, superSix: 100, bankerPair: 100, playerPair: 100 }, main: 'banker' }])
  assert.deepEqual(second, first)
})
