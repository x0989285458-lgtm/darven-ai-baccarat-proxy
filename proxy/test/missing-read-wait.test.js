import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'
import { buildLivePrediction } from '../src/supabase-writer.js'

const table = { tableId: 'BAV01', shoe: 1603, round: 27, sourceUpdatedAt: new Date().toISOString() }
const exact = { ...buildLivePrediction({ ...table, round: 26 }), predictionId: 'durable-27', issuedAt: new Date().toISOString() }

test('real createApp HTTP waits for short missing cache then shares exact read across callers', async t => {
  let reads = 0
  let durable = false
  const app = createApp({ autoConnect: false, captureOutboxConsumerEnabled: false,
    supabaseClient: { configured: true,
      issuePrediction: async () => assert.fail('read-only caller must not issue'),
      readIssuedPrediction: async () => { reads++; return durable ? exact : null },
    },
  })
  t.after(() => app.stop())
  app.state.setTables([table])
  const cold = JSON.parse((await app.inject({ url: '/api/tables' })).body)
  assert.equal(cold[0].prediction, null)
  assert.equal(reads, 5)
  durable = true
  const started = Date.now()
  const results = await Promise.all(Array.from({ length: 10 }, () => app.inject({ url: '/api/tables' })))
  assert.ok(results.every(r => JSON.parse(r.body)[0].prediction?.predictionId === exact.predictionId), 'short missing cache must wait, not return an avoidable null')
  assert.equal(reads, 6, 'all callers join one exact read after the cache expires')
  assert.ok(Date.now() - started >= 200)
  assert.ok(Date.now() - started < 1000)
})

// Source-bound scheduling probes supplement (not replace) the real createApp caller.
import { readFileSync } from 'node:fs'
function scheduler(t, readIssuedPrediction, waitMs = 1000) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10000 })
  const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8')
  const body = source.slice(source.indexOf('  function rememberIssuedPredictionReadBackoff('), source.indexOf('  function predictionScreen('))
  return new Function('supabaseClient', `
    const issuedPredictionReadRetryAt = new Map(), readingIssuedPredictionPromises = new Map(), liveIssuedPredictionReadPromises = new Map(), pendingPredictions = new Map();
    const now = Date.now, resolvedLivePredictionReadWaitMs = ${waitMs}, ALL_MT_EQUAL_STRATEGY_VERSION = 'v105';
    let applicationStopped = false;
    const state = {setStatus() {}}, deepFreeze = x => x, isPendingPredictionExpired = () => false;
    const isExactScreenPrediction = (p, table, round) => p?.predictionId && p.targetRound === round;
    ${body}
    return { start: startIssuedPredictionRead, live: readLiveIssuedPredictionWithinWait,
      remember: rememberIssuedPredictionReadBackoff, retry: issuedPredictionReadRetryAt,
      stop: () => { applicationStopped = true } };
  `)({ readIssuedPrediction })
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
const key = 'BAV01:1603:27'

test('sleeping HTTP respects new SSE error and old missing completion cannot shorten or relabel it', async t => {
  let calls = 0
  const s = scheduler(t, async () => { calls++; throw Error('SSE read failed') })
  s.remember(key, 250, 'missing')
  let done = false
  const http = s.live(table, 27, key, true).then(x => { done = true; return x })
  await flush()
  assert.equal(done, false, 'HTTP must wait for the short missing cache')
  // SSE owns the next read exactly at cache expiry, before HTTP's timer resumes.
  t.mock.timers.setTime(10250)
  await s.start(table, 27, key, true)
  s.remember(key, 250, 'missing') // older HTTP exhaustion completes after the SSE error
  t.mock.timers.tick(250)
  await flush()
  assert.equal(await http, null)
  t.mock.timers.setTime(11000)
  assert.equal(await s.live(table, 27, key, true), null)
  assert.equal(calls, 1, 'new error retryAt must remain authoritative for 2000ms')
})

