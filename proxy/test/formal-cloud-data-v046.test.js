import test from 'node:test'
import assert from 'node:assert/strict'
import { createLicenseAdminClient } from '../src/license-admin.js'
import { createApp } from '../src/server.js'

test('v046 creates member-bound licenses, logs admin operation, and validates exact active member/code pair', async () => {
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

test('v046 manages agent hierarchy through backend-only endpoints and logs deletes', async () => {
  const calls = []
  const licenseAdminClient = {
    configured: true,
    async createAgent(input) { calls.push(['createAgent', input.code, input.role, input.parentCode, input.adminAccount]); return { ok: true, row: { code: input.code, role: input.role, parent_code: input.parentCode } } },
    async deleteAgents(input) { calls.push(['deleteAgents', input.codes, input.adminAccount]); return { ok: true, rows: input.codes.map((code) => ({ code, is_active: false })) } },
    async getCloudDataStatus() { calls.push(['cloudStatus']); return { ok: true, mtAutoLoginEnabled: false, captureSource: 'manual_or_worker', tableCount: 0 } },
  }
  const app = createApp({ autoConnect: false, licenseAdminClient })
  const create = await app.inject({ method: 'POST', url: '/api/online-license/agents', body: JSON.stringify({ code: 'A1688', role: 'agent', parentCode: 'Admin001', adminAccount: 'DVAI' }) })
  const remove = await app.inject({ method: 'POST', url: '/api/online-license/agents/delete', body: JSON.stringify({ codes: ['A1688'], adminAccount: 'DVAI' }) })
  const cloudStatus = await app.inject({ method: 'GET', url: '/api/cloud-data/status' })

  assert.equal(create.statusCode, 200)
  assert.equal(remove.statusCode, 200)
  assert.equal(JSON.parse(cloudStatus.body).mtAutoLoginEnabled, false)
  assert.deepEqual(calls, [
    ['createAgent', 'A1688', 'agent', 'Admin001', 'DVAI'],
    ['deleteAgents', ['A1688'], 'DVAI'],
    ['cloudStatus'],
  ])
})

function fakeV046(sql, params = []) {
  sql = String(sql)
  if (sql.includes('manager_accounts where username = $1')) return { rows: [{ id: 'manager-1', username: params[0], role: 'total', is_active: true }] }
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
