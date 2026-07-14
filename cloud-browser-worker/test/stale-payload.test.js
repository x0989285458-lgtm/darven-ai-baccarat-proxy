import test from 'node:test'
import assert from 'node:assert/strict'
import { extractSnapshotFromPayloads } from '../src/snapshot.js'

test('prefers newer higher-round body snapshot over stale rich road payload for same table', () => {
  const staleRichPayload = JSON.stringify({
    msg: {
      tables: [{
        table_id: 'BAG01',
        table_name: '1',
        table_type: 'BAC',
        trend: {
          current_shoe: '14182',
          current_round: '35',
          total_round_banker: '12',
          total_round_player: '19',
          total_round_tie: '3',
          bead_plate2: '0102#'.repeat(80),
          big2: '0901,,,,,#'.repeat(80),
        },
      }],
    },
  })
  const currentBodyProbe = {
    payloads: [JSON.stringify({
      bodyProbe: '百家樂\n1\n14182\n局數 36\n莊 13\n閒 20\n和 3',
    })],
  }

  const snapshot = extractSnapshotFromPayloads([staleRichPayload, currentBodyProbe], {
    sessionId: 'stale-regression',
    now: '2026-07-04T10:00:00.000Z',
  })

  const table = snapshot.tables.find((item) => item.tableId === 'BAG01')
  assert.equal(table.round, 36)
  assert.equal(table.bankerCount, 13)
  assert.equal(table.playerCount, 20)
  assert.equal(table.tieCount, 3)
  assert.equal(table.beadPlateRaw, '0102#'.repeat(80), 'same-shoe summary must not erase the last complete bead plate')
  assert.equal(table.bigRoadRaw, '0901,,,,,#'.repeat(80), 'same-shoe summary must not erase the last complete big road')
})

test('prefers later current-page body snapshot when shoe rolls over and old road payload has richer roads', () => {
  const stalePreviousShoePayload = JSON.stringify({
    tables: [{
      tableId: 'BAG09',
      displayName: '9',
      tableType: 'BAC',
      shoe: 3309,
      round: 52,
      bankerCount: 21,
      playerCount: 23,
      tieCount: 7,
      beadPlateRaw: '0102#'.repeat(80),
      bigRoadRaw: '0901,,,,,#'.repeat(80),
    }],
  })
  const currentNewShoeBodyProbe = {
    payloads: [JSON.stringify({
      bodyProbe: '百家樂\n9\n3310\n局數 1\n莊 1\n閒 0\n和 0',
    })],
  }

  const snapshot = extractSnapshotFromPayloads([stalePreviousShoePayload, currentNewShoeBodyProbe], {
    sessionId: 'shoe-rollover-regression',
    now: '2026-07-04T10:00:00.000Z',
  })

  const table = snapshot.tables.find((item) => item.tableId === 'BAG09')
  assert.equal(table.shoe, 3310)
  assert.equal(table.round, 1)
  assert.equal(table.bankerCount, 1)
  assert.equal(table.beadPlateRaw, '', 'new shoe must not inherit the previous shoe bead plate')
  assert.equal(table.bigRoadRaw, '', 'new shoe must not inherit the previous shoe big road')
})
