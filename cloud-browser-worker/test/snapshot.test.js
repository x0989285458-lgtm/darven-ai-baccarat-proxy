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
    bead_plate2: 'BPPT',
    big2: 'BBPP',
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
    beadPlateRaw: 'BPPT',
    bigRoadRaw: 'BBPP',
  })
})

test('extracts tables and rounds recursively from websocket/localStorage payloads', () => {
  const snapshot = extractSnapshotFromPayloads([
    JSON.stringify({
      data: {
        tables: [
          { tableId: 'A01', name: 'A桌', shoe: 7, round: 18, bankerCount: 9, playerCount: 8, tieCount: 1, bigRoadRaw: 'BP' },
        ],
      },
    }),
    { event: 'roundResult', round: { table_id: 'A01', shoe: 7, round_no: 19, result: 'B' } },
  ], { sessionId: 'test-session', now: '2026-06-30T00:00:00.000Z' })

  assert.equal(snapshot.connected, true)
  assert.equal(snapshot.authenticated, true)
  assert.equal(snapshot.sessionId, 'test-session')
  assert.equal(snapshot.tables.length, 1)
  assert.equal(snapshot.tables[0].tableId, 'A01')
  assert.equal(snapshot.rounds.length, 1)
  assert.deepEqual(snapshot.rounds[0], {
    tableId: 'A01',
    shoe: 7,
    round: 19,
    winner: 'banker',
    rawResult: { event: 'roundResult', round: { table_id: 'A01', shoe: 7, round_no: 19, result: 'B' } },
  })
})

test('redacts token and secret values from login URL before exposing diagnostics', () => {
  assert.equal(
    redactUrlSecrets('https://gsa.ofalive99.net/?token=abc123&lang=zhtw&secret=def456'),
    'https://gsa.ofalive99.net/?token=[redacted]&lang=zhtw&secret=[redacted]',
  )
})
