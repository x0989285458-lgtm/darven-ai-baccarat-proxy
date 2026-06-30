import test from 'node:test'
import assert from 'node:assert/strict'
import { createLicenseAdminClient } from '../src/license-admin.js'

test('v029 admin login accepts DV1788 manager account as total super account', async () => {
  const queries = []
  const pool = { async query(sql, params = []) { queries.push({ sql, params }); return fakeResult(sql, params) } }
  const client = createLicenseAdminClient({ pool })
  const result = await client.validateAgentLogin({ agentAccount: 'DV1788' })
  assert.equal(result.ok, true)
  assert.equal(result.account.username, 'DV1788')
  assert.equal(result.account.role, 'total')
  assert.equal(result.account.permission, 'all')
  assert.ok(queries.some((q) => q.sql.includes('from public.manager_accounts')))
})

function fakeResult(sql, params) {
  if (sql.includes('from public.agents')) return { rows: [] }
  if (sql.includes('from public.manager_accounts')) return { rows: [{ id: 'manager-1', username: params[0], role: 'total', is_active: true }] }
  return { rows: [] }
}
