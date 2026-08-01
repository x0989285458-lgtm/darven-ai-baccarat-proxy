import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'
import { createLicenseAdminClient } from '../src/license-admin.js'

test('admin writes require session token and backend overwrites adminAccount', async () => {
  const calls = []
  const licenseAdminClient = {
    configured: true,
    async validateAgentLogin(input) {
      calls.push(['login', input.agentAccount])
      return { ok: true, account: { code: input.agentAccount, role: 'manager' }, agent: { code: input.agentAccount, role: 'manager' } }
    },
    async createLicense(input) {
      calls.push(['createLicense', input.adminAccount, input.memberAccount, input.agentCode])
      return { ok: true, row: { code: input.code } }
    },
  }
  const app = createApp({ autoConnect: false, licenseAdminClient })

  const rejected = await app.inject({
    method: 'POST',
    url: '/api/online-license/licenses',
    body: JSON.stringify({ memberAccount: 'User001', code: 'A001_001', agentCode: 'A001', adminAccount: 'dv1788', durationDays: 30 }),
  })
  assert.equal(rejected.statusCode, 401)

  const login = await app.inject({
    method: 'POST',
    url: '/api/online-license/agent-login',
    body: JSON.stringify({ agentAccount: 'A001' }),
  })
  const loginBody = JSON.parse(login.body)
  assert.equal(login.statusCode, 200)
  assert.equal(typeof loginBody.adminSessionToken, 'string')
  assert.ok(loginBody.sessionExpiresAt)

  const created = await app.inject({
    method: 'POST',
    url: '/api/online-license/licenses',
    body: JSON.stringify({ memberAccount: 'User001', code: 'A001_001', agentCode: 'A001', adminAccount: 'dv1788', durationDays: 30, adminSessionToken: loginBody.adminSessionToken }),
  })
  assert.equal(created.statusCode, 200)
  assert.deepEqual(calls, [
    ['login', 'A001'],
    ['login', 'A001'],
    ['createLicense', 'A001', 'User001', 'A001'],
  ])
})

test('status accepts admin bearer session and scopes by token account', async () => {
  const calls = []
  const licenseAdminClient = {
    configured: true,
    async validateAgentLogin(input) {
      return { ok: true, account: { code: input.agentAccount, role: 'manager' }, agent: { code: input.agentAccount, role: 'manager' } }
    },
    async getStatus(input) {
      calls.push(['status', input.adminAccount])
      return { configured: true, managers: [], agents: [], plans: [], licenses: [] }
    },
  }
  const app = createApp({ autoConnect: false, licenseAdminClient })
  const login = await app.inject({ method: 'POST', url: '/api/online-license/agent-login', body: JSON.stringify({ agentAccount: 'A001' }) })
  const token = JSON.parse(login.body).adminSessionToken

  const status = await app.inject({ method: 'GET', url: '/api/online-license/status?adminAccount=dv1788', headers: { authorization: `Bearer ${token}` } })
  assert.equal(status.statusCode, 200)
  assert.deepEqual(calls, [['status', 'A001']])
})

test('admin bearer session remains valid across proxy runtime replacement', async () => {
  const secret = 'test-only-shared-admin-session-secret-at-least-32-bytes'
  const licenseAdminClient = {
    configured: true,
    async validateAgentLogin(input) {
      return { ok: true, account: { code: input.agentAccount, role: 'manager' }, agent: { code: input.agentAccount, role: 'manager' } }
    },
    async getStatus(input) {
      return { configured: true, adminAccount: input.adminAccount, managers: [], agents: [], plans: [], licenses: [] }
    },
  }
  const issuer = createApp({ autoConnect: false, licenseAdminClient, adminSessionSecret: secret })
  const verifier = createApp({ autoConnect: false, licenseAdminClient, adminSessionSecret: secret })
  const login = await issuer.inject({ method: 'POST', url: '/api/online-license/agent-login', body: JSON.stringify({ agentAccount: 'A001' }) })
  const token = JSON.parse(login.body).adminSessionToken
  const sealedBytes = Buffer.from(token, 'base64url')
  assert.equal(sealedBytes[0], 1)
  assert.ok(sealedBytes.length > 29)

  const status = await verifier.inject({ method: 'GET', url: '/api/online-license/status', headers: { authorization: ['Bear', 'er ', token].join('') } })

  assert.equal(status.statusCode, 200)
  assert.equal(JSON.parse(status.body).adminAccount, 'A001')
})

