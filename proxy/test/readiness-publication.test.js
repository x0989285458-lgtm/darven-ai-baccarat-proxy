import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'
import { buildLivePrediction } from '../src/supabase-writer.js'
import { PRODUCTION_TABLE_IDS } from '../src/cloud-capture.js'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// B1: a durable-reader fixture is not a live source. Publication must validate
// source authority even with production:false and an exact fresh durable row.
for (const source of ['fresh', 'stale', 'missing', 'invalid', 'future', 'build']) {
  test(`B1 HTTP/SSE exact durable row requires current source: ${source}`, async (t) => {
    let f, table
    f = await fixture(t, async () => issued(table, f.clock))
    table = screen(f.clock)
    if (source === 'stale') table.sourceUpdatedAt = new Date(f.clock() - 120001).toISOString()
    if (source === 'missing') delete table.sourceUpdatedAt
    if (source === 'invalid') table.sourceUpdatedAt = 'not-a-date'
    if (source === 'future') table.sourceUpdatedAt = new Date(f.clock() + 1).toISOString()
    if (source === 'build') table.buildVersion = 'wrong-build'
    f.app.state.setTables([table])
    const [http] = await f.get()
    const next = await stream(t, f)
    const event = await next((e) => e.tables?.length === 1)
    assert.deepEqual([http, event.tables[0]].map(result => result.predictionReadiness.state),
      [source, source].map(value => value === 'fresh' ? 'ready' : 'unavailable'), 'GET and SSE share source authority')
    for (const result of [http, event.tables[0]]) {
      assert.equal(result.predictionReadiness.state, source === 'fresh' ? 'ready' : 'unavailable')
      if (source === 'fresh') assert.equal(result.prediction.predictionId, issued(table, f.clock).predictionId)
      else assert.equal(result.prediction, null)
    }
  })
}

test('B1 source expires during exact reader await and remains unavailable on SSE', async (t) => {
  let f, release, entered
  const started = new Promise((resolve) => { entered = resolve })
  const held = new Promise((resolve) => { release = resolve })
  f = await fixture(t, async () => { entered(); return held }, { livePredictionReadWaitMs: 200 })
  const table = screen(f.clock)
  f.app.state.setTables([table])
  const request = f.get()
  await started
  f.advance(120001)
  release(issued(table, f.clock))
  const [result] = await request
  assert.equal(result.predictionReadiness.state, 'unavailable')
  assert.equal(result.prediction, null)
  const next = await stream(t, f)
  const event = await next((e) => Array.isArray(e.tables))
  // The source can be omitted entirely once the local receipt also expires.
  assert.ok(event.tables.every((table) => table.predictionReadiness.state === 'unavailable' && table.prediction === null))
})


for (const change of ['expiry', 'same-identity-source', 'expired-new-identity']) {
  test(`B1 GET revalidates ready sibling after peer await: ${change}`, async (t) => {
    let f, entered, release
    const started = new Promise(resolve => { entered = resolve })
    const held = new Promise(resolve => { release = resolve })
    f = await fixture(t, async ({tableId}) => {
      if (tableId === PRODUCTION_TABLE_IDS[1]) { entered(); return held }
      return issued(screen(f.clock), f.clock)
    }, {livePredictionReadWaitMs: 200})
    const first = screen(f.clock), second = screen(f.clock, {tableId:PRODUCTION_TABLE_IDS[1]})
    f.app.state.setTables([first, second])
    const request = f.get()
    await started
    await delay(10)
    if (change === 'expiry') f.advance(120001)
    else if (change === 'expired-new-identity') {
      f.advance(120001)
      f.app.state.setTables([{...first,round:21},second])
    } else f.app.state.setTables([{...first,sourceUpdatedAt:'invalid'},second])
    release(null)
    const result = await request
    assert.equal(result[0].prediction, null)
    assert.equal(result[0].predictionReadiness.state, 'unavailable')
    if (change === 'expired-new-identity') assert.equal(result[0].round, 21)
  })
}

test('B1 truly non-durable local mode retains source-less legacy prediction', async (t) => {
  const f = await fixture(t, null, {supabaseClient:{configured:false}})
  const table = screen(f.clock); delete table.sourceUpdatedAt
  f.app.state.setTables([table])
  assert.ok((await f.get())[0].prediction)
})

