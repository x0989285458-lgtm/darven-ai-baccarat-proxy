import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'
import { createLicenseAdminClient } from '../src/license-admin.js'

test('v090 admin writes require session token and backend overwrites adminAccount', async () => {
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
    ['createLicense', 'A001', 'User001', 'A001'],
  ])
})

test('v090 status accepts adminSessionToken and scopes by token account', async () => {
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

  const status = await app.inject({ method: 'GET', url: `/api/online-license/status?adminAccount=dv1788&adminSessionToken=${encodeURIComponent(token)}` })
  assert.equal(status.statusCode, 200)
  assert.deepEqual(calls, [['status', 'A001']])
})

test('v090 deleteAgents deactivates selected hierarchy and suspends their licenses', async () => {
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


test('v090 non-super managers cannot operate outside their agent subtree', async () => {
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
