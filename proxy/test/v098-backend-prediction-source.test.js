import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'

test('v098 tables expose only a complete backend prediction for current round plus one', async () => {
  const app = createApp({ autoConnect: false })
  app.state.setTables([{ tableId: 'BAG01', shoe: 88, round: 20, sourceUpdatedAt: new Date().toISOString() }])
  const [table] = JSON.parse((await app.inject({ url: '/api/tables' })).body)
  assert.equal(table.prediction.source, 'backend')
  assert.equal(table.prediction.targetRound, 21)
  assert.deepEqual(Object.keys(table.prediction.sideActions).sort(), ['bankerDragon', 'bankerPair', 'playerDragon', 'playerPair', 'superSix', 'tie'])
})
