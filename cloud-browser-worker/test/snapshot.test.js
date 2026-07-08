import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeWinner,
  normalizeTable,
  extractSnapshotFromPayloads,
  redactUrlSecrets,
} from '../src/snapshot.js'

test('normalizes common banker/player/tie winner values for backend round contract', () => {
  assert.equal(normalizeWinner('B'), 'banker')
  assert.equal(normalizeWinner('莊'), 'banker')
  assert.equal(normalizeWinner('PLAYER'), 'player')
  assert.equal(normalizeWinner('閒'), 'player')
  assert.equal(normalizeWinner('T'), 'tie')
  assert.equal(normalizeWinner('和'), 'tie')
  assert.equal(normalizeWinner('unknown'), null)
})

test('normalizes MT-like table fields into cloud browser table contract', () => {
  const table = normalizeTable({
    table_id: 'BAC-01',
    table_name: '百家樂 1',
    current_shoe: '12',
    current_round: '34',
    total_round_banker: 11,
    total_round_player: 10,
    total_round_tie: 2,
    total_round_banker_pair: 3,
    total_round_player_pair: 4,
    bead_plate2: 'BPPT',
    big2: 'BBPP',
    big_eye2: '1,2',
    small2: '2,1',
    cockroach2: '1,1',
    next_banker2: { big: 'ask banker' },
    next_player2: { big: 'ask player' },
    dealer: { username: '小旻' },
    totalplayers: '123',
    room_id: '29',
    state: 0,
    orderState: 1,
    updated_at: '2026-07-05T00:00:00.000Z',
  }, 0)

  assert.deepEqual(table, {
    tableId: 'BAC-01',
    displayName: '百家樂 1',
    tableType: 'BAC',
    shoe: 12,
    round: 34,
    bankerCount: 11,
    playerCount: 10,
    tieCount: 2,
    bankerPairCount: 3,
    playerPairCount: 4,
    beadPlateRaw: 'BPPT',
    bigRoadRaw: 'BBPP',
    bigEyeRaw: '1,2',
    smallRoadRaw: '2,1',
    cockroachRaw: '1,1',
    nextBankerRaw: { big: 'ask banker' },
    nextPlayerRaw: { big: 'ask player' },
    dealerName: '小旻',
    totalPlayers: 123,
    roomId: '29',
    state: 0,
    orderState: 1,
    sourceUpdatedAt: '2026-07-05T00:00:00.000Z',
  })
})
test('extracts tables and rounds recursively from websocket/localStorage payloads', () => {
  const snapshot = extractSnapshotFromPayloads([
    JSON.stringify({
      data: {
        tables: [
          { tableId: 'BAG01', name: 'A桌', shoe: 7, round: 18, bankerCount: 9, playerCount: 8, tieCount: 1, bigRoadRaw: 'BP' },
        ],
      },
    }),
    { event: 'roundResult', round: { table_id: 'BAG01', shoe: 7, round_no: 19, result: 'B' } },
  ], { sessionId: 'test-session', now: '2026-06-30T00:00:00.000Z' })

  assert.equal(snapshot.connected, true)
  assert.equal(snapshot.authenticated, true)
  assert.equal(snapshot.sessionId, 'test-session')
  assert.equal(snapshot.tables.length, 1)
  assert.equal(snapshot.tables[0].tableId, 'BAG01')
  assert.equal(snapshot.rounds.length, 1)
  assert.deepEqual(snapshot.rounds[0], {
    tableId: 'BAG01',
    shoe: 7,
    round: 19,
    winner: 'banker',
    playerPoint: null,
    bankerPoint: null,
    rawResult: { event: 'roundResult', round: { table_id: 'BAG01', shoe: 7, round_no: 19, result: 'B' } },
    sourceAction: 'roundResult',
  })
})

test('extracts MT show_poker round result with banker/player points for Super Six validation', () => {
  const snapshot = extractSnapshotFromPayloads([
    JSON.stringify({
      action: { name: '/api/v1/gametype/*/game/*/room/*/table/*/show_poker' },
      body: {
        table_id: 'BAG06',
        shoe: 15669,
        round: 12,
        winner: 2,
        result: [11, 25, 7, 19, -1, -1, -1, -1, 4, 6],
      },
    }),
  ], { sessionId: 'test-session', now: '2026-06-30T00:00:00.000Z' })

  assert.equal(snapshot.rounds.length, 1)
  assert.equal(snapshot.rounds[0].tableId, 'BAG06')
  assert.equal(snapshot.rounds[0].winner, 'banker')
  assert.equal(snapshot.rounds[0].playerPoint, 4)
  assert.equal(snapshot.rounds[0].bankerPoint, 6)
  assert.deepEqual(snapshot.rounds[0].rawResult, [11, 25, 7, 19, -1, -1, -1, -1, 4, 6])
})

test('redacts token and secret values from login URL before exposing diagnostics', () => {
  assert.equal(
    redactUrlSecrets('https://gsa.ofalive99.net/?token=abc123&lang=zhtw&secret=def456'),
    'https://gsa.ofalive99.net/?token=[redacted]&lang=zhtw&secret=[redacted]',
  )
})

test('extracts MT tables from msg.tables with nested trend roads', () => {
  const snapshot = extractSnapshotFromPayloads([
    JSON.stringify({
      action: '/api/v1/gametype/*/game/*/room/*/tables',
      err: 0,
      msg: {
        tables: [
          {
            table_id: 'BAG01',
            table_name: '1',
            table_type: 'BAC',
            trend: {
              current_shoe: '12',
              current_round: '34',
              total_round_banker: '11',
              total_round_player: '10',
              total_round_tie: '2',
              bead_plate2: '0102#0201',
              big2: '0102,0201',
            },
          },
        ],
      },
    }),
  ], { sessionId: 'test-session', now: '2026-06-30T00:00:00.000Z' })

  assert.equal(snapshot.tables.length, 1)
  assert.equal(snapshot.tables[0].tableId, 'BAG01')
  assert.equal(snapshot.tables[0].round, 34)
  assert.equal(snapshot.tables[0].bankerCount, 11)
  assert.equal(snapshot.tables[0].beadPlateRaw, '0102#0201')
  assert.equal(snapshot.tables[0].bigRoadRaw, '0102,0201')
})


test('prefers nested trend roads over body text duplicates and filters non-BAG games', () => {
  const snapshot = extractSnapshotFromPayloads([
    { bodyProbe: '百家樂\n7\n367\n局數 23\n莊 10\n閒 11\n和 2' },
    JSON.stringify({
      msg: {
        tables: [
          {
            table_id: 'BAG07',
            table_name: '7',
            table_type: 'BAC',
            trend: {
              current_shoe: '367',
              current_round: '23',
              total_round_banker: '10',
              total_round_player: '11',
              total_round_tie: '2',
              big2: '0901,0801,#0702',
            },
          },
          { table_id: 'DTG01', table_name: '1', table_type: 'DT', trend: { current_round: '12', big2: '0101' } },
          { table_id: 'BAG03A', table_name: '3A', table_type: 'BAC', trend: { current_round: '5', big2: '0202' } },
        ],
      },
    }),
    { tables: [{ tableId: 'BAG3A', tableType: 'BAC', round: 5, bigRoadRaw: '' }] },
  ])

  assert.equal(snapshot.tables.some((table) => table.tableId === 'DTG01'), false)
  assert.equal(snapshot.tables.find((table) => table.tableId === 'BAG07').bigRoadRaw, '0901,0801,#0702')
  assert.equal(snapshot.tables.find((table) => table.tableId === 'BAG03A').bigRoadRaw, '0202')
})
