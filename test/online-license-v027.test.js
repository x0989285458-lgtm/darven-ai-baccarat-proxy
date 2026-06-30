import test from 'node:test'
import assert from 'node:assert/strict'
import { createLicenseAdminClient, hashManagerPassword } from '../src/license-admin.js'
import { createApp } from '../src/server.js'

test('v027 hashes manager passwords with random salt and verifies stable output shape', () => {
  const first = hashManagerPassword('Dv1788-demo-pass')
  const second = hashManagerPassword('Dv1788-demo-pass')
  assert.match(first.salt, /^[a-f0-9]{32}$/)
  assert.match(first.hash, /^[a-f0-9]{64}$/)
  assert.notEqual(first.salt, second.salt)
  assert.notEqual(first.hash, second.hash)
})

test('v027 license admin bootstraps total manager and default plan through backend-only SQL', async () => {
  const queries = []
  const pool = { async query(sql, params = []) { queries.push({ sql, params }); return fakeResult(sql, params) } }
  const client = createLicenseAdminClient({ pool })
  const result = await client.bootstrap({ username: 'Dv1788', password: 'safe-pass', planName: '正式月卡', durationDays: 30 })
  assert.equal(result.ok, true)
  assert.equal(result.manager.username, 'Dv1788')
  assert.equal(result.plan.name, '正式月卡')
  assert.ok(queries.some((q) => q.sql.includes('insert into public.manager_accounts')))
  assert.ok(queries.some((q) => q.sql.includes('insert into public.plans')))
  const managerInsert = queries.find((q) => q.sql.includes('insert into public.manager_accounts'))
  assert.equal(managerInsert.params[3], 'total')
})

test('v027 license admin creates agent and license rows without frontend secrets', async () => {
  const queries = []
  const pool = { async query(sql, params = []) { queries.push({ sql, params }); return fakeResult(sql, params) } }
  const client = createLicenseAdminClient({ pool })
  const agent = await client.createAgent({ code: 'AG001', name: '主代理' })
  const license = await client.createLicense({ code: 'AG001_001', agentCode: 'AG001', planName: '正式月卡', durationDays: 30 })
  assert.equal(agent.row.code, 'AG001')
  assert.equal(license.row.code, 'AG001_001')
  assert.ok(queries.some((q) => q.sql.includes('insert into public.agents')))
  assert.ok(queries.some((q) => q.sql.includes('insert into public.licenses')))
})

test('v027 server exposes online license status and bootstrap endpoints', async () => {
  const calls = []
  const licenseAdminClient = {
    configured: true,
    async getStatus() { calls.push('status'); return { managers: [], agents: [], plans: [], licenses: [] } },
    async bootstrap(input) { calls.push(['bootstrap', input.username]); return { ok: true, manager: { username: input.username }, plan: { name: input.planName } } },
  }
  const app = createApp({ autoConnect: false, licenseAdminClient })
  const status = await app.inject({ method: 'GET', url: '/api/online-license/status' })
  const bootstrap = await app.inject({ method: 'POST', url: '/api/online-license/bootstrap', body: JSON.stringify({ username: 'Dv1788', password: 'safe-pass', planName: '正式月卡', durationDays: 30 }) })
  assert.equal(status.statusCode, 200)
  assert.equal(bootstrap.statusCode, 200)
  assert.deepEqual(calls, ['status', ['bootstrap', 'Dv1788']])
})

function fakeResult(sql, params) {
  if (sql.includes('select id from public.manager_accounts')) return { rows: [] }
  if (sql.includes('select id from public.plans')) return { rows: [] }
  if (sql.includes('select id from public.agents')) return { rows: [] }
  if (sql.includes('select id from public.licenses')) return { rows: [] }
  if (sql.includes('select id, name, duration_days from public.plans')) return { rows: [{ id: 'plan-1', name: params[0], duration_days: params[1] ?? 30 }] }
  if (sql.includes('select id, code from public.agents')) return { rows: [{ id: 'agent-1', code: params[0] }] }
  if (sql.includes('manager_accounts')) return { rows: [{ id: 'manager-1', username: params[0], role: params[3], is_active: true }] }
  if (sql.includes('plans')) return { rows: [{ id: 'plan-1', name: params[0], duration_days: params[1] }] }
  if (sql.includes('agents')) return { rows: [{ id: 'agent-1', code: params[0], name: params[1] }] }
  if (sql.includes('licenses')) return { rows: [{ id: 'license-1', code: params[0], agent_id: params[1], expires_on: params[4], status: 'active' }] }
  return { rows: [] }
}
