import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createShadowProcessClient } from '../src/shadow-process-client.js'
import { prepareShadowRuntimes, processShadowCapture } from '../src/shadow-process-work.js'
import { createV105ShadowV10Runtime } from '../src/v105-shadow-v10-runtime.js'

const immediate = () => new Promise((resolve) => setImmediate(resolve))

test('shadow process client exposes the independent V10 runtime without enabling frontend access', () => {
  const client = createShadowProcessClient()
  const runtime = client.runtime('v105-v10', { enabled: true })
  assert.equal(runtime.enabled, true)
  assert.deepEqual(runtime.snapshot(), { status: 'remote', enabled: true })
})

test('shadow child wiring carries the V10 switch, writer capability gate, and immutable-settlement noop', () => {
  const clientSource = readFileSync(new URL('../src/shadow-process-client.js', import.meta.url), 'utf8')
  const workerSource = readFileSync(new URL('../src/shadow-process-worker.js', import.meta.url), 'utf8')
  const workSource = readFileSync(new URL('../src/shadow-process-work.js', import.meta.url), 'utf8')
  assert.match(clientSource, /'v105-v10'/)
  assert.match(clientSource, /'V105_SHADOW_V10_ENABLED'/)
  assert.match(clientSource, /diagnostics\.slice\(0, 8\)/)
  assert.match(workerSource, /createV105ShadowV10Runtime/)
  for (const method of ['getV105ShadowV10History', 'issueV105ShadowV10Prediction', 'readV105ShadowV10Issuance', 'settleV105ShadowV10Prediction']) {
    assert.match(workerSource, new RegExp(`has\\('${method}'\\)`))
  }
  assert.match(workSource, /\['v105-v10', 'v105 shadow v10 settlement has no immutable issuance'\]/)
})

test('V10 hydration failure is observable in its snapshot path but cannot block existing shadow readiness', async () => {
  const v9 = { enabled: true, async start() {} }
  const v10 = { enabled: true, async start() { throw new Error('V10 hydration failed') } }
  const runtimes = new Map([['v105-v9', v9], ['v105-v10', v10]])
  prepareShadowRuntimes(runtimes)
  await immediate()
  await immediate()
  const readiness = prepareShadowRuntimes(runtimes)
  assert.deepEqual(readiness, { enabled: 1, prepared: 1, pending: 0, queued: 0, failed: 0, disabled: 0 })
})

test('a stalled V10 capture runs best-effort without delaying the existing shadow batch', async () => {
  let releaseV10
  const v10Gate = new Promise((resolve) => { releaseV10 = resolve })
  const seen = { v9: [], v10: [] }
  const v9 = { enabled: true, async start() {}, async observeTable(table) { seen.v9.push(table.tableId) }, async settleRound() {} }
  const v10 = { enabled: true, async start() {}, async observeTable(table) { seen.v10.push(table.tableId); await v10Gate }, async settleRound() {} }
  const runtimes = new Map([['v105-v9', v9], ['v105-v10', v10]])
  prepareShadowRuntimes(runtimes)
  await immediate()
  await immediate()
  const capture = processShadowCapture(runtimes, { tables: [{ tableId: 'BAG01' }], rounds: [] })
  try {
    const summary = await Promise.race([
      capture,
      new Promise((_, reject) => setTimeout(() => reject(new Error('V10 blocked the existing shadow batch')), 50)),
    ])
    assert.deepEqual(summary, { observed: 1, settled: 0, noops: 0 })
    assert.deepEqual(seen.v9, ['BAG01'])
    assert.deepEqual(seen.v10, ['BAG01'])
  } finally {
    releaseV10()
    await capture.catch(() => {})
  }
})

test('bounded V10 backlog coalesces after capacity without blocking parent ACK and preserves every issuance plus later Final', async (t) => {
  let releaseV10
  let firstWrite = true
  const v10Gate = new Promise((resolve) => { releaseV10 = resolve })
  t.after(() => releaseV10())
  const seen = { v9: [], v10: [], settlements: [] }
  const issued = new Map()
  const writer = {
    configured: true,
    async getV105ShadowV10History() { return [] },
    async issueV105ShadowV10Prediction(candidate) {
      seen.v10.push(candidate.targetRound)
      if (firstWrite) {
        firstWrite = false
        await v10Gate
      }
      const result = {
        ...candidate,
        predictionId: `v10-${candidate.targetTableId}-${candidate.targetRound}`,
        issuedAt: '2026-08-02T01:00:00.000Z',
      }
      issued.set(candidate.targetRound, result)
      return result
    },
    async readV105ShadowV10Issuance(identity) { return issued.get(Number(identity.round)) ?? null },
    async settleV105ShadowV10Prediction(settlement) {
      seen.settlements.push(settlement.predictionId)
      return { predictionId: settlement.predictionId }
    },
  }
  const v9 = {
    enabled: true,
    async start() {},
    async observeTable(table) { seen.v9.push(Number(table.round) + 1) },
    async settleRound() {},
  }
  const v10 = createV105ShadowV10Runtime({ writer, maxQueuedObservationsPerTable: 2 })
  const runtimes = new Map([['v105-v9', v9], ['v105-v10', v10]])
  prepareShadowRuntimes(runtimes)
  await immediate()
  await immediate()

  const captures = [20, 21, 22, 23].map((round) => processShadowCapture(runtimes, {
    tables: [{
      tableId: 'BAG01', shoe: 105, round, bankerCount: 12, playerCount: 8,
      beadPlateRaw: '020102010201', bigRoadRaw: 'B#P#B#P#B#P',
    }],
    rounds: [],
  }))
  const firstThree = await Promise.race([
    Promise.all(captures.slice(0, 3)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('V10 blocked within accepted backlog capacity')), 100)),
  ])
  assert.equal(firstThree.length, 3)
  for (let attempt = 0; attempt < 20 && seen.v9.length < 4; attempt += 1) await immediate()
  assert.deepEqual(seen.v9, [21, 22, 23, 24])
  assert.deepEqual(seen.v10, [21])
  const fourthBeforeRelease = await Promise.race([
    captures[3],
    new Promise((_, reject) => setTimeout(() => reject(new Error('V10 capacity blocked parent acknowledgement')), 100)),
  ])
  assert.equal(fourthBeforeRelease.bestEffortCoalesced, 1)
  assert.equal(fourthBeforeRelease.bestEffortRejected ?? 0, 0)

  releaseV10()
  await Promise.all(captures)
  for (let attempt = 0; attempt < 20 && seen.v10.length < 4; attempt += 1) await immediate()
  assert.deepEqual(seen.v10, [21, 22, 23, 24])

  await processShadowCapture(runtimes, {
    tables: [],
    rounds: [{
      tableId: 'BAG01', shoe: 105, round: 24, sourceAction: '/summary', winner: 'banker',
      rawResult: [1, 9, 2, 10, 0, 0, -1, -1, 3, 9],
    }],
  })
  for (let attempt = 0; attempt < 20 && seen.settlements.length < 1; attempt += 1) await immediate()
  assert.deepEqual(seen.settlements, ['v10-BAG01-24'])
})
