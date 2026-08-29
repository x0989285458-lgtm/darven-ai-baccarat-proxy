import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'
import { buildLivePrediction } from '../src/supabase-writer.js'

const issuedAt = '2026-07-17T01:00:00.000Z'

test('tables expose only a complete backend prediction for the exact screen round', async () => {
  const tableState = { tableId: 'BAG01', shoe: 88, round: 20, sourceUpdatedAt: issuedAt }
  const exact = {
    ...buildLivePrediction({ ...tableState, round: 19 }),
    predictionId: 'pid-screen-round-20',
    issuedAt,
  }
  const app = createApp({
    autoConnect: false,
    supabaseClient: {
      configured: true,
      issuePrediction: async (candidate) => ({ ...candidate, predictionId: `pid-${candidate.targetRound}`, issuedAt }),
      readIssuedPrediction: async () => exact,
    },
  })
  app.state.setTables([tableState])
  const [table] = JSON.parse((await app.inject({ url: '/api/tables' })).body)
  assert.equal(table.prediction.source, 'backend')
  assert.equal(table.prediction.targetRound, 20)
  assert.equal(table.prediction.predictionId, 'pid-screen-round-20')
  assert.equal(table.prediction.issuedAt, issuedAt)
  assert.deepEqual(Object.keys(table.prediction.sideActions).sort(), ['bankerDragon', 'bankerPair', 'playerDragon', 'playerPair', 'superSix', 'tie'])
})

test('first tables response waits a bounded interval for all exact durable predictions', async () => {
  const tableIds = ['BAG01', 'BAG02', 'BAG03', 'BAG03A', 'BAG05', 'BAG06', 'BAG07', 'BAG08', 'BAG09', 'BAG10']
  const tables = tableIds.map((tableId) => ({ tableId, shoe: 96, round: 20, sourceUpdatedAt: issuedAt }))
  const exactByTable = new Map(tables.map((table) => [table.tableId, {
    ...buildLivePrediction({ ...table, round: 19 }),
    predictionId: `pid-${table.tableId}-20`,
    issuedAt,
  }]))
  const app = createApp({
    autoConnect: false,
    captureOutboxConsumerEnabled: false,
    supabaseClient: {
      configured: true,
      issuePrediction: async () => { assert.fail('read-only endpoint must not issue predictions') },
      async readIssuedPrediction({ tableId }) {
        await new Promise((resolve) => setTimeout(resolve, 75))
        return exactByTable.get(tableId)
      },
    },
  })
  app.state.setTables(tables)

  const response = await app.inject({ url: '/api/tables' })
  const payload = JSON.parse(response.body)

  assert.equal(response.statusCode, 200)
  assert.equal(payload.length, 10)
  assert.equal(payload.filter((table) => table.prediction?.predictionId).length, 10)
})

test('first tables response retries missing exact predictions until bounded issuance becomes durable', async () => {
  const tableIds = ['BAG01', 'BAG02', 'BAG03', 'BAG03A', 'BAG05', 'BAG06', 'BAG07', 'BAG08', 'BAG09', 'BAG10']
  const tables = tableIds.map((tableId) => ({ tableId, shoe: 97, round: 21, sourceUpdatedAt: issuedAt }))
  const exactByTable = new Map(tables.map((table) => [table.tableId, {
    ...buildLivePrediction({ ...table, round: 20 }),
    predictionId: `pid-${table.tableId}-21`,
    issuedAt,
  }]))
  const readCalls = new Map()
  const durableAt = Date.now() + 75
  const app = createApp({
    autoConnect: false,
    captureOutboxConsumerEnabled: false,
    livePredictionReadWaitMs: 1000,
    supabaseClient: {
      configured: true,
      issuePrediction: async () => { assert.fail('read-only endpoint must not issue predictions') },
      async readIssuedPrediction({ tableId }) {
        readCalls.set(tableId, (readCalls.get(tableId) ?? 0) + 1)
        return Date.now() >= durableAt ? exactByTable.get(tableId) : null
      },
    },
  })
  app.state.setTables(tables)

  const startedAt = Date.now()
  const response = await app.inject({ url: '/api/tables' })
  const payload = JSON.parse(response.body)

  assert.equal(response.statusCode, 200)
  assert.equal(payload.filter((table) => table.prediction?.predictionId).length, 10)
  assert.ok(Date.now() - startedAt < 1000)
  assert.ok([...readCalls.values()].every((calls) => calls >= 2))
})