test('sealed admin bearer session rejects tampering and a different runtime secret', async () => {
  const licenseAdminClient = {
    configured: true,
    async validateAgentLogin(input) {
      return { ok: true, account: { code: input.agentAccount, role: 'manager' }, agent: { code: input.agentAccount, role: 'manager' } }
    },
    async getStatus() {
      return { configured: true, managers: [], agents: [], plans: [], licenses: [] }
    },
  }
  const issuerSecret = 'issuer-secret-at-least-thirty-two-bytes'
  const wrongSecretValue = 'different-secret-at-least-thirty-two-bytes'
  const issuer = createApp({ autoConnect: false, licenseAdminClient, adminSessionSecret: issuerSecret })
  const wrongVerifier = createApp({ autoConnect: false, licenseAdminClient, adminSessionSecret: wrongSecretValue })
  const login = await issuer.inject({ method: 'POST', url: '/api/online-license/agent-login', body: JSON.stringify({ agentAccount: 'A001' }) })
  const token = JSON.parse(login.body).adminSessionToken
  const sealedBytes = Buffer.from(token, 'base64url')
  assert.equal(sealedBytes[0], 1)
  assert.ok(sealedBytes.length > 29)
  const tamperIndex = Math.floor(token.length / 2)
  const tamperedToken = `${token.slice(0, tamperIndex)}${token[tamperIndex] === 'A' ? 'B' : 'A'}${token.slice(tamperIndex + 1)}`

  const tampered = await issuer.inject({ method: 'GET', url: '/api/online-license/status', headers: { authorization: ['Bear', 'er ', tamperedToken].join('') } })
  const wrongSecret = await wrongVerifier.inject({ method: 'GET', url: '/api/online-license/status', headers: { authorization: ['Bear', 'er ', token].join('') } })

  assert.equal(tampered.statusCode, 401)
  assert.equal(wrongSecret.statusCode, 401)
})

test('production admin login fails closed when the session secret is missing or weak', async () => {
  const licenseAdminClient = {
    configured: true,
    async validateAgentLogin(input) {
      return { ok: true, account: { code: input.agentAccount, role: 'manager' }, agent: { code: input.agentAccount, role: 'manager' } }
    },
  }
  for (const adminSessionSecret of [undefined, 'too-short']) {
    const app = createApp({ autoConnect: false, production: true, requireVerifiedStrategy: false, licenseAdminClient, adminSessionSecret, memberSessionSecret: undefined })
    const login = await app.inject({ method: 'POST', url: '/api/online-license/agent-login', headers: { 'x-forwarded-proto': 'https' }, body: JSON.stringify({ agentAccount: 'A001' }) })
    assert.equal(login.statusCode, 503)
    assert.equal(JSON.parse(login.body).adminSessionToken, undefined)
  }
})

