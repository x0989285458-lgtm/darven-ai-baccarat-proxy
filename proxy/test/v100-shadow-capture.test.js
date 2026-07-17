import test from 'node:test'
import assert from 'node:assert/strict'
import { applyCloudCapturePayload } from '../src/cloud-capture.js'

const parsed = {
  sessionId: 's1',
  status: { connected: true },
  tables: [{ tableId: 'BAG01', shoe: 'S100', round: 1 }],
  rounds: [{ tableId: 'BAG01', shoe: 'S100', round: 1 }],
}

function stateRecorder(order) {
  return {
    setStatus(value) { order.push(['status', value]) },
    setTables(value) { order.push(['tables', structuredClone(value)]) },
    upsertRoundEvent(value) { order.push(['round', structuredClone(value)]) },
  }
}

test('v100 shadow capture runs durably before formal state and never decorates v98 tables', async () => {
  const order = []
  const input = structuredClone(parsed)
  const result = await applyCloudCapturePayload({
    parsed: input,
    state: stateRecorder(order),
    writer: { configured: false },
    v100Shadow: { enabled: true, async processSnapshot(snapshot) { order.push(['shadow', structuredClone(snapshot)]); return { enabled: true, shadows: [{ targetRound: 2 }] } } },
  })

  assert.deepEqual(order.map(([name]) => name), ['shadow', 'status', 'tables', 'round'])
  assert.equal(result.v100Shadow.shadows[0].targetRound, 2)
  assert.equal(input.tables[0].v100RankLedger, undefined)
})

test('v100 formal rank-ledger failure rejects capture before state or durable ACK work', async () => {
  const order = []
  await assert.rejects(() => applyCloudCapturePayload({
    parsed: structuredClone(parsed), state: stateRecorder(order), writer: { configured: false },
    v100Shadow: { enabled: true, async processSnapshot() { throw new Error('rank ledger unavailable') } },
  }), /rank ledger unavailable/)

  assert.deepEqual(order.map(([name]) => name), ['status'])
  assert.equal(order[0][1].v100RuntimeStatus, 'error')
})