test('stop while HTTP waits prevents a post-stop durable read', async t => {
  let calls = 0
  const s = scheduler(t, async () => { calls++; return exact })
  s.remember(key, 250, 'missing')
  const pending = s.live(table, 27, key, true)
  await flush()
  s.stop()
  t.mock.timers.tick(250)
  await flush()
  assert.equal(await pending, null)
  assert.equal(calls, 0)
})

test('ten identities share flights, keep five-read budgets and one deadline after short cache', async t => {
  const calls = new Map()
  const s = scheduler(t, async ({ tableId }) => { calls.set(tableId, (calls.get(tableId) ?? 0) + 1); return null })
  const requests = []
  for (let i = 0; i < 10; i++) {
    const id = `T${i}`, k = `${id}:1603:27`, row = { ...table, tableId: id }
    s.remember(k, 250, 'missing')
    const first = s.live(row, 27, k, true)
    // Deadlines belong to callers; only the underlying read is shared.
    requests.push(first, s.live(row, 27, k, true))
  }
  for (const ms of [249, 1, 50, 100, 200, 400]) { t.mock.timers.tick(ms); await flush() }
  assert.deepEqual(await Promise.all(requests), Array(20).fill(null))
  assert.equal(calls.size, 10)
  assert.ok([...calls.values()].every(n => n <= 5 && n >= 2))
  assert.equal(Date.now(), 11000)
})

for (const failure of ['error', 'invalid', 'hung']) test(`${failure} preserves hard backoff against HTTP and SSE`, async t => {
  let calls = 0
  const s = scheduler(t, () => {
    calls++
    if (failure === 'error') throw Error('read unavailable')
    if (failure === 'invalid') return { predictionId: 'wrong', targetRound: 28 }
    return new Promise(() => {})
  }, 50)
  const pending = s.live(table, 27, key, true)
  await flush()
  if (failure === 'hung') { t.mock.timers.tick(50); await flush() }
  assert.equal(await pending, null)
  s.remember(key, 250, 'missing')
  t.mock.timers.tick(300)
  await flush()
  assert.equal(await s.live(table, 27, key, true), null)
  if (failure !== 'hung') assert.equal(await s.start(table, 27, key, true), null)
  assert.equal(calls, 1)
})

test('same table new identity is independent of a waiting old missing identity', async t => {
  const reads = []
  const s = scheduler(t, async ({ round }) => { reads.push(round); return { ...exact, targetRound: round } })
  s.remember(key, 250, 'missing')
  const old = s.live(table, 27, key, true)
  const newer = await s.live({ ...table, round: 28 }, 28, 'BAV01:1603:28', true)
  assert.equal(newer.targetRound, 28)
  assert.deepEqual(reads, [28])
  t.mock.timers.tick(250)
  await flush()
  assert.equal((await old).targetRound, 27)
  assert.deepEqual(reads, [28, 27])
})

test('real createApp stop drains a short-cache waiter without a late read', async t => {
  let reads = 0
  const app = createApp({ autoConnect: false, captureOutboxConsumerEnabled: false,
    supabaseClient: { configured: true, issuePrediction: async () => assert.fail('no issuance'), readIssuedPrediction: async () => { reads++; return null } },
  })
  t.after(() => app.stop())
  app.state.setTables([table])
  await app.inject({ url: '/api/tables' })
  const before = reads
  const waiting = app.inject({ url: '/api/tables' })
  await new Promise(resolve => setImmediate(resolve))
  await app.stop()
  assert.equal(JSON.parse((await waiting).body)[0].prediction, null)
  assert.equal(reads, before)
})

test('a deadline spent waiting on missing cache must not postpone its original due time', async t => {
  let calls = 0
  const s = scheduler(t, async () => { calls++; return exact }, 50)
  s.remember(key, 250, 'missing')
  const early = s.live(table, 27, key, true)
  t.mock.timers.tick(50)
  await flush()
  assert.equal(await early, null)
  t.mock.timers.tick(200)
  const due = s.live(table, 27, key, true)
  await flush()
  assert.equal(calls, 1, 'waiting without a read must not slide missing retryAt forward')
  assert.equal((await due).predictionId, exact.predictionId)
})
