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

test('failed table waits for every sibling settlement before releasing the next batch', async () => {
  const events = []
  let releaseSlowTable
  const slowTable = new Promise((resolve) => { releaseSlowTable = resolve })
  const state = {
    async preflightRoundEvent() { return { ok: true, value: {} } },
    setStatus() {}, setTables() {}, notifyTablesUpdated() {},
    async upsertRoundEvent(round) {
      events.push(`start:${round.tableId}`)
      if (round.tableId === 'BAG01') throw new Error('fast table failure')
      if (round.tableId === 'BAG02') {
        await slowTable
        events.push('end:BAG02')
      }
      return { ok: true }
    },
  }
  const run = (tableIds) => applyCloudCapturePayload({
    parsed: {
      sessionId: 'formal61-failure-settlement', status: {}, tables: [],
      rounds: tableIds.map((tableId) => ({ tableId, shoe: 1, round: 1, sourceAction: '/summary' })),
    },
    state,
    writer: { configured: false },
  })
  let firstSettled = false
  const first = run(['BAG01', 'BAG02']).finally(() => { firstSettled = true })
  await delay()
  const second = run(['BAG03'])
  await delay()
  assert.equal(firstSettled, false)
  assert.equal(events.includes('start:BAG03'), false)
  releaseSlowTable()
  await assert.rejects(first, /fast table failure/)
  await second
  assert.equal(events.indexOf('end:BAG02') < events.indexOf('start:BAG03'), true)
})
