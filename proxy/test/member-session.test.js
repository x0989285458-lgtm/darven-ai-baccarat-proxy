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
    headers: { authorization: ['Bear', 'er ', memberSessionToken].join('') },
  })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(JSON.parse(response.body), { ok: true, sessionExpiresAt })
})

test('encrypted opaque member session survives an application restart with the same secret', async () => {
  const memberSessionSecret = 'member-session-secret-with-at-least-32-bytes'
  const first = createMemberApp({ memberSessionSecret })
  const session = await login(first)
  const decoded = Buffer.from(session.memberSessionToken, 'base64url').toString('utf8')
  assert.equal(decoded.includes('Member001'), false)
  assert.equal(decoded.includes('license-1'), false)

  const restarted = createMemberApp({ memberSessionSecret })
  const response = await restarted.inject({
    method: 'POST',
    url: '/api/online-license/member-session',
    headers: { authorization: ['Bear', 'er ', session.memberSessionToken].join('') },
  })

  assert.equal(response.statusCode, 200)
  assert.equal(JSON.parse(response.body).ok, true)
})

test('concurrent member requests share one authorization check and revalidate after the short cache ttl', async () => {
  let clock = 1_000_000
  let validationCalls = 0
  let authorized = true
  let releaseFirstValidation
  const firstValidation = new Promise((resolve) => { releaseFirstValidation = resolve })
  const app = createMemberApp({
    now: () => clock,
    memberSessionValidationTtlMs: 10_000,
    licenseAdminClient: {
      validateMemberLogin: async () => ({
        ok: true,
        memberAccount: 'Member001',
        license: { id: 'license-1', code: 'LICENSE001', status: 'active' },
      }),
      validateMemberSession: async () => {
        validationCalls += 1
        if (validationCalls === 1) return firstValidation
        return { ok: authorized }
      },
    },
  })
  const { memberSessionToken } = await login(app)
  const headers = { authorization: ['Bear', 'er ', memberSessionToken].join('') }
  const requests = [
    app.inject({ method: 'POST', url: '/api/online-license/member-session', headers }),
    app.inject({ url: '/api/tables', headers }),
    app.inject({ url: '/api/tables', headers }),
  ]
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(validationCalls, 1)
  releaseFirstValidation({ ok: true })
  assert.deepEqual((await Promise.all(requests)).map((response) => response.statusCode), [200, 200, 200])

  assert.equal((await app.inject({ url: '/api/tables', headers })).statusCode, 200)
  assert.equal(validationCalls, 1)
  clock += 10_001
  authorized = false
  assert.equal((await app.inject({ url: '/api/tables', headers })).statusCode, 401)
  assert.equal(validationCalls, 2)
})

test('member session that expires while database validation is pending fails closed', async () => {
  let clock = 1_000_000
  let releaseValidation
  const validationPending = new Promise((resolve) => { releaseValidation = resolve })
  const app = createMemberApp({
    now: () => clock,
    memberSessionTtlMs: 60_000,
    licenseAdminClient: {
      validateMemberLogin: async () => ({ ok: true, memberAccount: 'Member001', license: { id: 'license-1', status: 'active' } }),
      validateMemberSession: async () => validationPending,
    },
  })
  const { memberSessionToken } = await login(app)
  const headers = { authorization: ['Bear', 'er ', memberSessionToken].join('') }
  const request = app.inject({ method: 'POST', url: '/api/online-license/member-session', headers })
  await new Promise((resolve) => setImmediate(resolve))
  clock += 60_000
  releaseValidation({ ok: true })
  assert.equal((await request).statusCode, 401)
})

test('failed authorization permanently rejects the same encrypted token until a new login', async () => {
  let validationCalls = 0
  let authorized = false
  const app = createMemberApp({
    memberSessionSecret: 'member-session-secret-with-at-least-32-bytes',
    licenseAdminClient: {
      validateMemberLogin: async () => ({ ok: true, memberAccount: 'Member001', license: { id: 'license-1', status: 'active' } }),
      validateMemberSession: async () => { validationCalls += 1; return { ok: authorized } },
    },
  })
  const { memberSessionToken } = await login(app)
  const headers = { authorization: ['Bear', 'er ', memberSessionToken].join('') }
  assert.equal((await app.inject({ url: '/api/tables', headers })).statusCode, 401)
  authorized = true
  assert.equal((await app.inject({ url: '/api/tables', headers })).statusCode, 401)
  assert.equal(validationCalls, 1)
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
