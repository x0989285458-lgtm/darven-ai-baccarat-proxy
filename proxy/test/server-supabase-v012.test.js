import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'

test('v098.12 server settles rounds without re-running active strategy initialization', async () => {
  const persisted = []
  let strategyInitializations = 0
  const app = createApp({
    autoConnect: false,
    supabaseClient: {
      ensureInitialStrategy: async () => { strategyInitializations += 1 },
      persistRound: async (round, table) => persisted.push({ type: 'round', round, table }),
    },
  })

  app.state.setTables([{ tableId: 'BAG03', displayName: 'MT百家樂第3桌', tableType: 'BAC', shoe: 912, round: 42 }])
  app.state.upsertRoundEvent({ tableId: 'BAG03', shoe: 912, round: 43, rawResult: [26, 20, 39, 23, 14, 0, -1, -1, 1, 7], winner: 2, sourceAction: '/api/v1/gametype/*/game/*/room/*/table/*/summary' })
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(strategyInitializations, 0)
  assert.equal(persisted[0].type, 'round')
  assert.equal(persisted[0].round.tableId, 'BAG03')
  assert.equal(persisted[0].table.displayName, 'MT百家樂第3桌')
})
