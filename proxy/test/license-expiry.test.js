import test from 'node:test'
import assert from 'node:assert/strict'
import { createLicenseAdminClient } from '../src/license-admin.js'
import pg from 'pg'
import { createApp } from '../src/server.js'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Use the installed driver's real SQL date parser; no database is contacted.
const parseSqlDate = pg.types.getTypeParser(1082, 'text')

function fixture(expiresOn, overrides = {}) {
  const license = {
    id: 'expiry-license', code: 'offline-expiry-code', member_account: 'expiry-member',
    status: 'active', expires_on: expiresOn, updated_at: '2026-10-01T00:00:00Z',
    ...overrides,
  }
  const audits = []
  const pool = { async query(sql, params = []) {
    if (sql.includes('from public.online_app_settings')) return { rows: [] }
    if (sql.includes('from public.licenses l')) return { rows: [license] }
    if (sql.includes('insert into public.license_validation_logs')) {
      audits.push(params)
      return { rows: [] }
    }
    if (/^select .*from public\.(manager_accounts|agents|plans)/s.test(sql)) return { rows: [] }
    throw new Error(`Unexpected SQL in offline expiry test: ${sql}`)
  } }
  const client = createLicenseAdminClient({ pool, authPool: pool })
  return { client, license, audits }
}

async function validateBoth(client, authorizationVersion = null) {
  return {
    login: await client.validateMemberLogin({ memberAccount: 'expiry-member', verificationPassword: 'offline-expiry-code' }),
    session: await client.validateMemberSession({ memberAccount: 'expiry-member', licenseId: 'expiry-license', authorizationVersion }),
  }
}

test('expired active native Date is rejected by real login and session validators', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-26T04:00:00Z') })
  const { client } = fixture(new Date(2026, 9, 25))
  const result = await validateBoth(client)
  assert.deepEqual([result.login.ok, result.session.ok], [false, false])
})

test('expiry remains usable through the Taipei end date and rejects at Taipei midnight', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-25T15:59:59.999Z') })
  const { client, audits } = fixture('2026-10-25')
  const before = await validateBoth(client)
  assert.deepEqual([before.login.ok, before.session.ok], [true, true])
  t.mock.timers.setTime(new Date('2026-10-25T16:00:00.000Z').getTime())
  const after = await validateBoth(client)
  assert.deepEqual([after.login.ok, after.session.ok], [false, false])
  assert.deepEqual(audits.map((params) => params[3]), ['valid', 'expired'])
})

for (const invalid of ['2026-02-30', '2026-13-01', '2026-10-32', '2099-02-29', '2100-02-29', '2099-12-31garbage', '2099-12-31T00:00:00Z', ' 2099-12-31', '2099-2-01', '0000-01-01', '', null, undefined, NaN, Infinity, 20991231, {}, new Date(NaN)]) {
  test(`invalid expiry fails closed: ${String(invalid)}`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-01T04:00:00Z') })
    const { client, audits } = fixture(invalid)
    const result = await validateBoth(client)
    assert.deepEqual([result.login.ok, result.session.ok], [false, false])
    assert.ok(['missing', 'expired'].includes(audits[0][3]))
  })
}

test('status remaining days agrees with valid pg native expiry and inclusive end date', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-25T16:00:00Z') })
  for (const [expiresOn, remain, allowed] of [
    ['2026-10-25', '已到期', false],
    ['2026-10-26', '今日到期', true],
    ['2026-10-27', '1天', true],
  ]) {
    const native = parseSqlDate(expiresOn)
    assert.ok(native instanceof Date)
    assert.equal(native.getHours(), 0)
    const { client } = fixture(native)
    const result = await validateBoth(client)
    const status = await client.getStatus()
    assert.deepEqual([result.login.ok, result.session.ok], [allowed, allowed])
    assert.equal(status.licenseRows[0].expiresOn, expiresOn)
    assert.equal(status.licenseRows[0].remain, remain)
  }
})

for (const [text, now, remain] of [
  ['2028-02-29', '2028-02-28T16:00:00Z', '今日到期'],
  ['2400-02-29', '2400-02-28T16:00:00Z', '今日到期'],
  ['2026-11-02', '2026-10-31T16:00:00Z', '1天'],
  ['2026-03-09', '2026-03-07T16:00:00Z', '1天'],
]) {
  test(`pg SQL date and strict string agree across calendar/DST boundary ${text}`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date(now) })
    for (const expiry of [text, parseSqlDate(text)]) {
      const { client } = fixture(expiry)
      const result = await validateBoth(client)
      assert.deepEqual([result.login.ok, result.session.ok], [true, true])
      const status = await client.getStatus()
      assert.equal(status.licenseRows[0].expiresOn, text)
      assert.equal(status.licenseRows[0].remain, remain)
    }
  })
}

test('invalid dates have no usable date or positive remaining days in status', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-26T04:00:00Z') })
  for (const expiry of [null, undefined, new Date(NaN), '2099-02-30', Infinity, {}]) {
    const { client } = fixture(expiry)
    const status = await client.getStatus()
    assert.equal(status.licenseRows[0].expiresOn, null)
    assert.equal(status.licenseRows[0].remain, '未設定')
  }
})

for (const status of ['suspended', 'expired']) {
  test(`${status} remains rejected even with future expiry and preserves audit enum`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-26T04:00:00Z') })
    const { client, audits } = fixture(parseSqlDate('2026-10-27'), { status })
    const result = await validateBoth(client)
    assert.deepEqual([result.login.ok, result.session.ok], [false, false])
    assert.equal(audits[0][3], status)
    assert.equal(audits[0][2], '[REDACTED]')
  })
}

