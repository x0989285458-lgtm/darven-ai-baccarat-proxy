import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'
import { buildLivePrediction } from '../src/supabase-writer.js'

const table = (round, tableId = 'BAV01') => ({
  tableId, shoe: 1540, round, roundBasis: 'completed',
  sourceUpdatedAt: new Date().toISOString(),
})
const issued = (round, tableId = 'BAV01') => ({
  ...buildLivePrediction(table(round - 1, tableId)),
  predictionId: `round-sync-${tableId}-${round}`,
  issuedAt: new Date().toISOString(),
})
const getTables = async (app) => JSON.parse((await app.inject({ url: '/api/tables' })).body)
const readOnlyApp = (readIssuedPrediction, options = {}) => createApp({
  autoConnect: false, port: 0, captureRoundBasis: 'completed',
  captureOutboxConsumerEnabled: false, livePredictionReadWaitMs: 1000,
  supabaseClient: {
    configured: true, readIssuedPrediction,
    issuePrediction: async () => assert.fail('public reader must never issue'),
  },
  ...options,
})

test('ordinary completed13 to completed14 exposes durable target15 after the 250ms miss cache, not 2s', async () => {
  let clock = Date.now()
  const durable = new Map([[14, issued(14)]])
  const reads = []
  const app = readOnlyApp(async ({ round }) => {
    reads.push(round)
    return durable.get(round) ?? null
  }, { now: () => clock })
  try {
    app.state.setTables([table(13)])
    assert.equal((await getTables(app))[0].prediction.targetRound, 14)
    app.state.setTables([table(14)])
    const missing = await getTables(app)
    assert.equal(missing[0].round, 15)
    assert.equal(missing[0].prediction, null)
    assert.ok(reads.filter((round) => round === 15).length <= 5)
    durable.set(15, issued(15))
    const before = reads.length
    clock += 249
    assert.equal((await getTables(app))[0].prediction, null)
    assert.equal(reads.length, before, 'ordinary misses retain a negative cache')
    clock += 1
    assert.equal((await getTables(app))[0].prediction?.targetRound, 15,
      'new exact durable target must not remain hidden for the error backoff of 2s')
    assert.equal(reads.length, before + 1)
  } finally {
    await app.stop()
  }
})


test('six missing tables coalesce concurrent requests to at most five reads per target per flight', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
  const drive = async (promise) => {
    let settled = false
    promise.finally(() => { settled = true }).catch(() => {})
    for (let i = 0; i < 300 && !settled; i++) {
      for (let j = 0; j < 30; j++) await Promise.resolve()
      if (!settled) t.mock.timers.tick(10)
    }
    assert.equal(settled, true, 'bounded virtual scheduling must complete')
    return promise
  }
  let clock = Date.now()
  const counts = new Map()
  const ids = ['BAV01', 'BAV02', 'BAV03', 'BAV03A', 'BAV05', 'BAV06']
  const app = readOnlyApp(async ({ tableId }) => {
    counts.set(tableId, (counts.get(tableId) ?? 0) + 1)
    return null
  }, { now: () => clock })
  try {
    app.state.setTables(ids.map((id) => table(14, id)))
    const results = await drive(Promise.all(Array.from({ length: 20 }, () => getTables(app))))
    for (const rows of results) {
      assert.equal(rows.length, 6)
      assert.ok(rows.every((row) => row.round === 15 && row.prediction === null))
    }
    for (const id of ids) assert.equal(counts.get(id), 5, id)
    clock += 249
    await drive(Promise.all(Array.from({ length: 20 }, () => getTables(app))))
    for (const id of ids) assert.equal(counts.get(id), 5, 'cached miss must not amplify reads')
    clock += 1
    await drive(Promise.all(Array.from({ length: 20 }, () => getTables(app))))
    for (const id of ids) assert.equal(counts.get(id), 10, 'only one new five-read flight')
  } finally { await app.stop() }
})

for (const [name, invalid] of [
  ['error', () => { throw new Error('read unavailable') }],
  ['undefined', () => undefined],
  ['malformed', () => ({})],
  ['wrong round', () => issued(16)],
  ['wrong shoe', () => ({ ...issued(15), targetShoe: 'other-shoe' })],
  ['wrong table', () => issued(15, 'BAV02')],
  ['wrong strategy', () => ({ ...issued(15), strategyVersion: 'not-v105' })],
  ['not durable', () => ({ ...issued(15), predictionId: null })],
]) {
  test(`${name} stays fail closed with the full 2s error backoff`, async () => {
    let clock = Date.now()
    let reads = 0
    let valid = false
    const app = readOnlyApp(async () => {
      reads += 1
      return valid ? issued(15) : invalid()
    }, { now: () => clock })
    try {
      app.state.setTables([table(14)])
      assert.equal((await getTables(app))[0].prediction, null)
      assert.equal(reads, 1)
      valid = true
      clock += 250
      assert.equal((await getTables(app))[0].prediction, null)
      clock += 1749
      assert.equal((await getTables(app))[0].prediction, null)
      assert.equal(reads, 1)
      clock += 1
      assert.equal((await getTables(app))[0].prediction?.targetRound, 15)
      assert.equal(reads, 2)
    } finally { await app.stop() }
  })
}

