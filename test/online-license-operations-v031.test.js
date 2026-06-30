import test from 'node:test'
import assert from 'node:assert/strict'
import { createLicenseAdminClient } from '../src/license-admin.js'
import { createApp } from '../src/server.js'

test('v031 total manager can suspend extend and delete a license, non-total manager is rejected', async () => {
  const queries = []
  const pool = { async query(sql, params = []) { queries.push({ sql, params }); return fakeResult(sql, params) } }
  const client = createLicenseAdminClient({ pool })

  await assert.rejects(() => client.setLicenseStatus({ code: 'DVAI1788_001', status: 'suspended', adminAccount: 'Agent001' }), /total manager permission/)

  const suspended = await client.setLicenseStatus({ code: 'DVAI1788_001', status: 'suspended', adminAccount: 'DV1788' })
  const extended = await client.extendLicense({ code: 'DVAI1788_001', days: 15, adminAccount: 'DV1788' })
  const deleted = await client.deleteLicense({ code: 'DVAI1788_001', adminAccount: 'DV1788' })

  assert.equal(suspended.row.status, 'suspended')
  assert.equal(extended.row.code, 'DVAI1788_001')
  assert.equal(deleted.row.status, 'expired')
  assert.ok(queries.some((q) => q.sql.includes("set status = 'expired'")))
})

test('v031 status hides deleted licenses from admin list', async () => {
  const pool = { async query(sql, params = []) { return fakeResult(sql, params) } }
  const client = createLicenseAdminClient({ pool })
  const status = await client.getStatus()
  assert.equal(status.licenses.length, 1)
  assert.equal(status.licenses[0].code, 'DVAI1788_001')
})

test('v031 server exposes backend-only license operation endpoints', async () => {
  const calls = []
  const licenseAdminClient = {
    configured: true,
    async setLicenseStatus(input) { calls.push(['status', input.code, input.status, input.adminAccount]); return { ok: true, row: { code: input.code, status: input.status } } },
    async extendLicense(input) { calls.push(['extend', input.code, input.days, input.adminAccount]); return { ok: true, row: { code: input.code, expires_on: '2026-08-28' } } },
    async deleteLicense(input) { calls.push(['delete', input.code, input.adminAccount]); return { ok: true, row: { code: input.code, status: 'expired' } } },
  }
  const app = createApp({ autoConnect: false, licenseAdminClient })
  const suspend = await app.inject({ method: 'POST', url: '/api/online-license/licenses/status', body: JSON.stringify({ code: 'DVAI1788_001', status: 'suspended', adminAccount: 'DV1788' }) })
  const extend = await app.inject({ method: 'POST', url: '/api/online-license/licenses/extend', body: JSON.stringify({ code: 'DVAI1788_001', days: 15, adminAccount: 'DV1788' }) })
  const remove = await app.inject({ method: 'POST', url: '/api/online-license/licenses/delete', body: JSON.stringify({ code: 'DVAI1788_001', adminAccount: 'DV1788' }) })

  assert.equal(suspend.statusCode, 200)
  assert.equal(extend.statusCode, 200)
  assert.equal(remove.statusCode, 200)
  assert.deepEqual(calls, [
    ['status', 'DVAI1788_001', 'suspended', 'DV1788'],
    ['extend', 'DVAI1788_001', 15, 'DV1788'],
    ['delete', 'DVAI1788_001', 'DV1788'],
  ])
})

function fakeResult(sql, params) {
  if (sql.includes('manager_accounts where username = $1')) {
    if (params[0] === 'DV1788') return { rows: [{ id: 'manager-1', username: 'DV1788', role: 'total', is_active: true }] }
    return { rows: [{ id: 'manager-2', username: params[0], role: 'limited', is_active: true }] }
  }
  if (sql.includes('from public.manager_accounts order')) return { rows: [{ id: 'manager-1', username: 'DV1788', role: 'total', is_active: true }] }
  if (sql.includes('from public.agents order')) return { rows: [{ id: 'agent-1', code: 'DVAI', name: 'DV1788超級代理' }] }
  if (sql.includes('from public.plans order')) return { rows: [{ id: 'plan-1', name: '正式月卡', duration_days: 30 }] }
  if (sql.includes('from public.licenses l')) return { rows: [{ id: 'license-1', code: 'DVAI1788_001', status: 'active', expires_on: '2099-12-31', agent_code: 'DVAI', plan_name: '正式月卡' }] }
  if (sql.includes('set status = $2')) return { rows: [{ id: 'license-1', code: params[0], status: params[1], expires_on: '2099-12-31' }] }
  if (sql.includes('expires_on = expires_on')) return { rows: [{ id: 'license-1', code: params[0], status: 'active', expires_on: '2100-01-15' }] }
  if (sql.includes("set status = 'expired'")) return { rows: [{ id: 'license-1', code: params[0], status: 'expired', expires_on: '2100-01-15' }] }
  return { rows: [] }
}
