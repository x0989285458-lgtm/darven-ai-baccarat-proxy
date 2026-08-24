import test from 'node:test'
import assert from 'node:assert/strict'
import { createLicenseAdminClient, hashManagerPassword } from '../src/license-admin.js'
import { createApp } from '../src/server.js'

test('hashes manager passwords with random salt and verifies stable output shape', () => {
  const first = hashManagerPassword('Dv1788-demo-pass')
  const second = hashManagerPassword('Dv1788-demo-pass')
  assert.match(first.salt, /^[a-f0-9]{32}$/)
  assert.match(first.hash, /^[a-f0-9]{64}$/)
  assert.notEqual(first.salt, second.salt)
  assert.notEqual(first.hash, second.hash)
})

test('license database pool bounds connection and query stalls', () => {
  let options
  createLicenseAdminClient({
    dbConnectionString: 'postgresql://test:***@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres',
    poolFactory(value) { options = value; return { query: async () => ({ rows: [] }) } },
  })
  assert.equal(new URL(options.connectionString).port, '6543')
  assert.equal(options.connectionTimeoutMillis, 9000)
  assert.equal(options.max, 1)
  assert.equal(options.query_timeout, 9000)
  assert.equal(options.statement_timeout, 8500)
})

test('concurrent authentication connection failures rebuild one owned pool and retry exact queries once', async () => {
  const pools = []
  let releaseOldFailures
  const oldFailures = new Promise((resolve) => { releaseOldFailures = resolve })
  const poolFactory = () => {
    const index = pools.length
    const pool = {
      ended: 0,
      listeners: [],
      calls: [],
      on(event, handler) { this.listeners.push({ event, handler }) },
      async end() { this.ended += 1 },
      async query(sql, params) {
        this.calls.push({ sql, params })
        if (index === 1) {
          await oldFailures
          throw new Error('Connection terminated due to connection timeout')
        }
        if (index === 2) return { rows: [{ id: 'manager-1', username: params[0], role: 'total', is_active: true }] }
        return { rows: [] }
      },
    }
    pools.push(pool)
    return pool
  }
  const client = createLicenseAdminClient({ dbConnectionString: 'postgresql://test:***@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres', poolFactory })
  const first = client.validateAgentLogin({ agentAccount: 'dv1788' })
  const second = client.validateAgentLogin({ agentAccount: 'DV1788' })
  while (pools[1].calls.length < 2) await new Promise((resolve) => setTimeout(resolve, 0))
  releaseOldFailures()
  const results = await Promise.all([first, second])
  assert.deepEqual(results.map((result) => result.ok), [true, true])
  assert.equal(pools.length, 3)
  assert.equal(pools[1].ended, 1)
  assert.deepEqual(pools[1].listeners.map(({ event }) => event), ['error'])
  assert.deepEqual(pools[2].listeners.map(({ event }) => event), ['error'])
  assert.equal(pools[2].calls.length, 2)
  assert.equal(pools[2].calls.every(({ sql }) => sql === pools[1].calls[0].sql), true)
  assert.deepEqual(pools[2].calls.map(({ params }) => params[0]).sort(), ['dv1788', 'DV1788'].sort())
})

test('authentication retry stops after the replacement pool also has a connection failure', async () => {
  const pools = []
  const poolFactory = () => {
    const index = pools.length
    const pool = {
      ended: 0, on() {}, async end() { this.ended += 1 },
      async query() {
        if (index > 0) throw new Error('Connection terminated due to connection timeout')
        return { rows: [] }
      },
    }
    pools.push(pool)
    return pool
  }
  const client = createLicenseAdminClient({ dbConnectionString: 'postgresql://test:***@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres', poolFactory })
  await assert.rejects(client.validateAgentLogin({ agentAccount: 'dv1788' }), /connection timeout/i)
  assert.equal(pools.length, 3)
  assert.equal(pools[1].ended, 1)
  assert.equal(pools[2].ended, 0)
})

test('injected shared authentication pool is never observed replaced or ended by connection retry logic', async () => {
  let listeners = 0
  let ended = 0
  let factories = 0
  const pool = {
    on() { listeners += 1 },
    async end() { ended += 1 },
    async query() { throw new Error('Connection terminated due to connection timeout') },
  }
  const client = createLicenseAdminClient({ pool, poolFactory() { factories += 1; return pool } })
  await assert.rejects(client.validateAgentLogin({ agentAccount: 'dv1788' }), /connection timeout/i)
  assert.equal(listeners, 0)
  assert.equal(ended, 0)
  assert.equal(factories, 0)
})

