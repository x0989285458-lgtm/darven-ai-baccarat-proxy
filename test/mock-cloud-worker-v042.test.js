import test from 'node:test'
import assert from 'node:assert/strict'
import { buildMockCloudWorkerSnapshot } from '../src/mock-cloud-worker.js'

test('v042 mock cloud worker snapshot matches cloud capture payload contract', () => {
  const snapshot = buildMockCloudWorkerSnapshot({ sessionId: 'smoke-session', tableCount: 3, round: 8 })
  assert.equal(snapshot.connected, true)
  assert.equal(snapshot.authenticated, true)
  assert.equal(snapshot.sessionId, 'smoke-session')
  assert.equal(snapshot.tables.length, 3)
  assert.equal(snapshot.tables[0].tableId, 'BAG01')
  assert.equal(snapshot.tables[0].displayName, 'MT百家樂第1桌')
  assert.equal(snapshot.tables[0].round, 8)
  assert.equal(snapshot.rounds.length, 3)
  assert.equal(snapshot.rounds[0].winner, 'banker')
})
