import test from 'node:test'
import assert from 'node:assert/strict'
import { createProxyState } from '../src/state-store.js'
import { buildPredictionResultRow } from './helpers/prediction-result.js'
import { createApp } from '../src/server.js'

test('v048 infers new rounds from table snapshot deltas and keeps previous table as prediction context', async () => {
  const events = []
  const state = createProxyState({ onRoundEvent: async (round, table) => events.push({ round, table }) })
  state.setTables([{ tableId: 'BAG01', displayName: 'MT百家樂第1桌', shoe: 10, round: 20, bankerCount: 10, playerCount: 9, tieCount: 1, bankerPairCount: 2, playerPairCount: 1, beadPlateRaw: '0102', bigRoadRaw: '0701' }])
  state.setTables([{ tableId: 'BAG01', displayName: 'MT百家樂第1桌', shoe: 10, round: 21, bankerCount: 11, playerCount: 9, tieCount: 1, bankerPairCount: 3, playerPairCount: 1, beadPlateRaw: '010202', bigRoadRaw: '0701,0702' }])
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(events.length, 1)
  assert.equal(events[0].round.tableId, 'BAG01')
  assert.equal(events[0].round.round, 21)
  assert.equal(events[0].round.winner, 'banker')
  assert.deepEqual(events[0].round.sideActualResults, { bankerPair: true, playerPair: false, tie: false })
  assert.equal(events[0].table.round, 20)
  assert.equal(events[0].table.bankerCount, 10)
})

test('v048 infers new rounds from round number and bead road even when aggregate counts do not change', async () => {
  const events = []
  const state = createProxyState({ onRoundEvent: async (round, table) => events.push({ round, table }) })
  state.setTables([{ tableId: 'BAG03', displayName: 'MT百家樂第3桌', shoe: 15109, round: 27, bankerCount: 10, playerCount: 10, tieCount: 1, beadPlateRaw: '10113#0102', bigRoadRaw: '#0702,,,,,' }])
  state.setTables([{ tableId: 'BAG03', displayName: 'MT百家樂第3桌', shoe: 15109, round: 28, bankerCount: 10, playerCount: 10, tieCount: 1, beadPlateRaw: '113#010202', bigRoadRaw: '2,0902,,,,' }])
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(events.length, 1)
  assert.equal(events[0].round.round, 28)
  assert.equal(events[0].round.winner, 'banker')
  assert.equal(events[0].round.rawResult.inferredFromRoundDelta, true)
})

test('v071 does not infer a burst of fake banker rounds from synthetic zero-count table state', async () => {
  const events = []
  const state = createProxyState({ onRoundEvent: async (round, table) => events.push({ round, table }) })
  state.setTables([{ tableId: 'BAG01', displayName: 'MT百家樂BAG01', shoe: 10, round: 20, bankerCount: 0, playerCount: 0, tieCount: 0 }])
  state.setTables([{ tableId: 'BAG01', displayName: '1', shoe: 10, round: 25, bankerCount: 12, playerCount: 9, tieCount: 3, beadPlateRaw: '010102120202', bigRoadRaw: '0701,0702' }])
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(events.length, 0)
})

test('v071 live snapshot shoe and round are not overwritten by older lastRound state', async () => {
  const state = createProxyState({ onRoundEvent: async () => {} })
  state.setTables([{ tableId: 'BAG02', displayName: '2', shoe: 20, round: 30, bankerCount: 10, playerCount: 10, tieCount: 1, beadPlateRaw: '0102' }])
  state.upsertRoundEvent({ tableId: 'BAG02', shoe: 20, round: 31, winner: 'banker' })
  state.setTables([{ tableId: 'BAG02', displayName: '2', shoe: 20, round: 40, bankerCount: 14, playerCount: 20, tieCount: 5, beadPlateRaw: '010201020103' }])

  const table = state.snapshot().tables.find((item) => item.tableId === 'BAG02')
  assert.equal(table.round, 40)
  assert.equal(table.shoe, 20)
})

test('v048 prediction result row stores main and side prediction/actual learning payload', () => {
  const row = buildPredictionResultRow(
    { tableId: 'BAG01', shoe: 10, round: 21, winner: 'banker', sideActualResults: { bankerPair: true, playerPair: false, tie: false } },
    { tableId: 'BAG01', shoe: 10, round: 20, bankerCount: 10, playerCount: 9, tieCount: 1, bankerPairCount: 2, playerPairCount: 1, beadPlateRaw: '0102', bigRoadRaw: '0701' },
  )

  assert.equal(row.table_id, 'BAG01')
  assert.equal(row.actual_result, 'banker')
  assert.ok(row.prediction_features.side_predictions)
  assert.equal(row.prediction_features.side_actual_results.bankerPair, true)
  assert.equal(typeof row.prediction_features.side_hits.bankerPair, 'boolean')
})

test('v048 admin cloud-data status exposes today captured round count', async () => {
  const app = createApp({
    autoConnect: false,
    deployMode: 'cloud',
    captureSource: 'cloud_browser',
    supabaseClient: { configured: true, countTodayPredictionRounds: async () => 88 },
    licenseAdminClient: { getCloudDataStatus: async () => ({ ok: true, mtAutoLoginEnabled: false, captureSource: 'local_chrome', message: '本機VPN抓牌同步中', tableCount: 15 }) },
  })
  const response = await app.inject({ method: 'GET', url: '/api/cloud-data/status' })
  const body = JSON.parse(response.body)
  assert.equal(body.todayRoundCount, 88)
  assert.match(body.message, /88局/)
})
