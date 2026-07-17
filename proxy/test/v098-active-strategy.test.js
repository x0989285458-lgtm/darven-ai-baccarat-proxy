import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildDefaultEqualStrategy, buildFormalActiveStrategy, buildLivePrediction, buildShortRunAdjustedStrategy, createSupabaseIngestionClient } from '../src/supabase-writer.js'

test('v098 keeps every legacy initializer archived and only v097 formally active', () => {
  assert.deepEqual([
    [buildDefaultEqualStrategy().version, buildDefaultEqualStrategy().status],
    [buildShortRunAdjustedStrategy().version, buildShortRunAdjustedStrategy().status],
    [buildFormalActiveStrategy().version, buildFormalActiveStrategy().status],
  ], [
    ['v012_equal_weight_seed', 'archived'],
    ['v094_no_observe_confidence_30_70', 'archived'],
    ['v100', 'active'],
  ])
})

test('v098.10 migration archives all non-v098 active rows and enforces one active strategy', () => {
  const sql = readFileSync(new URL('../../frontend/supabase/schema_v09810_confidence_calibration.sql', import.meta.url), 'utf8')
  assert.match(sql, /update\s+public\.ai_strategy_versions[\s\S]*status\s*=\s*'archived'[\s\S]*status\s*=\s*'active'[\s\S]*version\s*<>\s*'v098_主信心實際命中校準版'/i)
  assert.match(sql, /create\s+unique\s+index[\s\S]*on\s+public\.ai_strategy_versions[\s\S]*where\s*\(status\s*=\s*'active'\)/i)
})

test('v098.10 runtime archives the previous active row before read-back accepts exactly one active v098 strategy', async () => {
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
  assert.match(requests[0].url, /version=neq\.v100/)
  assert.equal(requests[1].method, 'POST')
  assert.equal(requests[2].method, 'GET')
  assert.deepEqual(client.getRuntimeStatus(), { ready: true, degraded: false, reason: null, activeStrategyVersion: expected })
})

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