test('authentication query never retries a non-connection database error', async () => {
  const pools = []
  const poolFactory = () => {
    const index = pools.length
    const pool = {
      on() {}, async end() {},
      async query() {
        if (index === 1) throw Object.assign(new Error('permission denied'), { code: '42501' })
        return { rows: [] }
      },
    }
    pools.push(pool)
    return pool
  }
  const client = createLicenseAdminClient({ dbConnectionString: 'postgresql://test:***@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres', poolFactory })
  await assert.rejects(client.validateAgentLogin({ agentAccount: 'dv1788' }), /permission denied/)
  assert.equal(pools.length, 2)
})

test('successful member login does not wait for best-effort validation audit logging', async () => {
  let releaseAudit
  let auditParams
  const auditPending = new Promise((resolve) => { releaseAudit = resolve })
  const pool = {
    query(sql, params) {
      if (sql.includes('insert into public.license_validation_logs')) {
        auditParams = params
        return auditPending
      }
      return Promise.resolve({ rows: [{
        id: 'license-1', code: 'VERIFY001', member_account: 'Member001',
        status: 'active', expires_on: '2099-12-31', agent_code: 'Agent001', plan_name: '正式月卡',
      }] })
    },
  }
  const client = createLicenseAdminClient({ pool })
  const outcome = await Promise.race([
    client.validateMemberLogin({ memberAccount: 'Member001', verificationPassword: 'VERIFY001' }),
    new Promise((resolve) => setTimeout(() => resolve('blocked-by-audit'), 30)),
  ])
  releaseAudit({ rows: [] })
  assert.notEqual(outcome, 'blocked-by-audit')
  assert.equal(outcome.ok, true)
  assert.equal(auditParams[2], '[REDACTED]')
  assert.notEqual(auditParams[2], 'VERIFY001')
})

test('license admin bootstraps total manager and default plan through backend-only SQL', async () => {
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

test('license admin creates agent and license rows without frontend secrets', async () => {
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

test('server exposes online license status and bootstrap endpoints', async () => {
  const calls = []
  const licenseAdminClient = {
    configured: true,
    async validateAgentLogin(input) { calls.push(['login', input.agentAccount]); return { ok: true, account: { code: input.agentAccount, role: 'total' }, agent: null } },
    async getStatus(input) { calls.push(['status', input.adminAccount]); return { managers: [], agents: [], plans: [], licenses: [] } },
    async bootstrap(input) { calls.push(['bootstrap', input.username]); return { ok: true, manager: { username: input.username }, plan: { name: input.planName } } },
  }
  const app = createApp({ autoConnect: false, licenseAdminClient })
  const login = await app.inject({ method: 'POST', url: '/api/online-license/agent-login', body: JSON.stringify({ agentAccount: 'dv1788' }) })
  const token = JSON.parse(login.body).adminSessionToken
  const status = await app.inject({ method: 'GET', url: '/api/online-license/status', headers: { authorization: `Bearer ${token}` } })
  const unauthBootstrap = await app.inject({ method: 'POST', url: '/api/online-license/bootstrap', body: JSON.stringify({ username: 'Dv1788', password: 'safe-pass', planName: '正式月卡', durationDays: 30 }) })
  const bootstrap = await app.inject({ method: 'POST', url: '/api/online-license/bootstrap', body: JSON.stringify({ username: 'Dv1788', password: 'safe-pass', planName: '正式月卡', durationDays: 30, adminSessionToken: token }) })
  assert.equal(status.statusCode, 200)
  assert.equal(unauthBootstrap.statusCode, 401)
  assert.equal(bootstrap.statusCode, 200)
  assert.deepEqual(calls, [['login', 'dv1788'], ['login', 'dv1788'], ['status', 'dv1788'], ['login', 'dv1788'], ['bootstrap', 'Dv1788']])
})

function fakeResult(sql, params) {
  if (sql.includes('select id from public.manager_accounts')) return { rows: [] }
  if (sql.includes('select id from public.plans')) return { rows: [] }
  if (sql.includes('select id from public.agents')) return { rows: [] }
  if (sql.includes('select id from public.licenses')) return { rows: [] }
  if (sql.includes('from public.licenses l') && sql.includes('where l.code = $1')) return { rows: [] }
  if (sql.includes('select id, name, duration_days from public.plans')) return { rows: [{ id: 'plan-1', name: params[0], duration_days: params[1] ?? 30 }] }
  if (sql.includes('select id, code from public.agents')) return { rows: [{ id: 'agent-1', code: params[0] }] }
  if (sql.includes('manager_accounts')) return { rows: [{ id: 'manager-1', username: params[0], role: params[3], is_active: true }] }
  if (sql.includes('plans')) return { rows: [{ id: 'plan-1', name: params[0], duration_days: params[1] }] }
  if (sql.includes('agents')) return { rows: [{ id: 'agent-1', code: params[0], name: params[1] }] }
  if (sql.includes('licenses')) return { rows: [{ id: 'license-1', code: params[0], agent_id: params[1], expires_on: params[4], status: 'active' }] }
  return { rows: [] }
}