test('concurrent tables responses share one bounded live prediction polling flight per identity', async () => {
  const table = { tableId: 'BAG01', shoe: 98, round: 22, sourceUpdatedAt: issuedAt }
  const exact = {
    ...buildLivePrediction({ ...table, round: 21 }),
    predictionId: 'pid-BAG01-22',
    issuedAt,
  }
  let readCalls = 0
  const durableAt = Date.now() + 45
  const app = createApp({
    autoConnect: false,
    captureOutboxConsumerEnabled: false,
    livePredictionReadWaitMs: 1000,
    supabaseClient: {
      configured: true,
      issuePrediction: async () => { assert.fail('read-only endpoint must not issue predictions') },
      async readIssuedPrediction() {
        readCalls += 1
        return Date.now() >= durableAt ? exact : null
      },
    },
  })
  app.state.setTables([table])

  const first = app.inject({ url: '/api/tables' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const second = app.inject({ url: '/api/tables' })
  const responses = await Promise.all([first, second])

  assert.ok(responses.every((response) => JSON.parse(response.body)[0].prediction?.predictionId === exact.predictionId))
  assert.equal(readCalls, 2)
})

test('read-only tables endpoint does not initiate durable next issuance when formal consumer is disabled', async () => {
  let issueCalls = 0
  const tableState = { tableId: 'BAG01', shoe: 88, round: 20, sourceUpdatedAt: issuedAt }
  const exact = {
    ...buildLivePrediction({ ...tableState, round: 19 }),
    predictionId: 'pid-screen-round-20',
    issuedAt,
  }
  const app = createApp({
    autoConnect: false,
    captureOutboxConsumerEnabled: false,
    supabaseClient: {
      configured: true,
      issuePrediction: async (candidate) => {
        issueCalls += 1
        return { ...candidate, predictionId: `pid-${candidate.targetRound}`, issuedAt }
      },
      readIssuedPrediction: async () => exact,
    },
  })
  app.state.setTables([tableState])

  const response = await app.inject({ url: '/api/tables' })
  await new Promise((resolve) => setImmediate(resolve))
  const [table] = JSON.parse(response.body)

  assert.equal(response.statusCode, 200)
  assert.equal(table.prediction.predictionId, 'pid-screen-round-20')
  assert.equal(issueCalls, 0)
})

test('tables return current live data without waiting for a hung durable prediction issuance', async () => {
  let issuanceStarted = false
  const never = new Promise(() => {})
  const app = createApp({
    autoConnect: false,
    livePredictionReadWaitMs: 50,
    supabaseClient: {
      configured: true,
      issuePrediction: async () => {
        issuanceStarted = true
        return never
      },
      readIssuedPrediction: async () => never,
    },
  })
  app.state.setTables([{ tableId: 'BAG01', shoe: 88, round: 20, sourceUpdatedAt: issuedAt }])
  await new Promise((resolve) => setImmediate(resolve))

  const response = await Promise.race([
    app.inject({ url: '/api/tables' }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('tables read waited for issuance')), 1000)),
  ])
  const [table] = JSON.parse(response.body)
  assert.equal(issuanceStarted, true)
  assert.equal(table.tableId, 'BAG01')
  assert.equal(table.prediction, null)
})

test('hung durable prediction read stays single-flight and recovers without accumulating orphan reads', async () => {
  const tableState = { tableId: 'BAG01', shoe: 99, round: 23, sourceUpdatedAt: issuedAt }
  const exact = {
    ...buildLivePrediction({ ...tableState, round: 22 }),
    predictionId: 'pid-BAG01-23',
    issuedAt,
  }
  let resolveStaleRead
  const staleRead = new Promise((resolve) => { resolveStaleRead = resolve })
  let readCalls = 0
  let currentNow = Date.parse(issuedAt)
  const app = createApp({
    autoConnect: false,
    livePredictionReadWaitMs: 50,
    now: () => currentNow,
    supabaseClient: {
      configured: true,
      issuePrediction: async () => { assert.fail('read-only endpoint must not issue predictions') },
      readIssuedPrediction: async () => {
        readCalls += 1
        return readCalls === 1 ? staleRead : exact
      },
    },
  })
  app.state.setTables([tableState])

  const first = JSON.parse((await app.inject({ url: '/api/tables' })).body)
  assert.equal(first[0].prediction, null)
  currentNow += 2001
  const second = JSON.parse((await app.inject({ url: '/api/tables' })).body)

  assert.equal(second[0].prediction, null)
  assert.equal(readCalls, 1)
  resolveStaleRead(exact)
  await new Promise((resolve) => setImmediate(resolve))
  const afterHungReadSettles = JSON.parse((await app.inject({ url: '/api/tables' })).body)
  assert.equal(afterHungReadSettles[0].prediction?.predictionId, exact.predictionId)
  assert.equal(readCalls, 1)
})