test('session version mismatch remains rejected with a valid native expiry', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-26T04:00:00Z') })
  const { client, license } = fixture(parseSqlDate('2026-10-27'))
  const matched = await validateBoth(client, license.updated_at)
  assert.deepEqual([matched.login.ok, matched.session.ok], [true, true])
  const mismatch = await validateBoth(client, '2026-10-02T00:00:00Z')
  assert.deepEqual([mismatch.login.ok, mismatch.session.ok], [true, false])
})

test('expiry fix does not introduce a starts_on admission policy', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-26T04:00:00Z') })
  const { client } = fixture(parseSqlDate('2026-11-30'), { starts_on: '2026-11-01' })
  const result = await validateBoth(client)
  assert.deepEqual([result.login.ok, result.session.ok], [true, true])
})

function memberApp(client) {
  return createApp({
    autoConnect: false, production: false, requireVerifiedStrategy: false,
    token: null, captureUrl: null, cloudBrowserUrl: null, deployMode: 'local',
    memberAuthRequired: true, memberSessionTtlMs: 30 * 60 * 1000,
    // The existing default policy is revalidation on every request (TTL=0).
    memberSessionValidationTtlMs: 0,
    memberSessionSecret: 'offline-expiry-composition-secret-not-a-credential',
    now: () => Date.now(), licenseAdminClient: client,
    supabaseClient: { configured: false }, onlineCoreClient: { configured: false },
  })
}

function loginRequest(app) {
  return app.inject({
    method: 'POST', url: '/api/online-license/member-login',
    body: JSON.stringify({ memberAccount: 'expiry-member', verificationPassword: 'offline-expiry-code' }),
  })
}

test('real App login does not issue a session for an expired pg native date', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-26T04:00:00Z') })
  const { client } = fixture(parseSqlDate('2026-10-25'))
  const response = await loginRequest(memberApp(client))
  assert.equal(response.statusCode, 200) // Existing login failure envelope is preserved.
  const payload = JSON.parse(response.body)
  assert.equal(payload.ok, false)
  assert.equal(Object.hasOwn(payload, 'memberSessionToken'), false)
  assert.equal(Object.hasOwn(payload, 'sessionExpiresAt'), false)
})

test('real App accepts valid login and revalidates sealed session in a fresh runtime', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-26T04:00:00Z') })
  const { client } = fixture(parseSqlDate('2026-10-27'))
  const issued = await loginRequest(memberApp(client))
  assert.equal(issued.statusCode, 200)
  const payload = JSON.parse(issued.body)
  assert.equal(payload.ok, true)
  assert.equal(Buffer.from(payload.memberSessionToken, 'base64url')[0], 1)
  const headers = { authorization: ['Bearer', payload.memberSessionToken].join(' ') }
  const restarted = memberApp(client)
  const session = await restarted.inject({ method: 'POST', url: '/api/online-license/member-session', headers })
  assert.equal(session.statusCode, 200)
  assert.equal(JSON.parse(session.body).ok, true)
  assert.equal((await restarted.inject({ url: '/api/tables', headers })).statusCode, 200)
})

test('real App rejects existing sealed session and protected tables at Taipei midnight', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-25T15:59:59.999Z') })
  const { client } = fixture(parseSqlDate('2026-10-25'))
  const issuer = memberApp(client)
  const issued = await loginRequest(issuer)
  const payload = JSON.parse(issued.body)
  assert.equal(issued.statusCode, 200)
  assert.equal(payload.ok, true)
  assert.equal(Buffer.from(payload.memberSessionToken, 'base64url')[0], 1)
  const headers = { authorization: ['Bearer', payload.memberSessionToken].join(' ') }
  assert.equal((await issuer.inject({ method: 'POST', url: '/api/online-license/member-session', headers })).statusCode, 200)
  assert.equal((await issuer.inject({ url: '/api/tables', headers })).statusCode, 200)
  t.mock.timers.setTime(new Date('2026-10-25T16:00:00.000Z').getTime())
  assert.ok(Date.parse(payload.sessionExpiresAt) > Date.now(), 'rejection must be license expiry, not token TTL')
  assert.equal((await issuer.inject({ method: 'POST', url: '/api/online-license/member-session', headers })).statusCode, 401)
  // Fresh runtime has no rejected-token cache: it must decrypt and revalidate.
  assert.equal((await memberApp(client).inject({ url: '/api/tables', headers })).statusCode, 401)
  assert.equal((await memberApp(client).inject({ method: 'POST', url: '/api/online-license/member-session', headers })).statusCode, 401)
})

if (!process.env.LICENSE_EXPIRY_TZ_CHILD) {
  for (const timezone of ['UTC', 'Asia/Taipei', 'America/Los_Angeles']) {
    test(`expiry validator, pg parser, status and real App contracts in process TZ=${timezone}`, (t) => {
      // Do not inherit Node's internal child-runner context into a new runner.
      const { NODE_TEST_CONTEXT, ...environment } = process.env
      const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', fileURLToPath(import.meta.url)], {
        env: { ...environment, TZ: timezone, LICENSE_EXPIRY_TZ_CHILD: '1' },
        encoding: 'utf8', timeout: 30_000,
      })
      assert.equal(result.error, undefined)
      assert.equal(result.status, 0, result.stdout + result.stderr)
      assert.match(result.stdout, /^# tests 33\r?$/m)
      assert.match(result.stdout, /^# fail 0\r?$/m)
      t.diagnostic(`${timezone}: 33 tests, exit 0, fail 0`)
    })
  }
}