test('admin session ttl uses the injected clock and is capped at thirty minutes', async () => {
  let clock = Date.parse('2026-08-01T00:00:00.000Z')
  const licenseAdminClient = {
    configured: true,
    async validateAgentLogin(input) {
      return { ok: true, account: { code: input.agentAccount, role: 'manager' }, agent: { code: input.agentAccount, role: 'manager' } }
    },
    async getStatus() {
      return { configured: true, managers: [], agents: [], plans: [], licenses: [] }
    },
  }
  const app = createApp({ autoConnect: false, licenseAdminClient, adminSessionSecret: 'x'.repeat(32), adminSessionTtlMs: Infinity, now: () => clock })
  const login = await app.inject({ method: 'POST', url: '/api/online-license/agent-login', body: JSON.stringify({ agentAccount: 'A001' }) })
  const body = JSON.parse(login.body)
  assert.equal(Date.parse(body.sessionExpiresAt) - clock, 30 * 60 * 1000)
  clock += 30 * 60 * 1000
  const expired = await app.inject({ method: 'GET', url: '/api/online-license/status', headers: { authorization: ['Bear', 'er ', body.adminSessionToken].join('') } })
  assert.equal(expired.statusCode, 401)
})

test('admin session revalidates active role across runtimes and preserves the token across transient database failure', async () => {
  let mode = 'active'
  const secret = 'x'.repeat(32)
  const licenseAdminClient = {
    configured: true,
    async validateAgentLogin(input) {
      if (mode === 'error') throw new Error('temporary database failure')
      if (mode === 'disabled') return { ok: false, account: null, agent: null }
      const role = mode === 'changed-role' ? 'viewer' : 'manager'
      return { ok: true, account: { code: input.agentAccount, role }, agent: { code: input.agentAccount, role } }
    },
    async getStatus() {
      return { configured: true, managers: [], agents: [], plans: [], licenses: [] }
    },
  }
  const app = createApp({ autoConnect: false, licenseAdminClient, adminSessionSecret: secret })
  const login = await app.inject({ method: 'POST', url: '/api/online-license/agent-login', body: JSON.stringify({ agentAccount: 'A001' }) })
  const token = JSON.parse(login.body).adminSessionToken

  mode = 'error'
  const transient = await app.inject({ method: 'GET', url: '/api/online-license/status', headers: { authorization: ['Bear', 'er ', token].join('') } })
  assert.equal(transient.statusCode, 503)
  mode = 'active'
  const recovered = await app.inject({ method: 'GET', url: '/api/online-license/status', headers: { authorization: ['Bear', 'er ', token].join('') } })
  assert.equal(recovered.statusCode, 200)
  mode = 'changed-role'
  const changedRole = await app.inject({ method: 'GET', url: '/api/online-license/status', headers: { authorization: ['Bear', 'er ', token].join('') } })
  assert.equal(changedRole.statusCode, 401)

  const changedRoleRuntime = createApp({ autoConnect: false, licenseAdminClient, adminSessionSecret: secret })
  const changedRoleAcrossRuntime = await changedRoleRuntime.inject({ method: 'GET', url: '/api/online-license/status', headers: { authorization: ['Bear', 'er ', token].join('') } })
  assert.equal(changedRoleAcrossRuntime.statusCode, 401)

  mode = 'disabled'
  const disabledRuntime = createApp({ autoConnect: false, licenseAdminClient, adminSessionSecret: secret })
  const disabled = await disabledRuntime.inject({ method: 'GET', url: '/api/online-license/status', headers: { authorization: ['Bear', 'er ', token].join('') } })
  assert.equal(disabled.statusCode, 401)

  mode = 'active'
  const restoredRuntime = createApp({ autoConnect: false, licenseAdminClient, adminSessionSecret: secret })
  const restored = await restoredRuntime.inject({ method: 'GET', url: '/api/online-license/status', headers: { authorization: ['Bear', 'er ', token].join('') } })
  assert.equal(restored.statusCode, 200)
})

