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
        license: { id: 'license-1', code: 'LICENSE001', status: 'active' },
      }),
      validateMemberSession: async () => ({ ok: true }),
    },
    ...overrides,
  })
}

test('member session token is opaque and cannot disclose authorization data through base64 decoding', async () => {
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

test('member session can be revalidated immediately after login without returning to login', async () => {
  const app = createMemberApp()
  const { memberSessionToken, sessionExpiresAt } = await login(app)

  const response = await app.inject({
    method: 'POST',
    url: '/api/online-license/member-session',
    headers: { authorization: `Bearer ${memberSessionToken}` },
  })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(JSON.parse(response.body), { ok: true, sessionExpiresAt })
})

test('member session expiry defaults to thirty minutes server-side', async () => {
  let clock = 1_000_000
  const app = createMemberApp({ now: () => clock, memberSessionTtlMs: undefined })
  const session = await login(app)

  assert.equal(Date.parse(session.sessionExpiresAt) - clock, 30 * 60 * 1000)
})

test('member session expiry is capped at thirty minutes server-side', async () => {
  let clock = 1_000_000
  const app = createMemberApp({ now: () => clock, memberSessionTtlMs: 60 * 60 * 1000 })
  const session = await login(app)

  assert.equal(Date.parse(session.sessionExpiresAt) - clock, 30 * 60 * 1000)
})

test('member session remains valid at 29:59 and expires at 30:00', async () => {
  let clock = 1_000_000
  const app = createMemberApp({ now: () => clock, memberSessionTtlMs: undefined })
  const session = await login(app)

  clock += 29 * 60 * 1000 + 59 * 1000
  const stillValid = await app.inject({ url: '/api/tables', headers: { authorization: `Bearer ${session.memberSessionToken}` } })
  assert.equal(stillValid.statusCode, 200)

  clock += 1000
  const expired = await app.inject({ url: '/api/tables', headers: { authorization: `Bearer ${session.memberSessionToken}` } })
  assert.equal(expired.statusCode, 401)
})

test('tables polling accepts only Authorization bearer and rejects every query token', async () => {
  const app = createMemberApp()
  const { memberSessionToken } = await login(app)

  assert.equal((await app.inject({ url: '/api/tables', headers: { authorization: `Bearer ${memberSessionToken}` } })).statusCode, 200)
  assert.equal((await app.inject({ url: '/api/tables', headers: { 'x-member-session-token': memberSessionToken } })).statusCode, 401)
  assert.equal((await app.inject({ url: '/api/tables?memberSessionToken=forbidden-query-token', headers: { authorization: `Bearer ${memberSessionToken}` } })).statusCode, 400)
})

test('session authorization never replays the member login password', async () => {
  let loginCalls = 0
  const app = createMemberApp({
    licenseAdminClient: {
      validateMemberLogin: async () => {
        loginCalls += 1
        return { ok: true, memberAccount: 'Member001', license: { id: 'license-1', status: 'active' } }
      },
    },
  })
  const { memberSessionToken } = await login(app)

  const response = await app.inject({ url: '/api/tables', headers: { authorization: `Bearer ${memberSessionToken}` } })

  assert.equal(response.statusCode, 401)
  assert.equal(loginCalls, 1)
})

test('tables SSE accepts Authorization bearer and never accepts a query ticket or query session', async () => {
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