async function nextSse(reader, timeoutMs = 4000) {
  let timer
  try {
    return await Promise.race([
      (async () => {
        let text = ''
        while (!text.includes('\n\n')) {
          const { value, done } = await reader.read()
          assert.equal(done, false)
          text += new TextDecoder().decode(value).replaceAll('\r\n', '\n')
        }
        const data = text.split('\n').find((line) => line.startsWith('data:'))
        return JSON.parse(data.slice(5).trim())
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('SSE readiness timeout')), timeoutMs) }),
    ])
  } finally { clearTimeout(timer) }
}

test('late durable target15 reaches SSE without a forced 2s negative-cache wait', async () => {
  let durable = false
  let reads = 0
  const app = readOnlyApp(async () => {
    reads += 1
    return durable ? issued(15) : null
  }, { streamHeartbeatMs: 10000 })
  const controller = new AbortController()
  try {
    app.state.setTables([table(14)])
    await app.start()
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/tables/stream`, { signal: controller.signal })
    const reader = response.body.getReader()
    const initial = await nextSse(reader)
    assert.equal(initial.tables[0].round, 15)
    assert.equal(initial.tables[0].prediction, null)
    assert.ok(reads <= 5)
    durable = true
    const ready = await nextSse(reader, 1800)
    assert.equal(ready.tables[0].prediction?.targetRound, 15)
    assert.ok(reads <= 6, `read count ${reads}`)
  } finally {
    controller.abort()
    await app.stop()
  }
})

test('identity advancement never exposes the previous target and stop does not restart a held read', async () => {
  let release
  let reads = 0
  const held = new Promise((resolve) => { release = resolve })
  const app = readOnlyApp(async ({ round }) => {
    reads += 1
    return round === 15 ? held : issued(round)
  }, { livePredictionReadWaitMs: 50, serviceShutdownDeadlineMs: 50 })
  try {
    app.state.setTables([table(14)])
    const old = await getTables(app)
    assert.equal(old[0].prediction, null)
    app.state.setTables([table(15)])
    assert.equal((await getTables(app))[0].prediction?.targetRound, 16)
    const before = reads
    await app.stop()
    release(issued(15))
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(reads, before, 'shutdown must not restart reads')
  } finally {
    release(null)
    await app.stop()
  }
})


test('scheduled SSE refresh cannot bypass a newer HTTP read error backoff', async () => {
  let durable = false
  let fail = false
  let reads = 0
  const app = readOnlyApp(async () => {
    reads += 1
    if (fail) throw new Error('temporary read error')
    return durable ? issued(15) : null
  }, { streamHeartbeatMs: 10000 })
  const controller = new AbortController()
  try {
    app.state.setTables([table(14)])
    await app.start()
    const reader = (await fetch(`http://127.0.0.1:${app.server.address().port}/api/tables/stream`, { signal: controller.signal })).body.getReader()
    assert.equal((await nextSse(reader)).tables[0].prediction, null)
    await new Promise((resolve) => setTimeout(resolve, 300))
    fail = true
    assert.equal((await getTables(app))[0].prediction, null)
    const afterError = reads
    fail = false
    durable = true
    await new Promise((resolve) => setTimeout(resolve, 1100))
    assert.equal(reads, afterError, 'already scheduled SSE must honor a newer 2s error backoff')
  } finally {
    controller.abort()
    await app.stop()
  }
})


test('an unresolved read deadline is not a confirmed null and retains the 2s backoff', async () => {
  let clock = Date.now()
  let release
  let reads = 0
  const held = new Promise((resolve) => { release = resolve })
  const app = readOnlyApp(async () => {
    reads += 1
    return reads === 1 ? held : issued(15)
  }, { now: () => clock, livePredictionReadWaitMs: 50 })
  try {
    app.state.setTables([table(14)])
    assert.equal((await getTables(app))[0].prediction, null)
    release(null)
    await new Promise((resolve) => setImmediate(resolve))
    clock += 250
    assert.equal((await getTables(app))[0].prediction, null, 'deadline is not a confirmed miss')
    assert.equal(reads, 1)
    clock += 1750
    assert.equal((await getTables(app))[0].prediction?.targetRound, 15)
    assert.equal(reads, 2)
  } finally { release(null); await app.stop() }
})
