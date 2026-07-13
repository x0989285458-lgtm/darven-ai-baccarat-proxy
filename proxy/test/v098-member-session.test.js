import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'

async function login(app) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/online-license/member-login',
    body: JSON.stringify({ memberAccount: 'Member001', verificationPassword: 'VERIFY001' }),
  })
  assert.equal(response.statusCode, 200)
  return JSON.parse(response.body)
}

function createMemberApp(overrides = {}) {
  return createApp({
    autoConnect: false,
    memberAuthRequired: true,
    memberSessionTtlMs: 60_000,
    licenseAdminClient: {
      validateMemberLogin: async () => ({
        ok: true,
        memberAccount: 'Member001',
        license: { code: 'LICENSE001', status: 'active' },
      }),
    },
    ...overrides,
  })
}

test('v098 member session token is opaque and cannot disclose authorization data through base64 decoding', async () => {
  const app = createMemberApp()
  const session = await login(app)
  const decoded = Buffer.from(session.memberSessionToken, 'base64url').toString('utf8')

  assert.equal(typeof session.memberSessionToken, 'string')
  assert.equal(session.memberSessionToken.includes('.'), false)
  assert.equal(decoded.includes('Member001'), false)
  assert.equal(decoded.includes('LICENSE001'), false)
  assert.equal(decoded.includes('active'), false)
  assert.match(session.sessionExpiresAt, /T/)
})

test('v098 member session expiry is capped at ten minutes server-side', async () => {
  let clock = 1_000_000
  const app = createMemberApp({ now: () => clock, memberSessionTtlMs: 20 * 60 * 1000 })
  const session = await login(app)

  assert.equal(Date.parse(session.sessionExpiresAt) - clock, 10 * 60 * 1000)
  clock += 10 * 60 * 1000 + 1
  const expired = await app.inject({ url: '/api/tables', headers: { authorization: `Bearer ${session.memberSessionToken}` } })
  assert.equal(expired.statusCode, 401)
})

test('v098 tables polling accepts only Authorization bearer and rejects every query token', async () => {
  const app = createMemberApp()
  const { memberSessionToken } = await login(app)

  assert.equal((await app.inject({ url: '/api/tables', headers: { authorization: `Bearer ${memberSessionToken}` } })).statusCode, 200)
  assert.equal((await app.inject({ url: '/api/tables', headers: { 'x-member-session-token': memberSessionToken } })).statusCode, 401)
  assert.equal((await app.inject({ url: '/api/tables?memberSessionToken=forbidden-query-token', headers: { authorization: `Bearer ${memberSessionToken}` } })).statusCode, 400)
})

test('v098 tables SSE accepts Authorization bearer and never accepts a query ticket or query session', async () => {
  const app = createMemberApp({ port: 0 })
  const { memberSessionToken } = await login(app)
  await app.start()
  const { port } = app.server.address()
  const controller = new AbortController()

  try {
    const authorized = await fetch(`http://127.0.0.1:${port}/api/tables/stream`, {
      headers: { authorization: `Bearer ${memberSessionToken}` },
      signal: controller.signal,
    })
    assert.equal(authorized.status, 200)
    controller.abort()

    const ticketQuery = await fetch(`http://127.0.0.1:${port}/api/tables/stream?streamTicket=forbidden-query-token`)
    assert.equal(ticketQuery.status, 400)
    const sessionQuery = await fetch(`http://127.0.0.1:${port}/api/tables/stream?memberSessionToken=forbidden-query-token`)
    assert.equal(sessionQuery.status, 400)
  } finally {
    controller.abort()
    await app.stop()
  }
})
