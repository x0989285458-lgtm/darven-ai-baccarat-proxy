import test from 'node:test'
import assert from 'node:assert/strict'
import { createLicenseAdminClient } from '../src/license-admin.js'
import { createApp } from '../src/server.js'

test('production license client isolates authentication reads from admin reporting queries', async () => {
  const pools = []
  const poolFactory = (config) => {
    const index = pools.length
    const queries = []
    let discardedClients = 0
    const pool = {
      config,
      queries,
      async connect() {
        return {
          query: (sql, params = []) => pool.query(sql, params),
          release(discard) { if (discard === true) discardedClients += 1 },
        }
      },
      get discardedClients() { return discardedClients },
      async query(sql, params = []) {
        queries.push({ sql: String(sql), params })
        if (String(sql).includes('online_app_settings')) return { rows: [] }
        if (String(sql).includes('manager_accounts')) return { rows: [{ id: 'manager-1', username: 'dv1788', role: 'total', is_active: true }] }
        if (String(sql).includes('where l.id = $1')) return { rows: [{ id: 'license-1', member_account: 'Member001', status: 'active', expires_on: '2099-12-31', updated_at: '2026-08-24T00:00:00.000Z' }] }
        if (String(sql).includes('where l.code = $1')) return { rows: [{ id: 'license-1', code: params[0], member_account: params[1], status: 'active', expires_on: '2099-12-31' }] }
        return { rows: [] }
      },
    }
    pools.push(pool)
    return pool
  }
  const client = createLicenseAdminClient({ dbConnectionString: 'postgresql://user:secret@example.invalid:5432/postgres', poolFactory })
  assert.equal(pools.length, 2)
  assert.equal(pools[0].config.max, 1)
  assert.equal(pools[1].config.max, 1)

  await client.validateAgentLogin({ agentAccount: 'dv1788' })
  await client.validateMemberLogin({ memberAccount: 'Member001', verificationPassword: 'CODE001' })
  await client.validateMemberSession({ memberAccount: 'Member001', licenseId: 'license-1' })

  assert.equal(pools[0].queries.some((q) => q.sql.includes('manager_accounts') || q.sql.includes('where l.code = $1') || q.sql.includes('where l.id = $1')), false)
  assert.equal(pools[1].queries.some((q) => q.sql.includes('manager_accounts')), true)
  assert.equal(pools[1].queries.some((q) => q.sql.includes('where l.code = $1')), true)
  assert.equal(pools[1].queries.some((q) => q.sql.includes('where l.id = $1')), true)
  assert.equal(pools[1].discardedClients, pools[1].queries.length)
  assert.ok(pools[1].discardedClients > 0)
})

