import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRoadmapEventRow } from '../src/supabase-writer.js'
import { buildPredictionResultRow } from './helpers/prediction-result.js'
import { createProxyState } from '../src/state-store.js'

test('v082 five-road ask-road compares road content instead of equal payload length', () => {
  const row = buildPredictionResultRow(
    { tableId: 'BAG82', shoe: 82, round: 12, winner: 'banker', rawResult: [1, 9, 2, 10, -1, -1, -1, -1, 3, 6] },
    {
      tableId: 'BAG82', shoe: 82, round: 11, bankerCount: 8, playerCount: 8, tieCount: 1,
      beadPlateRaw: '0201020102', bigRoadRaw: 'BPBPB',
      nextBankerRaw: {
        bead_plate: '0202020202',
        big: 'BBBBBBBBBB',
        big_eye: '1111111111',
        small: '1111111111',
        cockroach: '1111111111',
      },
      nextPlayerRaw: {
        bead_plate: '0102020102',
        big: 'BPPBBPPBPB',
        big_eye: '1212121212',
        small: '2121212121',
        cockroach: '1212211221',
      },
    },
  )
  assert.equal(row.prediction_features.derived_main_features.askRoadSignals.preferred, 'banker')
  assert.ok(row.prediction_features.unified_main_scores.ask_road_signals.banker > row.prediction_features.unified_main_scores.ask_road_signals.player)
})

test('v082 snapshot-delta inferred rows reuse exact show_poker result points when available', () => {
  const emitted = []
  const state = createProxyState({ onRoundEvent: (round, table) => emitted.push({ round, table }) })
  state.setTables([{ tableId: 'BAG82', shoe: 82, round: 5, bankerCount: 2, playerCount: 2, tieCount: 0, bankerPairCount: 0, playerPairCount: 0, beadPlateRaw: '02010102', bigRoadRaw: 'BPBP' }])
  state.upsertRoundEvent({ tableId: 'BAG82', shoe: 82, round: 6, winner: 'tie', rawResult: [1, 9, 2, 10, -1, -1, -1, -1, 6, 6], sourceAction: 'summary' })
  state.setTables([{ tableId: 'BAG82', shoe: 82, round: 6, bankerCount: 2, playerCount: 2, tieCount: 1, bankerPairCount: 0, playerPairCount: 0, beadPlateRaw: '0201010203', bigRoadRaw: 'BPBPT' }])

  const inferred = emitted.find((item) => item.round.sourceAction === 'table_snapshot_delta')
  assert.ok(inferred, 'snapshot delta event should be emitted')
  assert.deepEqual(inferred.round.rawResult, [1, 9, 2, 10, -1, -1, -1, -1, 6, 6])
  assert.equal(inferred.round.playerPoint, 6)
  assert.equal(inferred.round.bankerPoint, 6)

  const row = buildRoadmapEventRow(inferred.round, inferred.table)
  assert.equal(row.player_points, 6)
  assert.equal(row.banker_points, 6)
})
