import test from 'node:test'
import assert from 'node:assert/strict'
import { extractSnapshotFromPayloads } from '../src/snapshot.js'

test('extracts verified MT summary action.name without explicit winner from card points', () => {
  const snapshot = extractSnapshotFromPayloads([
    JSON.stringify({
      action: { name: '/api/v1/gametype/*/game/*/room/*/table/*/summary' },
      body: { table_id: 'BAG05', shoe: 15396, round: 1, result: [26,40,43,20,0,0,-1,-1,4,8] },
      method: 'POST',
    }),
  ], { sessionId: 'test-session', now: '2026-07-06T00:00:00.000Z' })
  assert.equal(snapshot.rounds.length, 1)
  assert.equal(snapshot.rounds[0].tableId, 'BAG05')
  assert.equal(snapshot.rounds[0].winner, 'banker')
  assert.equal(snapshot.rounds[0].playerPoint, 4)
  assert.equal(snapshot.rounds[0].bankerPoint, 8)
})