function screen(clock, extra = {}) {
  return { tableId: PRODUCTION_TABLE_IDS[0], shoe: 88, round: 20, sourceUpdatedAt: new Date(clock()).toISOString(), ...extra }
}
function issued(table, clock) {
  return { ...buildLivePrediction({ ...table, round: table.round - 1 }), predictionId: `pid-${table.tableId}-${table.shoe}-${table.round}`, issuedAt: new Date(clock()).toISOString(), createdAtMs: clock() }
}
async function fixture(t, read, options = {}) {
  let time = Date.now()
  const clock = () => time
  const app = createApp({ autoConnect: false, production: false, requireVerifiedStrategy: false, memberAuthRequired: false,
    captureOutboxConsumerEnabled: false, livePredictionReadWaitMs: 30, streamHeartbeatMs: 20,
    now: clock, supabaseClient: { configured: true, issuePrediction: () => assert.fail('read-only must not issue'), readIssuedPrediction: read }, ...options })
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${app.server.address().port}`
  t.after(async () => { app.server.closeAllConnections(); await app.stop() })
  return { app, clock, advance: (ms) => { time += ms }, get: async () => (await fetch(`${url}/api/tables`)).json(), url }
}

test('HTTP successful missing publishes finite identity-bound pending, then exact ready atomically', async (t) => {
  let result = null
  const f = await fixture(t, async () => result)
  const table = screen(f.clock)
  f.app.state.setTables([table])
  const [pending] = await f.get()
  assert.equal(pending.prediction, null)
  assert.deepEqual(pending.predictionReadiness, { state: 'pending', tableId: table.tableId, shoe: table.shoe, round: 20, observedAt: f.clock(), expiresAt: f.clock() + 10000 })
  result = issued(table, f.clock)
  f.advance(251)
  const [ready] = await f.get()
  assert.equal(ready.predictionReadiness.state, 'ready')
  assert.equal(ready.predictionReadiness.round, ready.round)
  assert.equal(ready.prediction.predictionId, result.predictionId)
})

for (const failure of ['error', 'timeout', 'malformed', 'version', 'identity', 'expired']) {
  test(`HTTP ${failure} after missing is unavailable, never pending or actionable`, async (t) => {
    let fail = false
    let table
    let f
    f = await fixture(t, async () => {
      if (!fail) return null
      if (failure === 'error') throw new Error('offline DB')
      if (failure === 'timeout') return new Promise(() => {})
      if (failure === 'malformed') return {}
      const value = issued(table, f.clock)
      if (failure === 'version') value.strategyVersion = 'wrong'
      if (failure === 'identity') value.targetRound += 1
      if (failure === 'expired') value.createdAtMs = f.clock() - 120001
      return value
    })
    table = screen(f.clock)
    f.app.state.setTables([table])
    assert.equal((await f.get())[0].predictionReadiness.state, 'pending')
    f.advance(251)
    fail = true
    const [result] = await f.get()
    assert.equal(result.prediction, null)
    assert.equal(result.predictionReadiness.state, 'unavailable')
    const [backoff] = await f.get()
    assert.equal(backoff.predictionReadiness.state, 'unavailable')
  })
}


test('HTTP late old-identity await publishes latest screen, never stale ready', async (t) => {
  let release, entered
  const started = new Promise((resolve) => { entered = resolve })
  const held = new Promise((resolve) => { release = resolve })
  const f = await fixture(t, async ({ round }) => { if (round === 20) { entered(); return held } return null }, { livePredictionReadWaitMs: 200 })
  const old = screen(f.clock)
  f.app.state.setTables([old])
  const request = f.get()
  await started
  f.app.state.setTables([screen(f.clock, { shoe: 89, round: 1 })])
  release(issued(old, f.clock))
  const [result] = await request
  assert.equal(result.shoe, 89)
  assert.equal(result.round, 1)
  assert.equal(result.prediction, null)
  assert.notEqual(result.predictionReadiness.state, 'ready')
})


async function stream(t, f) {
  const controller = new AbortController()
  const events = []
  const response = await fetch(`${f.url}/api/tables/stream`, { signal: controller.signal })
  const reader = response.body.getReader()
  t.after(() => { controller.abort(); void reader.cancel().catch(() => {}) })
  void (async () => {
    let text = ''
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) return
        text += new TextDecoder().decode(value)
        let end
        while ((end = text.indexOf('\n\n')) >= 0) {
          const block = text.slice(0, end); text = text.slice(end + 2)
          const data = block.split('\n').find((line) => line.startsWith('data: '))
          if (data) events.push({ event: block.split('\n')[0].slice(7), ...JSON.parse(data.slice(6)) })
        }
      }
    } catch {}
  })()
  const next = async (predicate) => {
    const end = Date.now() + 2000
    while (Date.now() < end) {
      const event = events.find(predicate)
      if (event) return event
      await delay(10)
    }
    assert.fail('SSE expected event did not arrive')
  }
  next.events = events
  return next
}

test('SSE initial pending expires on heartbeat without fresh payload or sliding GET replay', async (t) => {
  const f = await fixture(t, async () => null)
  const table = screen(f.clock)
  f.app.state.setTables([table])
  const next = await stream(t, f)
  const first = await next((e) => e.tables?.[0].predictionReadiness?.state === 'pending')
  const original = first.tables[0].predictionReadiness
  f.advance(5000)
  f.app.state.setTables([screen(f.clock)])
  assert.deepEqual((await f.get())[0].predictionReadiness, original)
  f.advance(5000)
  const expired = await next((e) => e.tables?.[0].predictionReadiness?.state === 'unavailable')
  assert.equal(expired.tables[0].prediction, null)
  assert.equal((await f.get())[0].predictionReadiness.state, 'unavailable')
})


for (const invalid of ['stale', 'version', 'inactive', 'reader', 'basis']) {
  test(`HTTP ${invalid} screen cannot claim pending`, async (t) => {
    const options = invalid === 'reader' ? { supabaseClient: { configured: true, issuePrediction: () => assert.fail() } }
      : invalid === 'basis' ? { captureRoundBasis: 'completed' } : {}
    const f = await fixture(t, async () => null, options)
    const table = screen(f.clock, invalid === 'stale' ? { sourceUpdatedAt: new Date(f.clock() - 120001).toISOString() }
      : invalid === 'version' ? { buildVersion: 'invalid-version' }
      : invalid === 'inactive' ? { tableId: 'BAG01' } : {})
    f.app.state.setTables([table])
    const [result] = await f.get()
    assert.equal(result.prediction, null)
    assert.equal(result.predictionReadiness.state, 'unavailable')
  })
}

test('SSE recovery publishes ready independently; other-table force retains missing null', async (t) => {
  let firstReady = false
  let f
  f = await fixture(t, async ({ tableId }) => tableId === PRODUCTION_TABLE_IDS[0] && firstReady ? issued(screen(f.clock), f.clock) : null)
  f.app.state.setTables([screen(f.clock), screen(f.clock, { tableId: PRODUCTION_TABLE_IDS[1] })])
  const next = await stream(t, f)
  await next((e) => e.tables?.length === 2 && e.tables.every((x) => x.predictionReadiness?.state === 'pending'))
  firstReady = true
  f.advance(300)
  const recovered = await next((e) => e.tables?.[0].predictionReadiness?.state === 'ready')
  assert.equal(recovered.tables[0].prediction.targetRound, recovered.tables[0].round)
  assert.equal(recovered.tables[1].prediction, null)
  assert.equal(recovered.tables[1].predictionReadiness.state, 'pending')
})

test('completed source publishes visible round once', async (t) => {
  const f = await fixture(t, async () => null, { captureRoundBasis: 'completed' })
  f.app.state.setTables([screen(f.clock, { roundBasis: 'completed' })])
  const [result] = await f.get()
  assert.equal(result.round, 21)
  assert.equal(result.predictionReadiness.round, 21)
  assert.equal(result.predictionReadiness.state, 'pending')
})


test('expired durable row cannot become pending after a later successful miss', async (t) => {
  let f, mode = 'expired'
  f = await fixture(t, async () => mode === 'expired' ? { ...issued(screen(f.clock), f.clock), createdAtMs: f.clock() - 120001 } : null)
  f.app.state.setTables([screen(f.clock)])
  assert.equal((await f.get())[0].predictionReadiness.state, 'unavailable')
  f.advance(2001)
  mode = 'missing'
  assert.equal((await f.get())[0].predictionReadiness.state, 'unavailable')
})

test('publication rechecks identity of an already-resolved table while its peer awaits', async (t) => {
  let release, entered, f
  const started = new Promise((resolve) => { entered = resolve })
  const held = new Promise((resolve) => { release = resolve })
  f = await fixture(t, async ({ tableId }) => {
    if (tableId === PRODUCTION_TABLE_IDS[1]) { entered(); return held }
    return issued(screen(f.clock), f.clock)
  }, { livePredictionReadWaitMs: 200 })
  const second = screen(f.clock, { tableId: PRODUCTION_TABLE_IDS[1] })
  f.app.state.setTables([screen(f.clock), second])
  const request = f.get()
  await started
  await delay(10)
  f.app.state.setTables([screen(f.clock, { round: 21 }), second])
  release(null)
  const result = await request
  assert.equal(result[0].round, 21)
  assert.equal(result[0].prediction, null)
})


test('cloud fallback is not overwritten by an unchanged stale local screen', async (t) => {
  let f
  f = await fixture(t, async () => null, { supabaseClient: {
    configured: true, issuePrediction: () => assert.fail(), readIssuedPrediction: async () => null,
    getLatestCloudTableSnapshot: async () => ({ snapshot_at: new Date().toISOString(), tables: [screen(f.clock, { shoe: 89, round: 1 })] }),
  } })
  f.app.state.setTables([screen(f.clock)])
  f.advance(120001)
  const [result] = await f.get()
  assert.equal(result.shoe, 89)
  assert.equal(result.round, 1)
})


for (const phase of ['initial', 'screen-change']) {
  test(`SSE ${phase}: ready A arrives while B read is still held`, async (t) => {
    let f, release, heldEntered, holding = phase === 'initial', readsB = 0
    const entered = new Promise((resolve) => { heldEntered = resolve })
    const held = new Promise((resolve) => { release = resolve })
    t.after(() => release(null))
    f = await fixture(t, async ({ tableId, round }) => {
      if (tableId === PRODUCTION_TABLE_IDS[1] && holding) { readsB++; heldEntered(); return held }
      return issued(screen(f.clock, { tableId, round }), f.clock)
    }, { livePredictionReadWaitMs: 1000, streamHeartbeatMs: 1000 })
    f.app.state.setTables([screen(f.clock), screen(f.clock, { tableId: PRODUCTION_TABLE_IDS[1] })])
    const deliveryStarted = Date.now()
    const next = await stream(t, f)
    if (phase === 'screen-change') {
      await next((e) => e.tables?.every((x) => x.predictionReadiness?.state === 'ready'))
      holding = true
      f.app.state.setTables([screen(f.clock, { round: 21 }), screen(f.clock, { tableId: PRODUCTION_TABLE_IDS[1], round: 21 })])
    }
    await entered
    const round = phase === 'initial' ? 20 : 21
    const result = await Promise.race([
      next((e) => e.tables?.[0]?.round === round && e.tables[0].predictionReadiness?.state === 'ready'),
      delay(250).then(() => null),
    ])
    assert.ok(result, 'A must reach real SSE before B resolves or its 1000ms read deadline')
    if (phase === 'initial') assert.ok(Date.now() - deliveryStarted < 250, 'initial headers/payload cannot wait for held B deadline')
    assert.equal(readsB, 1, 'held exact-key read stays singleflight')
    assert.equal(result.tables.length, 2, 'existing full snapshot protocol')
    assert.equal(result.tables[1].prediction, null)
    assert.equal(result.tables[1].predictionReadiness.state, 'unavailable', 'held is not confirmed missing')
    release(null)
  })
}


test('readiness retains only current identity per production table and clears on stop', async (t) => {
  const NativeMap = globalThis.Map
  const maps = []
  let pendingFixture
  try {
    globalThis.Map = class extends NativeMap { constructor(...args) { super(...args); maps.push(this) } }
    pendingFixture = fixture(t, async () => null)
  } finally { globalThis.Map = NativeMap }
  const f = await pendingFixture
  f.app.state.setTables([screen(f.clock)])
  await f.get()
  const readiness = maps.find((map) => [...map.entries()].some(([key, value]) =>
    String(key).includes(PRODUCTION_TABLE_IDS[0]) && (value === f.clock() || value?.observedAt === f.clock())))
  assert.ok(readiness, 'observe actual app readiness map, not a helper')
  for (let round = 21; round <= 32; round++) {
    f.advance(300)
    f.app.state.setTables([screen(f.clock, { round })])
    assert.equal((await f.get())[0].predictionReadiness.state, 'pending')
  }
  assert.equal(readiness.size, 1, 'retired identity windows must not accumulate')
  f.app.server.closeAllConnections()
  await f.app.stop()
  assert.equal(readiness.size, 0, 'stop clears readiness state')
})

test('SSE recovery A does not wait for B held retry and wrong identity never becomes ready', async (t) => {
  let f, release, entered, mode = 'missing'
  const held = new Promise((resolve) => { release = resolve })
  const started = new Promise((resolve) => { entered = resolve })
  t.after(() => release(null))
  f = await fixture(t, async ({ tableId }) => {
    if (mode === 'missing') return null
    if (tableId === PRODUCTION_TABLE_IDS[1]) { entered(); return held }
    return issued(screen(f.clock), f.clock)
  }, { streamHeartbeatMs: 1000 })
  f.app.state.setTables([screen(f.clock), screen(f.clock, { tableId: PRODUCTION_TABLE_IDS[1] })])
  const next = await stream(t, f)
  await next((e) => e.tables?.every((x) => x.predictionReadiness?.state === 'pending'))
  mode = 'ready'
  f.advance(300)
  await started
  const recovered = await Promise.race([next((e) => e.tables?.[0]?.predictionReadiness?.state === 'ready'), delay(200).then(() => null)])
  assert.ok(recovered, 'recovery publication must not join held peer')
  release(issued(screen(f.clock, { tableId: PRODUCTION_TABLE_IDS[1], round: 21 }), f.clock))
  const rejected = await next((e) => e.tables?.[0]?.prediction && e.tables?.[1]?.predictionReadiness?.state === 'unavailable')
  assert.equal(rejected.tables[1].prediction, null)
})


test('SSE late old identity and stop cannot publish ready or restart reads', async (t) => {
  let f, reads = 0
  const releases = new Map(), entries = new Map()
  const entered = (round) => new Promise((resolve) => entries.set(round, resolve))
  const oldEntered = entered(20), stopEntered = entered(22)
  f = await fixture(t, async ({ round }) => {
    reads++
    if (round === 21) return issued(screen(f.clock, { round }), f.clock)
    entries.get(round)?.()
    return new Promise((resolve) => releases.set(round, resolve))
  }, { livePredictionReadWaitMs: 1000, streamHeartbeatMs: 1000 })
  t.after(() => { for (const release of releases.values()) release(null) })
  f.app.state.setTables([screen(f.clock)])
  const next = await stream(t, f)
  await oldEntered
  f.app.state.setTables([screen(f.clock, { round: 21 })])
  await next((e) => e.tables?.[0]?.round === 21 && e.tables[0].predictionReadiness?.state === 'ready')
  releases.get(20)(issued(screen(f.clock), f.clock))
  await delay(50)
  assert.equal(next.events.some((e) => e.tables?.[0]?.round === 20 && e.tables[0].prediction), false)
  const settledReads = reads
  await delay(80)
  assert.equal(reads, settledReads, 'settled ready must not cause a new high-frequency poll')
  f.app.state.setTables([screen(f.clock, { round: 22 })])
  await stopEntered
  const stopping = f.app.stop()
  releases.get(22)(issued(screen(f.clock, { round: 22 }), f.clock))
  await stopping
  const stoppedReads = reads
  await delay(50)
  assert.equal(reads, stoppedReads)
  assert.equal(next.events.some((e) => e.tables?.[0]?.round === 22 && e.tables[0].prediction), false)
})
