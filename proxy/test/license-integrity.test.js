import test from 'node:test'
import assert from 'node:assert/strict'
import { createLicenseAdminClient } from '../src/license-admin.js'

function makeCreatePool({ existingLicense = null } = {}) {
  const queries = []
  const pool = {
    async query(sql, params = []) {
      sql = String(sql)
      queries.push({ sql, params })
      if (sql.includes('select id, name, duration_days from public.plans')) {
        if (params[0] === '正式月卡') return { rows: [{ id: 'plan-30', name: '正式月卡', duration_days: 30 }] }
        return { rows: [] }
      }
      if (sql.includes('insert into public.plans')) return { rows: [{ id: 'plan-10', name: params[0], duration_days: params[1] }] }
      if (sql.includes('select id, code from public.agents')) return { rows: [{ id: 'agent-1', code: params[0] }] }
      if (sql.includes('from public.licenses l') && sql.includes('where l.code = $1')) return { rows: existingLicense ? [existingLicense] : [] }
      if (sql.includes('insert into public.members')) return { rows: [{ id: 'member-1', account: params[0], agent_id: params[1], status: 'active' }] }
      if (sql.includes('insert into public.licenses')) return { rows: [{ id: 'license-new', code: params[0], member_account: params[1], agent_id: params[2], plan_id: params[3], starts_on: params[4], expires_on: params[5], status: 'active' }] }
      if (sql.includes('insert into public.admin_operation_logs')) return { rows: [{ id: 'log-1' }] }
      return { rows: [] }
    },
  }
  return { pool, queries }
}

test('requested 10 days creates a duration-specific plan beside an existing 30-day plan', async () => {
  const { pool, queries } = makeCreatePool()
  const client = createLicenseAdminClient({ pool })
  const result = await client.createLicense({ memberAccount: 'MemberA', code: 'dv8888_001', agentCode: 'dv1788-Raylo888', durationDays: 10, startsOn: '2026-07-16', adminAccount: 'dv1788' })

  assert.equal(result.row.starts_on, '2026-07-16')
  assert.equal(result.row.expires_on, '2026-07-26')
  assert.equal(result.durationDays, 10)
  const planInsert = queries.find(({ sql }) => sql.includes('insert into public.plans'))
  assert.ok(planInsert)
  assert.deepEqual(planInsert.params, ['正式月卡-10天', 10])
  assert.ok(!queries.some(({ sql }) => /update public\.plans/i.test(sql)))
})

test('license duration must be an integer from 1 through 30', async () => {
  const client = createLicenseAdminClient({ pool: { async query() { throw new Error('validation must happen before SQL') } } })
  for (const durationDays of [0, 31, 1.5, '10']) {
    await assert.rejects(
      () => client.createLicense({ memberAccount: 'MemberA', code: 'dv8888_001', agentCode: 'dv1788-Raylo888', durationDays, adminAccount: 'dv1788' }),
      (error) => error.statusCode === 400 && /integer from 1 through 30/i.test(error.message),
    )
  }
})

test('same code and exact member agent duration is idempotent without changing expiry', async () => {
  const existingLicense = { id: 'license-1', code: 'dv8888_001', member_account: 'MemberA', agent_id: 'agent-1', agent_code: 'dv1788-Raylo888', plan_id: 'plan-10', duration_days: 10, starts_on: '2026-07-16', expires_on: '2026-07-26', status: 'active' }
  const { pool, queries } = makeCreatePool({ existingLicense })
  const client = createLicenseAdminClient({ pool })
  const result = await client.createLicense({ memberAccount: 'MemberA', code: 'dv8888_001', agentCode: 'dv1788-Raylo888', durationDays: 10, startsOn: '2026-07-16', adminAccount: 'dv1788' })

  assert.equal(result.idempotent, true)
  assert.deepEqual(result.row, existingLicense)
  assert.ok(!queries.some(({ sql }) => /update public\.licenses/i.test(sql)))
  assert.ok(!queries.some(({ sql }) => sql.includes('insert into public.licenses')))
})

