import test from 'node:test'
import assert from 'node:assert/strict'
import { createSupabaseIngestionClient } from '../src/supabase-writer.js'
import { PRODUCTION_TABLE_IDS } from '../src/cloud-capture.js'

const options = { url: 'http://127.0.0.1:1', serviceKey: 'offline-test-only', requireVerifiedStrategy: false }
const response = (count) => ({
  ok: true, status: 200,
  headers: new Headers(count == null ? {} : { 'Content-Range': count }),
  json: async () => Array.from({ length: 1000 }, () => ({ strategy_version: 'v105', settlement_final: true })),
})

test('today count uses a single bounded exact-count HEAD, not the 1000-row REST page', async () => {
  let calls = 0
  const client = createSupabaseIngestionClient({ ...options, now: () => Date.parse('2026-10-24T16:00:00.000Z'), fetchImpl: async (url, init) => {
    calls++
    assert.equal(new URL(url).hostname, '127.0.0.1')
    // Assert result first; request contract is checked below.
    client.request = { url: new URL(url), init }
    return response('0-0/5432')
  } })
  assert.equal(await client.countTodayPredictionRounds(), 5432)
  assert.equal(calls, 1)
  const { url, init } = client.request
  assert.equal(init.method, 'HEAD')
  assert.equal(new Headers(init.headers).get('Prefer'), 'count=exact')
  assert.ok(init.signal instanceof AbortSignal)
  assert.equal(url.searchParams.get('limit'), '1')
  assert.equal(url.searchParams.get('strategy_version'), 'eq.v105')
  assert.equal(url.searchParams.get('settlement_final'), 'eq.true')
  assert.equal(url.searchParams.get('table_id'), `in.(${PRODUCTION_TABLE_IDS.join(',')})`)
  assert.deepEqual(url.searchParams.getAll('created_at'), ['gte.2026-10-24T16:00:00.000Z', 'lt.2026-10-25T16:00:00.000Z'])
})

test('Taipei day bounds do not depend on host TZ, including midnight and year boundary', async () => {
  for (const [time, start, end] of [
    ['2026-10-24T15:59:59.999Z', '2026-10-23T16:00:00.000Z', '2026-10-24T16:00:00.000Z'],
    ['2026-12-31T16:00:00.000Z', '2026-12-31T16:00:00.000Z', '2027-01-01T16:00:00.000Z'],
  ]) {
    let requested
    const client = createSupabaseIngestionClient({ ...options, now: () => Date.parse(time), fetchImpl: async (url) => { requested = new URL(url); return response('*/0') } })
    assert.equal(await client.countTodayPredictionRounds(), 0)
    assert.deepEqual(requested.searchParams.getAll('created_at'), [`gte.${start}`, `lt.${end}`])
  }
})

test('missing, unknown, negative, fractional, malformed and unsafe counts fail closed', async () => {
  for (const value of [null, '0-0/*', '*/-1', '*/1.5', '*/1e3', '*/9007199254740992', 'garbage/12', '*/', '*/NaN']) {
    let calls = 0
    const client = createSupabaseIngestionClient({ ...options, fetchImpl: async () => { calls++; return response(value) } })
    await assert.rejects(client.countTodayPredictionRounds(), /count/i, String(value))
    assert.equal(calls, 1)
  }
})

test('zero and maximum safe exact counts are accepted without reading a response body', async () => {
  for (const [header, expected] of [['*/0', 0], ['0-0/9007199254740991', Number.MAX_SAFE_INTEGER]]) {
    const client = createSupabaseIngestionClient({ ...options, fetchImpl: async () => ({ ...response(header), json: () => { throw new Error('body must not be read') } }) })
    assert.equal(await client.countTodayPredictionRounds(), expected)
  }
})

test('HTTP and transport errors propagate and an unconfigured count is not zero', async () => {
  const http = createSupabaseIngestionClient({ ...options, fetchImpl: async () => ({ ok: false, status: 503, text: async () => 'unavailable' }) })
  await assert.rejects(http.countTodayPredictionRounds(), /503/)
  const transport = createSupabaseIngestionClient({ ...options, fetchImpl: async () => { throw new Error('offline transport failure') } })
  await assert.rejects(transport.countTodayPredictionRounds(), /offline transport failure/)
  await assert.rejects(createSupabaseIngestionClient({ url: null, serviceKey: null }).countTodayPredictionRounds(), /configured/i)
})

test('count aborts the single outstanding fetch using requestTimeoutMs', async () => {
  let calls = 0
  const keepAlive = setTimeout(() => {}, 1000)
  try {
    const client = createSupabaseIngestionClient({ ...options, requestTimeoutMs: 20, fetchImpl: async (_url, init) => {
      calls++
      assert.ok(init.signal instanceof AbortSignal)
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('count aborted')), { once: true }))
    } })
    await assert.rejects(client.countTodayPredictionRounds(), /count aborted/)
    assert.equal(calls, 1)
  } finally { clearTimeout(keepAlive) }
})