test('late durable read cannot overwrite a newer in-memory issuance for the same identity', async () => {
  const tableState = { tableId: 'BAG01', shoe: 99, round: 23, sourceUpdatedAt: new Date().toISOString() }
  const newer = {
    ...buildLivePrediction({ ...tableState, round: 22 }),
    predictionId: 'newer-pid-BAG01-23',
    issuedAt: new Date().toISOString(),
    createdAtMs: Date.now(),
  }
  const stale = { ...newer, predictionId: 'stale-pid-BAG01-23' }
  const pendingPredictionStore = new Map()
  let resolveStaleRead
  const staleRead = new Promise((resolve) => { resolveStaleRead = resolve })
  const app = createApp({
    autoConnect: false,
    captureOutboxConsumerEnabled: false,
    livePredictionReadWaitMs: 50,
    pendingPredictionStore,
    supabaseClient: {
      configured: true,
      issuePrediction: async () => { assert.fail('read-only endpoint must not issue predictions') },
      readIssuedPrediction: async () => staleRead,
    },
  })
  app.state.setTables([tableState])

  const first = JSON.parse((await app.inject({ url: '/api/tables' })).body)
  assert.equal(first[0].prediction, null)
  pendingPredictionStore.set('BAG01:99:23', newer)
  resolveStaleRead(stale)
  await new Promise((resolve) => setImmediate(resolve))
  const final = JSON.parse((await app.inject({ url: '/api/tables' })).body)
  assert.equal(final[0].prediction?.predictionId, newer.predictionId)
})

test('ten-table cold live read uses bounded exponential polling instead of database hammering', async () => {
  let readCalls = 0
  const app = createApp({
    autoConnect: false,
    captureOutboxConsumerEnabled: false,
    supabaseClient: {
      configured: true,
      issuePrediction: async () => { assert.fail('read-only endpoint must not issue predictions') },
      readIssuedPrediction: async () => { readCalls += 1; return null },
    },
  })
  app.state.setTables(Array.from({ length: 10 }, (_, index) => ({
    tableId: `BAG${String(index + 1).padStart(2, '0')}`,
    shoe: 100 + index,
    round: 20,
    sourceUpdatedAt: new Date().toISOString(),
  })))

  const response = await app.inject({ url: '/api/tables' })
  assert.equal(response.statusCode, 200)
  assert.ok(readCalls >= 20)
  assert.ok(readCalls <= 50)
})

test('live prediction read wait rejects empty, fractional, or unbounded configuration', () => {
  for (const livePredictionReadWaitMs of ['', 0, 24, 5001, 1.5, 'not-a-number']) {
    assert.throws(
      () => createApp({ autoConnect: false, livePredictionReadWaitMs }),
      /live prediction read wait must be a safe integer from 25 through 5000 milliseconds/,
    )
  }
})

test('missing durable screen prediction is negatively cached to avoid repeated database reads', async () => {
  let readCalls = 0
  const app = createApp({
    autoConnect: false,
    supabaseClient: {
      configured: true,
      issuePrediction: async (candidate) => ({ ...candidate, predictionId: 'future', issuedAt }),
      readIssuedPrediction: async () => { readCalls += 1; return null },
    },
  })
  app.state.setTables([{ tableId: 'BAG01', shoe: 89, round: 20, sourceUpdatedAt: issuedAt }])

  assert.equal((await app.inject({ url: '/api/tables' })).statusCode, 200)
  const readsAfterFirstResponse = readCalls
  assert.ok(readsAfterFirstResponse > 1)
  assert.equal((await app.inject({ url: '/api/tables' })).statusCode, 200)
  assert.equal(readCalls, readsAfterFirstResponse)
})
