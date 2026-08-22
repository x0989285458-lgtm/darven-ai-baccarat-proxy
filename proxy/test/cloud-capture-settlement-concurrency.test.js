import test from 'node:test'
import assert from 'node:assert/strict'
import { applyCloudCapturePayload } from '../src/cloud-capture.js'

const delay = () => new Promise((resolve) => setImmediate(resolve))

test('formal settlement runs tables concurrently while preserving each table order', async () => {
  const started = []
  let releaseFirstBag01
  const firstBag01 = new Promise((resolve) => { releaseFirstBag01 = resolve })
  const state = {
    async preflightRoundEvent() { return { ok: true, value: {} } },
    setStatus() {},
    setTables() {},
    notifyTablesUpdated() {},
    async upsertRoundEvent(round) {
      started.push(`${round.tableId}:${round.round}`)
      if (round.tableId === 'BAG01' && round.round === 1) await firstBag01
      return { ok: true }
    },
  }
  const work = applyCloudCapturePayload({
    parsed: {
      sessionId: 'formal60-concurrency',
      status: {},
      tables: [],
      rounds: [
        { tableId: 'BAG01', shoe: 1, round: 1, sourceAction: '/summary' },
        { tableId: 'BAG02', shoe: 1, round: 1, sourceAction: '/summary' },
        { tableId: 'BAG01', shoe: 1, round: 2, sourceAction: '/summary' },
      ],
    },
    state,
    writer: { configured: false },
  })
  await delay()
  assert.equal(started.includes('BAG01:1'), true)
  assert.equal(started.includes('BAG02:1'), true)
  assert.equal(started.includes('BAG01:2'), false)
  releaseFirstBag01()
  await work
  assert.deepEqual(started.filter((item) => item.startsWith('BAG01:')), ['BAG01:1', 'BAG01:2'])
})