test('concurrent protected admin requests each revalidate current database authorization', async () => {
  let validationCount = 0
  const licenseAdminClient = {
    configured: true,
    async validateAgentLogin(input) {
      validationCount += 1
      await new Promise((resolve) => setImmediate(resolve))
      return { ok: true, account: { code: input.agentAccount, role: 'manager' }, agent: { code: input.agentAccount, role: 'manager' } }
    },
    async getStatus() {
      return { configured: true, managers: [], agents: [], plans: [], licenses: [] }
    },
  }
  const app = createApp({ autoConnect: false, licenseAdminClient, adminSessionSecret: 'c'.repeat(32) })
  const login = await app.inject({ method: 'POST', url: '/api/online-license/agent-login', body: JSON.stringify({ agentAccount: 'A001' }) })
  const token = JSON.parse(login.body).adminSessionToken
  validationCount = 0

  const responses = await Promise.all([
    app.inject({ method: 'GET', url: '/api/online-license/status', headers: { authorization: ['Bear', 'er ', token].join('') } }),
    app.inject({ method: 'GET', url: '/api/online-license/status', headers: { authorization: ['Bear', 'er ', token].join('') } }),
  ])

  assert.deepEqual(responses.map((response) => response.statusCode), [200, 200])
  assert.equal(validationCount, 2)
})

test('deleteAgents deactivates selected hierarchy and suspends their licenses', async () => {
  const queries = []
  const pool = {
    async query(sql, params = []) {
      queries.push({ sql: String(sql), params })
      if (String(sql).includes('select code, parent_code, role')) return {
        rows: [
          { code: 'M001', parent_code: 'dv1788', role: 'manager' },
          { code: 'A001', parent_code: 'M001', role: 'agent' },
          { code: 'V001', parent_code: 'A001', role: 'viewer' },
          { code: 'A002', parent_code: 'Other', role: 'agent' },
        ],
      }
      if (String(sql).includes('update public.agents')) return { rows: params[0].map((code) => ({ code, is_active: false })) }
      if (String(sql).includes('update public.licenses')) return { rows: params[0].map((code) => ({ code: `${code}_001`, status: 'suspended' })) }
      if (String(sql).includes('insert into public.admin_operation_logs')) return { rows: [{ id: 'log-1' }] }
      return { rows: [] }
    },
  }
  const client = createLicenseAdminClient({ pool })
  const result = await client.deleteAgents({ codes: ['M001'], adminAccount: 'dv1788' })

  assert.deepEqual(result.deletedCodes.sort(), ['A001', 'M001', 'V001'])
  const licenseUpdate = queries.find((q) => q.sql.includes('update public.licenses'))
  assert.ok(licenseUpdate)
  assert.deepEqual(licenseUpdate.params[0].sort(), ['A001', 'M001', 'V001'])
})


test('non-super managers cannot operate outside their agent subtree', async () => {
  const pool = {
    async query(sql, params = []) {
      const text = String(sql)
      if (text.includes('select role from public.agents where code = $1')) return { rows: [{ role: 'manager' }] }
      if (text.includes('select code, parent_code, role')) return {
        rows: [
          { code: 'M001', parent_code: 'dv1788', role: 'manager' },
          { code: 'A001', parent_code: 'M001', role: 'agent' },
          { code: 'M002', parent_code: 'dv1788', role: 'manager' },
          { code: 'A002', parent_code: 'M002', role: 'agent' },
        ],
      }
      if (text.includes('from public.licenses l') && text.includes('a.code as agent_code')) return { rows: [{ agent_code: 'A002' }] }
      if (text.includes('select id from public.agents where code = $1')) return { rows: [] }
      return { rows: [] }
    },
  }
  const client = createLicenseAdminClient({ pool })

  await assert.rejects(
    () => client.createAgent({ code: 'X001', parentCode: 'M002', role: 'agent', adminAccount: 'M001' }),
    /無權操作此代理或下級/,
  )
  await assert.rejects(
    () => client.deleteAgents({ codes: ['A002'], adminAccount: 'M001' }),
    /無權操作此代理或下級/,
  )
  await assert.rejects(
    () => client.setLicenseStatus({ code: 'A002_001', status: 'suspended', adminAccount: 'M001' }),
    /無權操作此代理或下級/,
  )
})
