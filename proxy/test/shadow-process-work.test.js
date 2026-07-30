import test from 'node:test'
import assert from 'node:assert/strict'
import { processShadowCapture, prepareShadowRuntimes } from '../src/shadow-process-work.js'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function runtime({ enabled = true, start, observeTable, settleRound } = {}) {
  return {
    enabled,
    start: start ?? (async () => {}),
    observeTable: observeTable ?? (async () => null),
    settleRound: settleRound ?? (async () => null),
  }
}

test('cold hydration is prepared outside capture work and all enabled runtimes hydrate concurrently', async () => {
  const calls = []
  const runtimes = new Map(['v105', 'v105-v7', 'v105-v8', 'v105-v9'].map((key) => [key, runtime({
    async start() {
      calls.push(`start:${key}`)
      await delay(25)
    },
  })]))

  const startedAt = Date.now()
  const result = await prepareShadowRuntimes(runtimes)
  const elapsedMs = Date.now() - startedAt

  assert.equal(result.prepared, 4)
  assert.equal(result.disabled, 0)
  assert.deepEqual(calls.sort(), ['start:v105', 'start:v105-v7', 'start:v105-v8', 'start:v105-v9'])
  assert.equal(elapsedMs < 70, true, `hydration was serialized (${elapsedMs}ms)`)
})

test('capture preserves table-before-round phases while running each table across runtimes concurrently', async () => {
  const calls = []
  const runtimes = new Map(['v105', 'v105-v7', 'v105-v8', 'v105-v9'].map((key) => [key, runtime({
    async observeTable(table) {
      calls.push(`observe:start:${key}:${table.tableId}`)
      await delay(20)
      calls.push(`observe:end:${key}:${table.tableId}`)
    },
    async settleRound(round) {
      calls.push(`settle:${key}:${round.round}`)
    },
  })]))

  const startedAt = Date.now()
  const result = await processShadowCapture(runtimes, {
    tables: [{ tableId: 'BAG01' }],
    rounds: [{ tableId: 'BAG01', round: 9 }],
  })
  const elapsedMs = Date.now() - startedAt

  assert.equal(result.observed, 4)
  assert.equal(result.settled, 4)
  assert.equal(result.noops, 0)
  assert.equal(elapsedMs < 60, true, `runtime fan-out was serialized (${elapsedMs}ms)`)
  assert.equal(calls.findIndex((item) => item.startsWith('settle:')) > calls.findLastIndex((item) => item.startsWith('observe:end:')), true)
})

test('disabled legacy runtimes are skipped and v105 settlement without immutable issuance is a normal no-op', async () => {
  const forbidden = async () => assert.fail('disabled runtime must not run')
  const noIssuance = (message) => async () => { throw new Error(message) }
  const runtimes = new Map([
    ['v103', runtime({ enabled: false, start: forbidden, observeTable: forbidden, settleRound: forbidden })],
    ['v104', runtime({ enabled: false, start: forbidden, observeTable: forbidden, settleRound: forbidden })],
    ['v104-iteration', runtime({ enabled: false, start: forbidden, observeTable: forbidden, settleRound: forbidden })],
    ['v105', runtime({ settleRound: noIssuance('v105 shadow settlement has no immutable issuance') })],
    ['v105-v7', runtime({ settleRound: noIssuance('v105 shadow v7 settlement has no immutable issuance') })],
    ['v105-v8', runtime({ settleRound: noIssuance('v105 shadow v8 settlement has no immutable issuance') })],
    ['v105-v9', runtime({ settleRound: noIssuance('v105 shadow v9 settlement has no immutable issuance') })],
  ])

  assert.deepEqual(await prepareShadowRuntimes(runtimes), { prepared: 4, disabled: 3 })
  const result = await processShadowCapture(runtimes, { tables: [], rounds: [{ tableId: 'BAG01', round: 9 }] })
  assert.deepEqual(result, { observed: 0, settled: 0, noops: 4 })
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
  const runtimes = new Map(['v103', 'v104', 'v104-iteration', 'v105', 'v105-v7', 'v105-v8', 'v105-v9'].map((key, index) => [key, runtime({
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
      assert.equal(error.diagnostics.length, 7)
      assert.deepEqual(error.diagnostics.map((item) => item.runtime), [...runtimes.keys()])
      assert.deepEqual(error.diagnostics.slice(0, 3).map((item) => item.code), ['timeout', 'db_ssl', 'db_connection'])
      assert.doesNotMatch(JSON.stringify(error.diagnostics), /hunter2|top-secret|raw-card-payload|must-not-leak|raw-v105/i)
      return true
    },
  )
})
