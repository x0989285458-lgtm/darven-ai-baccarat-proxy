import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'

function createMemberApp(overrides = {}) {
  return createApp({
    autoConnect: false,
    memberAuthRequired: true,
    licenseAdminClient: {
      validateMemberLogin: async () => ({
        ok: true,
        memberAccount: 'Member001',
        license: { id: 'license-1', status: 'active' },
      }),
      validateMemberSession: async () => ({ ok: true }),
    },
    ...overrides,
  })
}

async function login(app) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/online-license/member-login',
    body: JSON.stringify({ memberAccount: 'Member001', verificationPassword: 'VERIFY001' }),
  })
  assert.equal(response.statusCode, 200)
  return JSON.parse(response.body).memberSessionToken
}

test('v098.18 ui-history uses bearer auth, canonical live-table allowlist, and authoritative shoe', async () => {
  const calls = []
  const app = createMemberApp({
    supabaseClient: {
      configured: true,
      getTableUiSettledPredictions: async (query) => { calls.push(['predictions', query]); return [] },
      getTableUiRealCardRounds: async (query) => { calls.push(['rounds', query]); return [] },
    },
  })
  app.state.setTables([{ tableId: 'BAG01', shoe: 88, round: 4, sourceUpdatedAt: new Date().toISOString() }])
  const token = await login(app)

  const unauthorized = await app.inject({ url: '/api/tables/bag1/ui-history' })
  assert.equal(unauthorized.statusCode, 401)
  const queryToken = await app.inject({
    url: '/api/tables/bag1/ui-history?memberSessionToken=forbidden',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(queryToken.statusCode, 400)
  const excluded = await app.inject({
    url: '/api/tables/BAG04/ui-history',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(excluded.statusCode, 404)
  const absent = await app.inject({
    url: '/api/tables/BAG02/ui-history',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(absent.statusCode, 404)

  const response = await app.inject({
    url: '/api/tables/bag1/ui-history?shoe=999',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(JSON.parse(response.body), {
    ok: true,
    buildVersion: '098.22',
    tableId: 'BAG01',
    shoe: 88,
    settledPredictions: [],
    realCardRounds: [],
    realCardHistoryCompleteThroughRound: 0,
  })
  assert.deepEqual(calls, [
    ['predictions', { tableId: 'BAG01', shoe: 88, limit: 10 }],
    ['rounds', { tableId: 'BAG01', shoe: 88, limit: 100 }],
  ])
})

test('v098.18 ui-history fails closed with 503 when either DB getter is unavailable or fails', async () => {
  const missing = createMemberApp({ supabaseClient: { configured: true } })
  missing.state.setTables([{ tableId: 'BAG01', shoe: 9, round: 1 }])
  const missingToken = await login(missing)
  assert.equal((await missing.inject({
    url: '/api/tables/BAG01/ui-history',
    headers: { authorization: `Bearer ${missingToken}` },
  })).statusCode, 503)

  const failed = createMemberApp({
    supabaseClient: {
      configured: true,
      getTableUiSettledPredictions: async () => { throw new Error('db unavailable') },
      getTableUiRealCardRounds: async () => [],
    },
  })
  failed.state.setTables([{ tableId: 'BAG01', shoe: 9, round: 1 }])
  const failedToken = await login(failed)
  const failedResponse = await failed.inject({
    url: '/api/tables/BAG01/ui-history',
    headers: { authorization: `Bearer ${failedToken}` },
  })
  assert.equal(failedResponse.statusCode, 503)
  assert.deepEqual(JSON.parse(failedResponse.body), { ok: false, error: 'table ui history is unavailable' })

  const malformed = createMemberApp({
    supabaseClient: {
      configured: true,
      getTableUiSettledPredictions: async () => null,
      getTableUiRealCardRounds: async () => ({ rounds: [], completeThroughRound: 0 }),
    },
  })
  malformed.state.setTables([{ tableId: 'BAG01', shoe: 9, round: 1 }])
  const malformedToken = await login(malformed)
  assert.equal((await malformed.inject({
    url: '/api/tables/BAG01/ui-history',
    headers: { authorization: `Bearer ${malformedToken}` },
  })).statusCode, 503)
})
