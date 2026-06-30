import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'

test('v012 server wires round events to Supabase ingestion client', async () => {
  const persisted = []
  const app = createApp({
    autoConnect: false,
    supabaseClient: {
      ensureInitialStrategy: async () => persisted.push({ type: 'strategy' }),
      persistRound: async (round, table) => persisted.push({ type: 'round', round, table }),
    },
  })

  app.state.setTables([{ tableId: 'BAG03', displayName: 'MT百家樂第3桌', tableType: 'BAC', round: 42 }])
  app.state.upsertRoundEvent({ tableId: 'BAG03', shoe: 912, round: 43, rawResult: [26, 20, 39, 23, 14, 0, -1, -1, 1, 7], winner: 2 })
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(persisted[0].type, 'strategy')
  assert.equal(persisted[1].type, 'round')
  assert.equal(persisted[1].round.tableId, 'BAG03')
  assert.equal(persisted[1].table.displayName, 'MT百家樂第3桌')
})
