import test from 'node:test'
import assert from 'node:assert/strict'
import { processShadowCapture, prepareShadowRuntimes, waitForBestEffortShadowWorkIdle, waitForShadowRuntimesReady } from '../src/shadow-process-work.js'
import { createV105ShadowV9Runtime } from '../src/v105-shadow-v9-runtime.js'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const withTimeout = async (promise, ms, message) => {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

test('bounded idle wait reports a stalled background scheduler instead of hanging CI', async () => {
  await assert.rejects(
    withTimeout(new Promise(() => {}), 20, 'best-effort shadow work stalled'),
    /best-effort shadow work stalled/,
  )
})

function runtime({ enabled = true, start, observeTable, settleRound } = {}) {
  return {
    enabled,
    start: start ?? (async () => {}),
    observeTable: observeTable ?? (async () => null),
    settleRound: settleRound ?? (async () => null),
  }
}

test('wait-ready preparation does not return while hydration is pending', async () => {
  let releaseHydration
  let settled = false
  const runtimes = new Map([['v105-v10', runtime({
    async start() {
      await new Promise((resolve) => { releaseHydration = resolve })
    },
  })]])

  const preparation = waitForShadowRuntimesReady(runtimes, { nonBlockingRuntimeKeys: new Set() })
    .then((value) => {
      settled = true
      return value
    })
  await delay(0)
  assert.equal(settled, false)
  assert.equal(typeof releaseHydration, 'function')

  releaseHydration()
  assert.deepEqual(await preparation, {
    enabled: 1, prepared: 1, pending: 0, queued: 0, failed: 0, disabled: 0,
  })
})

test('cold hydration is scheduled one runtime at a time in map order with queued readiness', async () => {
  const calls = []
  let activeHydrations = 0
  let maxActiveHydrations = 0
  const releases = new Map()
  const runtimes = new Map(['v103', 'v104', 'v105-v9'].map((key) => [key, runtime({
    async start() {
      calls.push(`start:${key}`)
      activeHydrations += 1
      maxActiveHydrations = Math.max(maxActiveHydrations, activeHydrations)
      try {
        await new Promise((resolve) => { releases.set(key, resolve) })
      } finally {
        activeHydrations -= 1
      }
    },
  })]))

  const startedAt = Date.now()
  const result = await prepareShadowRuntimes(runtimes)
  const elapsedMs = Date.now() - startedAt
  await delay(0)

  assert.deepEqual(result, { enabled: 3, prepared: 0, pending: 1, queued: 2, failed: 0, disabled: 0 })
  assert.deepEqual(calls, ['start:v103'])
  assert.equal(maxActiveHydrations, 1)
  assert.equal(elapsedMs < 20, true, `prepare waited for runtime hydration (${elapsedMs}ms)`)

  releases.get('v103')()
  await delay(0)
  assert.deepEqual(calls, ['start:v103', 'start:v104'])
  assert.deepEqual(await prepareShadowRuntimes(runtimes), { enabled: 3, prepared: 1, pending: 1, queued: 1, failed: 0, disabled: 0 })

  releases.get('v104')()
  await delay(0)
  assert.deepEqual(calls, ['start:v103', 'start:v104', 'start:v105-v9'])
  assert.deepEqual(await prepareShadowRuntimes(runtimes), { enabled: 3, prepared: 2, pending: 1, queued: 0, failed: 0, disabled: 0 })

  releases.get('v105-v9')()
  await delay(0)
  assert.deepEqual(await prepareShadowRuntimes(runtimes), { enabled: 3, prepared: 3, pending: 0, queued: 0, failed: 0, disabled: 0 })
  assert.equal(maxActiveHydrations, 1)
})

test('failed hydration retry joins the queue tail and cannot starve first hydration of later runtimes', async () => {
  const calls = []
  let rejectR1
  let releaseR2
  let releaseR3
  let releaseR1Retry
  let r1Attempts = 0
  const runtimes = new Map([
    ['r1', runtime({ async start() {
      r1Attempts += 1
      calls.push(`r1:${r1Attempts}`)
      if (r1Attempts === 1) await new Promise((_, reject) => { rejectR1 = reject })
      else await new Promise((resolve) => { releaseR1Retry = resolve })
    } })],
    ['r2', runtime({ async start() { calls.push('r2:1'); await new Promise((resolve) => { releaseR2 = resolve }) } })],
    ['r3', runtime({ async start() { calls.push('r3:1'); await new Promise((resolve) => { releaseR3 = resolve }) } })],
  ])

  prepareShadowRuntimes(runtimes)
  await delay(0)
  rejectR1(new Error('first hydration failed'))
  await delay(0)
  assert.deepEqual(calls, ['r1:1', 'r2:1'])
  assert.throws(() => prepareShadowRuntimes(runtimes), (error) => error.code === 'SHADOW_RUNTIME_BATCH_FAILED')
  prepareShadowRuntimes(runtimes)

  releaseR2()
  await delay(0)
  assert.deepEqual(calls, ['r1:1', 'r2:1', 'r3:1'])
  releaseR3()
  await delay(0)
  assert.deepEqual(calls, ['r1:1', 'r2:1', 'r3:1', 'r1:2'])
  releaseR1Retry()
  await delay(0)
  assert.equal(r1Attempts, 2)
})

test('an unhydrated runtime blocks every shadow write until the whole exact capture is ready', async () => {
  const calls = []
  let releaseHydration
  let runtimeHydrated = false
  const hydrationGate = new Promise((resolve) => { releaseHydration = resolve })
  const runtimes = new Map([
    ['v103', runtime({
      async start() { calls.push('hydrate:v103') },
      async observeTable() { calls.push('observe:v103') },
      async settleRound() { calls.push('settle:v103') },
    })],
    ['v104', runtime({
      async start() { calls.push('hydrate:v104'); await hydrationGate; runtimeHydrated = true },
      async observeTable() { assert.equal(runtimeHydrated, true, 'unhydrated runtime must not issue'); calls.push('observe:v104') },
      async settleRound() { assert.equal(runtimeHydrated, true, 'unhydrated runtime must not settle'); calls.push('settle:v104') },
    })],
    ['v105-v9', runtime({
      async start() { calls.push('hydrate:v9') },
      async observeTable() { calls.push('observe:v9') },
      async settleRound() { calls.push('settle:v9') },
    })],
  ])

  await prepareShadowRuntimes(runtimes)
  await delay(0)
  await assert.rejects(
    processShadowCapture(runtimes, { tables: [{ tableId: 'BAG01' }], rounds: [{ tableId: 'BAG01', round: 9 }] }),
    (error) => error.code === 'SHADOW_RUNTIME_BATCH_FAILED'
      && error.diagnostics?.some((item) => item.runtime === 'v104' && item.stage === 'hydrate'),
  )
  assert.deepEqual(calls, ['hydrate:v103', 'hydrate:v104'])

  releaseHydration()
  await delay(0)
  assert.deepEqual(calls, ['hydrate:v103', 'hydrate:v104', 'hydrate:v9'])
  assert.deepEqual(
    await processShadowCapture(runtimes, { tables: [{ tableId: 'BAG01' }], rounds: [{ tableId: 'BAG01', round: 10 }] }),
    { observed: 3, settled: 3, noops: 0 },
  )
})

test('failed runtime hydration is retried in the same child readiness state', async () => {
  let attempts = 0
  let active = 0
  let maxActive = 0
  let rejectFirst
  let resolveSecond
  const runtimes = new Map([['v105-v9', runtime({
    async start() {
      attempts += 1
      active += 1
      maxActive = Math.max(maxActive, active)
      try {
        if (attempts === 1) await new Promise((_, reject) => { rejectFirst = reject })
        else await new Promise((resolve) => { resolveSecond = resolve })
      } finally {
        active -= 1
      }
    },
  })]])

  assert.deepEqual(await prepareShadowRuntimes(runtimes), { enabled: 1, prepared: 0, pending: 1, queued: 0, failed: 0, disabled: 0 })
  await delay(0)
  rejectFirst(new Error('v105 shadow v9 history hydration failed'))
  await delay(0)
  assert.throws(
    () => prepareShadowRuntimes(runtimes),
    (error) => error.code === 'SHADOW_RUNTIME_BATCH_FAILED'
      && error.diagnostics?.[0]?.runtime === 'v105-v9'
      && error.diagnostics?.[0]?.stage === 'hydrate',
  )
  assert.deepEqual(await prepareShadowRuntimes(runtimes), { enabled: 1, prepared: 0, pending: 1, queued: 0, failed: 0, disabled: 0 })
  await delay(0)
  assert.equal(attempts, 2)
  assert.equal(maxActive, 1)
  resolveSecond()
  await delay(0)
  assert.deepEqual(await prepareShadowRuntimes(runtimes), { enabled: 1, prepared: 1, pending: 0, queued: 0, failed: 0, disabled: 0 })
  assert.equal(attempts, 2)
})

test('V9 hydration whose loader ignores timeout and abort remains one pending underlying start', async () => {
  let starts = 0
  let activeUnderlying = 0
  let maxActiveUnderlying = 0
  let receivedOptions = null
  const runtime = createV105ShadowV9Runtime({
    requestTimeoutMs: 5,
    writer: {
      configured: true,
      async getV105ShadowV9History(options) {
        receivedOptions = structuredClone(options)
        starts += 1
        activeUnderlying += 1
        maxActiveUnderlying = Math.max(maxActiveUnderlying, activeUnderlying)
        await new Promise(() => {})
      },
    },
  })
  const runtimes = new Map([['v105-v9', runtime]])

  for (let index = 0; index < 3; index += 1) {
    assert.deepEqual(await prepareShadowRuntimes(runtimes), { enabled: 1, prepared: 0, pending: 1, queued: 0, failed: 0, disabled: 0 })
    await delay(10)
    await assert.rejects(
      processShadowCapture(runtimes, { tables: [{ tableId: 'BAG01' }], rounds: [] }),
      (error) => error.code === 'SHADOW_RUNTIME_BATCH_FAILED'
        && error.diagnostics?.[0]?.code === 'not_ready',
    )
  }

  assert.equal(starts, 1)
  assert.equal(activeUnderlying, 1)
  assert.equal(maxActiveUnderlying, 1)
  assert.deepEqual(receivedOptions, { perTableLimit: 60, requestTimeoutMs: 5 })
})

test('capture preserves table-before-round phases while running each table across runtimes concurrently', async () => {
  const calls = []
  let activeObservers = 0
  let maxActiveObservers = 0
  const runtimes = new Map(['v103', 'v104', 'v104-iteration', 'v105-v9', 'v105-v10'].map((key) => [key, runtime({
    async observeTable(table) {
      calls.push(`observe:start:${key}:${table.tableId}`)
      activeObservers += 1
      maxActiveObservers = Math.max(maxActiveObservers, activeObservers)
      await delay(20)
      activeObservers -= 1
      calls.push(`observe:end:${key}:${table.tableId}`)
    },
    async settleRound(round) {
      calls.push(`settle:${key}:${round.round}`)
    },
  })]))

  const result = await processShadowCapture(runtimes, {
    tables: [{ tableId: 'BAG01' }],
    rounds: [{ tableId: 'BAG01', round: 9 }],
  })

  assert.equal(result.observed, 4)
  assert.equal(result.settled, 4)
  assert.equal(result.noops, 0)
  assert.equal(maxActiveObservers >= 4, true, `required runtime fan-out was serialized (maxActive=${maxActiveObservers})`)
  const firstRequiredSettle = calls.findIndex((item) => item.startsWith('settle:') && !item.startsWith('settle:v105-v10:'))
  const lastRequiredObserve = calls.findLastIndex((item) => item.startsWith('observe:end:') && !item.startsWith('observe:end:v105-v10:'))
  assert.equal(firstRequiredSettle > lastRequiredObserve, true)
})

test('ten-table capture stays inside the scaled lease with bounded cross-table concurrency', async () => {
  const tableIds = ['BAG01', 'BAG02', 'BAG03', 'BAG03A', 'BAG05', 'BAG06', 'BAG07', 'BAG08', 'BAG09', 'BAG10']
  const calls = []
  let active = 0
  let maxActive = 0
  const runtimes = new Map(['v103', 'v104', 'v104-iteration', 'v105-v9', 'v105-v10'].map((key) => [key, runtime({
    async observeTable(table) {
      calls.push(`observe:start:${key}:${table.tableId}`)
      active += 1
      maxActive = Math.max(maxActive, active)
      await delay(25)
      active -= 1
      calls.push(`observe:end:${key}:${table.tableId}`)
    },
    async settleRound(round) {
      calls.push(`settle:${key}:${round.tableId}:${round.round}`)
    },
  })]))
  const payload = {
    tables: tableIds.map((tableId) => ({ tableId, shoe: 105, round: 20 })),
    rounds: [
      { tableId: 'BAG01', shoe: 105, round: 19 },
      { tableId: 'BAG01', shoe: 105, round: 20 },
    ],
  }

  const startedAt = Date.now()
  const result = await processShadowCapture(runtimes, payload)
  const elapsedMs = Date.now() - startedAt

  assert.deepEqual(result, { observed: 40, settled: 8, noops: 0 })
  await withTimeout(
    waitForBestEffortShadowWorkIdle(runtimes),
    1000,
    'best-effort shadow work did not become idle within 1000ms',
  )
  assert.equal(calls.filter((item) => item.startsWith('observe:start:')).length, 50)
  assert.equal(maxActive >= 4, true, `required identities did not run concurrently (maxActive=${maxActive})`)
  assert.equal(maxActive <= 9, true, `runtime work exceeded the bounded concurrency budget (maxActive=${maxActive})`)
  assert.equal(elapsedMs < 350, true, `ten-table capture exceeded the scaled lease (${elapsedMs}ms)`)
  const firstRequiredSettle = calls.findIndex((item) => item.startsWith('settle:') && !item.startsWith('settle:v105-v10:'))
  const lastRequiredObserve = calls.findLastIndex((item) => item.startsWith('observe:end:') && !item.startsWith('observe:end:v105-v10:'))
  assert.equal(firstRequiredSettle > lastRequiredObserve, true)
  assert.deepEqual(
    calls.filter((item) => item.startsWith('settle:v105-v9:BAG01')).map((item) => Number(item.split(':').at(-1))),
    [19, 20],
  )
})

test('disabled legacy runtimes are skipped and V9/V10 missing issuances are normal no-ops', async () => {
  const forbidden = async () => assert.fail('disabled runtime must not run')
  const noIssuance = (message) => async () => { throw new Error(message) }
  const runtimes = new Map([
    ['v103', runtime({ enabled: false, start: forbidden, observeTable: forbidden, settleRound: forbidden })],
    ['v104', runtime({ enabled: false, start: forbidden, observeTable: forbidden, settleRound: forbidden })],
    ['v104-iteration', runtime({ enabled: false, start: forbidden, observeTable: forbidden, settleRound: forbidden })],
    ['v105-v9', runtime({ settleRound: noIssuance('v105 shadow v9 settlement has no immutable issuance') })],
    ['v105-v10', runtime({ settleRound: noIssuance('v105 shadow v10 settlement has no immutable issuance') })],
  ])

  await prepareShadowRuntimes(runtimes)
  await delay(0)
  assert.deepEqual(await prepareShadowRuntimes(runtimes), { enabled: 1, prepared: 1, pending: 0, queued: 0, failed: 0, disabled: 3 })
  const result = await processShadowCapture(runtimes, { tables: [], rounds: [{ tableId: 'BAG01', round: 9 }] })
  assert.deepEqual(result, { observed: 0, settled: 0, noops: 1 })
})

test('a compound database failure containing the no-issuance phrase is never accepted as a no-op', async () => {
  const runtimes = new Map([
    ['v105-v9', runtime({
      async settleRound() {
        throw new Error('database RPC failed after v105 shadow v9 settlement has no immutable issuance')
      },
    })],
  ])

  await assert.rejects(
    processShadowCapture(runtimes, { tables: [], rounds: [{ tableId: 'BAG01', round: 9 }] }),
    (error) => error.code === 'SHADOW_RUNTIME_BATCH_FAILED'
      && error.diagnostics?.[0]?.runtime === 'v105-v9'
      && error.diagnostics?.[0]?.code === 'db_request',
  )
})

test('a batch reports every runtime failure with safe codes and never includes errors or raw payloads', async () => {
  const runtimes = new Map(['v103', 'v104', 'v104-iteration', 'v105-v9', 'v105-v10'].map((key, index) => [key, runtime({
    async observeTable() {
      if (index === 0) throw new Error('request timed out password=hunter2')
      if (index === 1) throw new Error('self signed certificate token=top-secret')
      if (index === 2) throw new Error('connect ECONNREFUSED raw-card-payload')
      throw new Error(`unexpected runtime failure raw-${key}`)
    },
  })]))

  await assert.rejects(
    processShadowCapture(runtimes, { tables: [{ tableId: 'BAG01', rawResult: ['must-not-leak'] }], rounds: [] }),
    (error) => {
      assert.equal(error.code, 'SHADOW_RUNTIME_BATCH_FAILED')
      assert.equal(error.diagnostics.length, 4)
      assert.deepEqual(error.diagnostics.map((item) => item.runtime), [...runtimes.keys()].filter((key) => key !== 'v105-v10'))
      assert.deepEqual(error.diagnostics.slice(0, 3).map((item) => item.code), ['timeout', 'db_ssl', 'db_connection'])
      assert.doesNotMatch(JSON.stringify(error.diagnostics), /hunter2|top-secret|raw-card-payload|must-not-leak|raw-v105/i)
      return true
    },
  )
})