test('member validation audit records only schema-supported outcomes', async () => {
  const auditOutcomes = []
  const pool = { async query(sql, params = []) {
    const text = String(sql)
    if (text.includes('online_app_settings')) return { rows: [] }
    if (text.includes('where l.code = $1')) {
      if (params[0] === 'SUSPENDED') return { rows: [{ id: 's', status: 'suspended', expires_on: '2099-12-31' }] }
      if (params[0] === 'EXPIRED') return { rows: [{ id: 'e', status: 'active', expires_on: '2020-01-01' }] }
      return { rows: [] }
    }
    if (text.includes('license_validation_logs')) { auditOutcomes.push(params[3]); return { rows: [] } }
    return { rows: [] }
  } }
  const client = createLicenseAdminClient({ pool })
  await client.validateMemberLogin({ memberAccount: 'Member001', verificationPassword: 'MISSING' })
  await client.validateMemberLogin({ memberAccount: 'Member001', verificationPassword: 'SUSPENDED' })
  await client.validateMemberLogin({ memberAccount: 'Member001', verificationPassword: 'EXPIRED' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(auditOutcomes, ['missing', 'suspended', 'expired'])
})

test('creates member-bound licenses, logs admin operation, and validates exact active member/code pair', async () => {
  const queries = []
  const pool = { async query(sql, params = []) { queries.push({ sql: String(sql), params }); return fakeV046(sql, params) } }
  const client = createLicenseAdminClient({ pool })

  const created = await client.createLicense({ memberAccount: 'User1688', code: 'DVAI1688_001', agentCode: 'DVAI', durationDays: 30, adminAccount: 'DVAI' })
  assert.equal(created.ok, true)
  assert.equal(created.row.member_account, 'User1688')
  assert.ok(queries.some((q) => q.sql.includes('insert into public.members')))
  assert.ok(queries.some((q) => q.sql.includes('insert into public.admin_operation_logs')))

  const valid = await client.validateMemberLogin({ memberAccount: 'User1688', verificationPassword: 'DVAI1688_001' })
  assert.equal(valid.ok, true)
  const invalidMember = await client.validateMemberLogin({ memberAccount: 'OtherUser', verificationPassword: 'DVAI1688_001' })
  assert.equal(invalidMember.ok, false)
})

test('manages agent hierarchy through backend-only endpoints and logs deletes', async () => {
  const calls = []
  const licenseAdminClient = {
    configured: true,
    async validateAgentLogin(input) { calls.push(['login', input.agentAccount]); return { ok: true, account: { code: input.agentAccount, role: 'manager' }, agent: { code: input.agentAccount, role: 'manager' } } },
    async createAgent(input) { calls.push(['createAgent', input.code, input.role, input.parentCode, input.adminAccount]); return { ok: true, row: { code: input.code, role: input.role, parent_code: input.parentCode } } },
    async deleteAgents(input) { calls.push(['deleteAgents', input.codes, input.adminAccount]); return { ok: true, rows: input.codes.map((code) => ({ code, is_active: false })) } },
    async getCloudDataStatus() { calls.push(['cloudStatus']); return { ok: true, mtAutoLoginEnabled: false, captureSource: 'manual_or_worker', tableCount: 0 } },
  }
  const app = createApp({ autoConnect: false, licenseAdminClient })
  const login = await app.inject({ method: 'POST', url: '/api/online-license/agent-login', body: JSON.stringify({ agentAccount: 'DVAI' }) })
  const token = JSON.parse(login.body).adminSessionToken
  const create = await app.inject({ method: 'POST', url: '/api/online-license/agents', body: JSON.stringify({ code: 'A1688', role: 'agent', parentCode: 'Admin001', adminAccount: 'Evil', adminSessionToken: token }) })
  const remove = await app.inject({ method: 'POST', url: '/api/online-license/agents/delete', body: JSON.stringify({ codes: ['A1688'], adminAccount: 'Evil', adminSessionToken: token }) })
  const cloudStatus = await app.inject({ method: 'GET', url: '/api/cloud-data/status' })

  assert.equal(create.statusCode, 200)
  assert.equal(remove.statusCode, 200)
  assert.equal(JSON.parse(cloudStatus.body).mtAutoLoginEnabled, false)
  assert.deepEqual(calls, [
    ['login', 'DVAI'],
    ['login', 'DVAI'],
    ['createAgent', 'A1688', 'agent', 'Admin001', 'DVAI'],
    ['login', 'DVAI'],
    ['deleteAgents', ['A1688'], 'DVAI'],
    ['cloudStatus'],
  ])
})

function fakeV046(sql, params = []) {
  sql = String(sql)
  if (sql.includes('select role from public.agents where code = $1')) return { rows: [{ role: 'agent' }] }
  if (sql.includes('select id, name, duration_days from public.plans')) return { rows: [{ id: 'plan-1', name: params[0], duration_days: params[1] ?? 30 }] }
  if (sql.includes('select id from public.plans')) return { rows: [] }
  if (sql.includes('insert into public.plans')) return { rows: [{ id: 'plan-1', name: params[0], duration_days: params[1] }] }
  if (sql.includes('select id, code from public.agents')) return { rows: [{ id: 'agent-1', code: params[0] }] }
  if (sql.includes('insert into public.members')) return { rows: [{ id: 'member-1', account: params[0], agent_id: params[1], status: 'active' }] }
  if (sql.includes('select id from public.licenses')) return { rows: [] }
  if (sql.includes('insert into public.licenses')) return { rows: [{ id: 'license-1', code: params[0], member_account: params[1], agent_id: params[2], plan_id: params[3], starts_on: params[4], expires_on: params[5], status: 'active' }] }
  if (sql.includes('insert into public.admin_operation_logs')) return { rows: [{ id: 'log-1' }] }
  if (sql.includes('from public.licenses l') && sql.includes('where l.code = $1')) {
    const member = params[1]
    return { rows: member === 'User1688' ? [{ id: 'license-1', code: params[0], member_account: member, status: 'active', expires_on: '2099-12-31', agent_code: 'DVAI', plan_name: '正式月卡' }] : [] }
  }
  if (sql.includes('insert into public.license_validation_logs')) return { rows: [{ id: 'validation-1' }] }
  return { rows: [] }
}
