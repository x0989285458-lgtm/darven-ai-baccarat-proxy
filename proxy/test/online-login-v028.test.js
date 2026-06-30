import test from 'node:test'
import assert from 'node:assert/strict'
import { createLicenseAdminClient } from '../src/license-admin.js'
import { createApp } from '../src/server.js'

test('v028 member frontend login uses memberAccount plus verificationPassword payload', async () => {
  const queries = []
  const pool = { async query(sql, params = []) { queries.push({ sql, params }); return fakeAuthResult(sql, params) } }
  const client = createLicenseAdminClient({ pool })
  const result = await client.validateMemberLogin({ memberAccount: 'User001', verificationPassword: 'Agent001_001' })
  assert.equal(result.ok, true)
  assert.equal(result.memberAccount, 'User001')
  assert.equal(result.license.code, 'Agent001_001')
  assert.ok(queries.some((q) => q.sql.includes('from public.licenses')))
  assert.deepEqual(queries.find((q) => q.sql.includes('from public.licenses')).params, ['Agent001_001', 'User001'])
})

test('v028 backend/admin login uses agentAccount only as the public identifier', async () => {
  const queries = []
  const pool = { async query(sql, params = []) { queries.push({ sql, params }); return fakeAuthResult(sql, params) } }
  const client = createLicenseAdminClient({ pool })
  const result = await client.validateAgentLogin({ agentAccount: 'Agent001' })
  assert.equal(result.ok, true)
  assert.equal(result.agent.code, 'Agent001')
  assert.deepEqual(queries.find((q) => q.sql.includes('from public.agents')).params, ['Agent001'])
})

test('v028 server exposes separated member-login and agent-login endpoints', async () => {
  const calls = []
  const licenseAdminClient = {
    async validateMemberLogin(input) { calls.push(['member', input.memberAccount, input.verificationPassword]); return { ok: true } },
    async validateAgentLogin(input) { calls.push(['agent', input.agentAccount]); return { ok: true } },
  }
  const app = createApp({ autoConnect: false, licenseAdminClient })
  const member = await app.inject({ method: 'POST', url: '/api/online-license/member-login', body: JSON.stringify({ memberAccount: 'User001', verificationPassword: 'Agent001_001' }) })
  const agent = await app.inject({ method: 'POST', url: '/api/online-license/agent-login', body: JSON.stringify({ agentAccount: 'Agent001' }) })
  assert.equal(member.statusCode, 200)
  assert.equal(agent.statusCode, 200)
  assert.deepEqual(calls, [['member', 'User001', 'Agent001_001'], ['agent', 'Agent001']])
})

function fakeAuthResult(sql, params) {
  if (sql.includes('from public.licenses')) return { rows: [{ id: 'license-1', code: params[0], status: 'active', expires_on: '2099-12-31', agent_code: 'Agent001', plan_name: '正式月卡' }] }
  if (sql.includes('from public.agents')) return { rows: [{ id: 'agent-1', code: params[0], name: '主代理' }] }
  if (sql.includes('license_validation_logs')) return { rows: [] }
  return { rows: [] }
}
