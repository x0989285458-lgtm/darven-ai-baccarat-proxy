import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildFormalActiveStrategy, buildLivePrediction, createSupabaseIngestionClient } from '../src/supabase-writer.js'

test('v106 exposes exactly one formal active strategy identity', () => {
  assert.deepEqual([buildFormalActiveStrategy().version, buildFormalActiveStrategy().status], ['v106', 'active'])
})

test('runtime verifies exactly one active v106 strategy without mutating strategy registry state', async () => {
  const expected = buildFormalActiveStrategy().version
  const requests = []
  const client = createSupabaseIngestionClient({
    url: 'https://example.invalid', serviceKey: 'fixture-key', retryAttempts: 1,
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: String(url), method: options.method })
      return { ok: true, json: async () => [{ version: expected, status: 'active' }], text: async () => '' }
    },
  })

  assert.deepEqual(await client.ensureInitialStrategy(), { ok: true, activeStrategyVersion: expected })
  assert.deepEqual(requests.map(({ method }) => method), ['GET'])
  assert.match(requests[0].url, /status=eq\.active/)
  assert.deepEqual(client.getRuntimeStatus(), { ready: true, degraded: false, reason: null, activeStrategyVersion: expected })
})

for (const [name, activeRows] of [
  ['zero active', []],
  ['multiple active', [{ version: buildFormalActiveStrategy().version }, { version: 'legacy' }]],
  ['wrong active version', [{ version: 'legacy' }]],
]) {
  test(`v106 runtime fails closed without registry writes for ${name}`, async () => {
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
    assert.equal(requests.length, 1)
    assert.equal(client.getRuntimeStatus().degraded, true)
    const table = { tableId: 'BAG01', shoe: 8, round: 1 }
    await assert.rejects(client.persistRound({ tableId: 'BAG01', shoe: 8, round: 2, winner: 'banker' }, table, buildLivePrediction(table)), /active strategy verification failed/)
    assert.equal(requests.some((url) => url.includes('/rpc/persist_v098_settled_round')), false)
  })
}