test('same code for another member returns 409 and never updates the existing license', async () => {
  const existingLicense = { id: 'license-1', code: 'dv8888_001', member_account: 'MemberA', agent_id: 'agent-1', agent_code: 'dv1788-Raylo888', plan_id: 'plan-10', duration_days: 10, starts_on: '2026-07-16', expires_on: '2026-07-26', status: 'active' }
  const { pool, queries } = makeCreatePool({ existingLicense })
  const client = createLicenseAdminClient({ pool })

  await assert.rejects(
    () => client.createLicense({ memberAccount: 'MemberB', code: 'dv8888_001', agentCode: 'dv1788-Raylo888', durationDays: 10, startsOn: '2026-07-16', adminAccount: 'dv1788' }),
    (error) => error.statusCode === 409,
  )
  assert.ok(!queries.some(({ sql }) => /update public\.licenses/i.test(sql)))
})

test('status preserves two distinct member licenses', async () => {
  const licenses = [
    { id: 'l1', code: 'dv8888_001', member_account: 'MemberA', status: 'active', starts_on: '2026-07-16', expires_on: '2026-07-26', agent_code: 'dv1788-Raylo888', plan_name: '正式月卡-10天' },
    { id: 'l2', code: 'dv8888_002', member_account: 'MemberB', status: 'active', starts_on: '2026-07-16', expires_on: '2026-07-26', agent_code: 'dv1788-Raylo888', plan_name: '正式月卡-10天' },
  ]
  const pool = { async query(sql) {
    sql = String(sql)
    if (sql.includes('from public.licenses l')) return { rows: licenses }
    return { rows: [] }
  } }
  const status = await createLicenseAdminClient({ pool }).getStatus({ adminAccount: 'dv1788' })
  assert.deepEqual(status.licenseRows.map(({ member, code }) => ({ member, code })), [
    { member: 'MemberA', code: 'dv8888_001' },
    { member: 'MemberB', code: 'dv8888_002' },
  ])
})

test('status reserves every scoped code including expired while hiding expired rows', async () => {
  const agents = [
    { code: 'manager-a', parent_code: 'dv1788', role: 'manager' },
    { code: 'agent-a', parent_code: 'manager-a', role: 'agent' },
    { code: 'agent-b', parent_code: 'manager-b', role: 'agent' },
  ]
  const licenses = [
    { code: 'dv8888_002', member_account: 'ActiveA', status: 'active', agent_code: 'agent-a' },
    { code: 'dv8888_001', member_account: 'ExpiredA', status: 'expired', agent_code: 'agent-a' },
    { code: 'dv8888_003', member_account: 'ExpiredManager', status: 'expired', agent_code: 'manager-a' },
    { code: 'dv8888_999', member_account: 'OtherScope', status: 'expired', agent_code: 'agent-b' },
  ]
  const pool = { async query(sql) {
    sql = String(sql)
    if (sql.includes('from public.agents')) return { rows: agents }
    if (sql.includes('from public.licenses l')) return { rows: sql.includes("l.status <> 'expired'") ? licenses.filter((row) => row.status !== 'expired') : licenses }
    return { rows: [] }
  } }

  const status = await createLicenseAdminClient({ pool }).getStatus({ adminAccount: 'manager-a' })
  assert.deepEqual(status.licenseRows.map((row) => row.code), ['dv8888_002'])
  assert.deepEqual(status.licenses.map((row) => row.code), ['dv8888_002'])
  assert.deepEqual(status.usedLicenseCodes, ['dv8888_002', 'dv8888_001', 'dv8888_003'])
})

test('a raced license unique violation becomes 409 without updating or overwriting a historical row', async () => {
  const { pool, queries } = makeCreatePool()
  const originalQuery = pool.query.bind(pool)
  pool.query = async (sql, params = []) => {
    if (String(sql).includes('insert into public.licenses')) {
      const error = new Error('duplicate key value violates unique constraint')
      error.code = '23505'
      throw error
    }
    return originalQuery(sql, params)
  }
  const client = createLicenseAdminClient({ pool })

  await assert.rejects(
    () => client.createLicense({ memberAccount: 'MemberB', code: 'dv8888_001', agentCode: 'dv1788-Raylo888', durationDays: 10, startsOn: '2026-07-16', adminAccount: 'dv1788' }),
    (error) => error.statusCode === 409,
  )
  assert.ok(!queries.some(({ sql }) => /update public\.licenses/i.test(sql)))
})
