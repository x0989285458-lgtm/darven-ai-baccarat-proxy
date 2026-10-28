import test from 'node:test'
import assert from 'node:assert/strict'
import { createSupabaseIngestionClient } from '../src/supabase-writer.js'
import { createPublicationReader } from '../src/publication-reader.js'

const ready = [{ table: { tableId: 'BAV01' }, prediction: { predictionId: 'exact' }, publication: { state: 'ready' } }]
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }

for (const ok of [true, false]) test(`publication REST: ${ok ? 'success' : 'error'} body deadline releases singleflight for recovery`, async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
  let calls = 0, firstSignal, rejectBody
  const writer = createSupabaseIngestionClient({
    url: 'https://publication-fixture.invalid', serviceKey: 'fixture-only', requestTimeoutMs: 10,
    fetchImpl: async (_url, init) => {
      calls++
      assert.equal(init.method, 'GET')
      if (calls > 1) return { ok: true, json: async () => ready }
      firstSignal = init.signal
      const body = new Promise((_resolve, reject) => { rejectBody = reject })
      init.signal.addEventListener('abort', () => rejectBody(Object.assign(new Error('fixture abort'), { name: 'AbortError' })), { once: true })
      return { ok, status: ok ? 200 : 503, json: () => body, text: () => body }
    },
  })
  const reader = createPublicationReader({ load: () => writer.readV105TablePublications(), waitMs: 30 })
  t.after(() => { reader.stop(); rejectBody?.(new Error('fixture cleanup')) })
  const first = reader.read().then(() => null, error => error)
  await flush()
  assert.equal(calls, 1)
  t.mock.timers.tick(10); await flush()
  assert.equal(firstSignal.aborted, true, 'response headers must not discharge the body deadline')
  assert.equal((await first).name, 'AbortError')
  assert.deepEqual(await reader.read(), ready)
  assert.equal(calls, 2, 'a failed body must not poison subsequent singleflight reads')
})

test('publication REST: completed body clears deadline without aborting a successful request', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
  let signal
  const writer = createSupabaseIngestionClient({
    url: 'https://publication-fixture.invalid', serviceKey: 'fixture-only', requestTimeoutMs: 10,
    fetchImpl: async (_url, init) => { signal = init.signal; return { ok: true, json: async () => ready } },
  })
  assert.deepEqual(await writer.readV105TablePublications(), ready)
  t.mock.timers.tick(100); await flush()
  assert.equal(signal.aborted, false)
})
