import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildFormalActiveStrategy, buildLivePrediction, createSupabaseIngestionClient } from '../src/supabase-writer.js'

test('v102 exposes exactly one formal active strategy identity', () => {
  assert.deepEqual([buildFormalActiveStrategy().version, buildFormalActiveStrategy().status], ['v105', 'active'])
})

test('runtime archives the previous active row before read-back accepts exactly one active strategy', async () => {
  const expected = buildFormalActiveStrategy().version
  const requests = []
  const client = createSupabaseIngestionClient({
    url: 'https://example.invalid', serviceKey: 'fixture-key', retryAttempts: 1,
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: String(url), method: options.method })
      return String(url).includes('status=eq.active')
        ? { ok: true, json: async () => [{ version: expected, status: 'active' }], text: async () => '' }
        : { ok: true, status: 201, text: async () => '' }
    },
  })

  assert.deepEqual(await client.ensureInitialStrategy(), { ok: true, activeStrategyVersion: expected })
  assert.equal(requests[0].method, 'PATCH')
  assert.match(requests[0].url, /status=eq\.active/)
  assert.match(requests[0].url, /version=neq\.v105/)
  assert.equal(requests[1].method, 'POST')
  assert.equal(requests[2].method, 'GET')
  assert.deepEqual(client.getRuntimeStatus(), { ready: true, degraded: false, reason: null, activeStrategyVersion: expected })
})

test('read-only startup verification accepts one exact active v105 through REST without mutation', async () => {
  const requests = []
  const client = createSupabaseIngestionClient({
    url: 'https://example.invalid', serviceKey: 'fixture-key', retryAttempts: 1,
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: String(url), method: options.method })
      return {
        ok: true,
        status: 200,
        json: async () => [{ version: 'v105', status: 'active' }],
        text: async () => '',
      }
    },
  })

  assert.deepEqual(await client.verifyActiveStrategyReadOnly(), { ok: true, activeStrategyVersion: 'v105' })
  assert.deepEqual(requests.map(({ method }) => method), ['GET'])
  assert.match(requests[0].url, /status=eq\.active/)
  assert.match(requests[0].url, /limit=2/)
  assert.deepEqual(client.getRuntimeStatus(), {
    ready: true,
    degraded: false,
    reason: null,
    activeStrategyVersion: 'v105',
  })
})

test('read-only startup verification accepts one exact active v105 through direct DB without REST', async () => {
  let fetchCalls = 0
  const client = createSupabaseIngestionClient({
    url: 'https://example.invalid', serviceKey: 'fixture-key',
    strategyPool: {
      async query() { return { rows: [{ version: 'v105', status: 'active' }] } },
    },
    fetchImpl: async () => { fetchCalls += 1; throw new Error('REST must not be used') },
  })

  assert.deepEqual(await client.verifyActiveStrategyReadOnly(), { ok: true, activeStrategyVersion: 'v105' })
  assert.equal(fetchCalls, 0)
})

for (const [name, response] of [
  ['wrong version', { rows: [{ version: 'legacy', status: 'active' }] }],
  ['zero rows', { rows: [] }],
  ['multiple rows', { rows: [{ version: 'v105', status: 'active' }, { version: 'legacy', status: 'active' }] }],
  ['read error', { error: new Error('backend read unavailable') }],
]) {
  test(`read-only startup verification fails closed for ${name} without mutation`, async () => {
    const requests = []
    const client = createSupabaseIngestionClient({
      url: 'https://example.invalid', serviceKey: 'fixture-key', retryAttempts: 1,
      fetchImpl: async (url, options = {}) => {
        requests.push({ url: String(url), method: options.method })
        if (response.error) throw response.error
        return { ok: true, status: 200, json: async () => response.rows, text: async () => '' }
      },
    })

    await assert.rejects(client.verifyActiveStrategyReadOnly(), /active strategy read-only verification failed/)
    assert.deepEqual(requests.map(({ method }) => method), ['GET'])
    assert.equal(requests.some(({ method }) => method === 'PATCH' || method === 'POST'), false)
    assert.deepEqual(client.getRuntimeStatus(), {
      ready: false,
      degraded: true,
      reason: 'active strategy read-only verification failed',
      activeStrategyVersion: null,
    })
  })
}

for (const [name, activeRows] of [
  ['zero active', []],
  ['multiple active', [{ version: buildFormalActiveStrategy().version }, { version: 'legacy' }]],
  ['wrong active version', [{ version: 'legacy' }]],
]) {
  test(`v098 runtime fails closed for ${name}`, async () => {
    const requests = []
    const client = createSupabaseIngestionClient({
      url: 'https://example.invalid', serviceKey: 'fixture-key', retryAttempts: 1,
      fetchImpl: async (url) => {
        requests.push(String(url))
        return String(url).includes('status=eq.active')
          ? { ok: true, json: async () => activeRows, text: async () => '' }
          : { ok: true, status: 201, text: async () => '' }
      },
    })

    await assert.rejects(client.ensureInitialStrategy(), /active strategy verification failed/)
    assert.equal(client.getRuntimeStatus().degraded, true)
    const table = { tableId: 'BAG01', shoe: 8, round: 1 }
    await assert.rejects(client.persistRound({ tableId: 'BAG01', shoe: 8, round: 2, winner: 'banker' }, table, buildLivePrediction(table)), /active strategy verification failed/)
    assert.equal(requests.some((url) => url.includes('/rpc/persist_v098_settled_round')), false)
  })
}
