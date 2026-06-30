import crypto from 'node:crypto'
import pg from 'pg'

export function createLicenseAdminClient({ dbConnectionString, pool = null } = {}) {
  const resolvedConnectionString = dbConnectionString ?? process.env.SUPABASE_DB_CONNECTION_STRING
  const configured = Boolean(pool || resolvedConnectionString)
  const db = pool ?? (resolvedConnectionString ? new pg.Pool({ connectionString: resolvedConnectionString, ssl: { rejectUnauthorized: false }, max: 2 }) : null)

  async function getStatus() {
    if (!configured) return { configured: false, managers: [], agents: [], plans: [], licenses: [] }
    const [managers, agents, plans, licenses] = await Promise.all([
      db.query('select id, username, role, is_active, created_at from public.manager_accounts order by created_at desc limit 50'),
      db.query('select id, code, name, created_at from public.agents order by created_at desc limit 50'),
      db.query('select id, name, duration_days, created_at from public.plans order by duration_days asc limit 50'),
      db.query(`select l.id, l.code, l.status, l.starts_on, l.expires_on, a.code as agent_code, p.name as plan_name
                from public.licenses l
                join public.agents a on a.id = l.agent_id
                left join public.plans p on p.id = l.plan_id
                where l.status <> 'expired'
                order by l.created_at desc limit 50`),
    ])
    return { configured: true, managers: managers.rows, agents: agents.rows, plans: plans.rows, licenses: licenses.rows }
  }

  async function bootstrap({ username = 'Dv1788', password, planName = '正式月卡', durationDays = 30 } = {}) {
    if (!configured) return { skipped: true, reason: 'Supabase DB connection is not configured' }
    if (!password || String(password).length < 8) throw new Error('Password must be at least 8 characters')
    const plan = await upsertPlan({ name: planName, durationDays })
    const { salt, hash } = hashManagerPassword(password)
    const existingManager = await db.query('select id from public.manager_accounts where username = $1 limit 1', [username])
    const managerResult = existingManager.rows[0]
      ? await db.query(
        `update public.manager_accounts set username_key = lower($1), password_salt = $2, password_hash = $3, role = $4, is_active = true, updated_at = now()
         where username = $1 returning id, username, role, is_active, created_at`,
        [username, salt, hash, 'total'],
      )
      : await db.query(
        `insert into public.manager_accounts(username, username_key, password_salt, password_hash, role, is_active)
         values ($1, lower($1), $2, $3, $4, true)
         returning id, username, role, is_active, created_at`,
        [username, salt, hash, 'total'],
      )
    return { ok: true, manager: managerResult.rows[0], plan }
  }

  async function upsertPlan({ name = '正式月卡', durationDays = 30 } = {}) {
    const existing = await db.query('select id from public.plans where name = $1 limit 1', [name])
    const result = existing.rows[0]
      ? await db.query('update public.plans set duration_days = $2 where name = $1 returning id, name, duration_days', [name, Number(durationDays)])
      : await db.query('insert into public.plans(name, duration_days) values ($1, $2) returning id, name, duration_days', [name, Number(durationDays)])
    return result.rows[0]
  }

  async function createAgent({ code, name } = {}) {
    if (!configured) return { skipped: true, reason: 'Supabase DB connection is not configured' }
    if (!code || !name) throw new Error('Agent code and name are required')
    const existing = await db.query('select id from public.agents where code = $1 limit 1', [code])
    const result = existing.rows[0]
      ? await db.query('update public.agents set name = $2 where code = $1 returning id, code, name, created_at', [code, name])
      : await db.query('insert into public.agents(code, name) values ($1, $2) returning id, code, name, created_at', [code, name])
    return { ok: true, row: result.rows[0] }
  }

  async function createLicense({ code, agentCode, planName = '正式月卡', durationDays = 30, startsOn = todayIso() } = {}) {
    if (!configured) return { skipped: true, reason: 'Supabase DB connection is not configured' }
    if (!code || !agentCode) throw new Error('License code and agentCode are required')
    const plan = await getOrCreatePlan({ name: planName, durationDays })
    const agent = await getAgentByCode(agentCode)
    if (!agent) throw new Error(`Agent ${agentCode} not found`)
    const expiresOn = addDaysIso(startsOn, plan.duration_days)
    const existing = await db.query('select id from public.licenses where code = $1 limit 1', [code])
    const result = existing.rows[0]
      ? await db.query(
        `update public.licenses set agent_id = $2, plan_id = $3, starts_on = $4, expires_on = $5, status = 'active', updated_at = now()
         where code = $1 returning id, code, agent_id, plan_id, starts_on, expires_on, status`,
        [code, agent.id, plan.id, startsOn, expiresOn],
      )
      : await db.query(
        `insert into public.licenses(code, agent_id, plan_id, starts_on, expires_on, status)
         values ($1, $2, $3, $4, $5, 'active')
         returning id, code, agent_id, plan_id, starts_on, expires_on, status`,
        [code, agent.id, plan.id, startsOn, expiresOn],
      )
    return { ok: true, row: result.rows[0] }
  }

  async function setLicenseStatus({ code, status, adminAccount = 'DV1788' } = {}) {
    if (!configured) return { skipped: true, reason: 'Supabase DB connection is not configured' }
    await assertTotalManager(adminAccount)
    if (!code || !status) throw new Error('License code and status are required')
    const result = await db.query(
      `update public.licenses set status = $2, updated_at = now() where code = $1 returning id, code, status, expires_on`,
      [code, status],
    )
    return { ok: true, row: result.rows[0] ?? null }
  }

  async function extendLicense({ code, days = 30, adminAccount = 'DV1788' } = {}) {
    if (!configured) return { skipped: true, reason: 'Supabase DB connection is not configured' }
    await assertTotalManager(adminAccount)
    if (!code) throw new Error('License code is required')
    const result = await db.query(
      `update public.licenses set expires_on = expires_on + ($2::int * interval '1 day'), updated_at = now() where code = $1 returning id, code, status, expires_on`,
      [code, Number(days)],
    )
    return { ok: true, row: result.rows[0] ?? null }
  }

  async function deleteLicense({ code, adminAccount = 'DV1788' } = {}) {
    if (!configured) return { skipped: true, reason: 'Supabase DB connection is not configured' }
    await assertTotalManager(adminAccount)
    if (!code) throw new Error('License code is required')
    const result = await db.query(
      `update public.licenses set status = 'expired', updated_at = now() where code = $1 returning id, code, status, expires_on`,
      [code],
    )
    return { ok: true, row: result.rows[0] ?? null }
  }

  async function assertTotalManager(adminAccount) {
    const result = await db.query('select id, username, role, is_active from public.manager_accounts where username = $1 and is_active = true limit 1', [adminAccount])
    const manager = result.rows[0]
    if (!manager || manager.role !== 'total') throw new Error('Operation requires total manager permission')
    return manager
  }

  async function getOrCreatePlan({ name, durationDays }) {
    const existing = await db.query('select id, name, duration_days from public.plans where name = $1 limit 1', [name])
    if (existing.rows[0]) return existing.rows[0]
    return upsertPlan({ name, durationDays })
  }

  async function getAgentByCode(code) {
    const result = await db.query('select id, code from public.agents where code = $1 limit 1', [code])
    return result.rows[0] ?? null
  }

  async function validateMemberLogin({ memberAccount, verificationPassword } = {}) {
    if (!configured) return { skipped: true, reason: 'Supabase DB connection is not configured' }
    if (!memberAccount || !verificationPassword) throw new Error('Member account and verification password are required')
    const result = await db.query(
      `select l.id, l.code, l.status, l.expires_on, a.code as agent_code, p.name as plan_name
       from public.licenses l
       join public.agents a on a.id = l.agent_id
       left join public.plans p on p.id = l.plan_id
       where l.code = $1
       limit 1`,
      [verificationPassword],
    )
    const license = result.rows[0] ?? null
    const ok = Boolean(license && license.status === 'active' && String(license.expires_on) >= todayIso())
    await db.query(
      'insert into public.license_validation_logs(license_id, submitted_code, result) values ($1, $2, $3)',
      [license?.id ?? null, verificationPassword, ok ? 'valid' : 'invalid'],
    )
    return { ok, memberAccount, license }
  }

  async function validateAgentLogin({ agentAccount } = {}) {
    if (!configured) return { skipped: true, reason: 'Supabase DB connection is not configured' }
    if (!agentAccount) throw new Error('Agent account is required')
    const result = await db.query('select id, code, name, created_at from public.agents where code = $1 limit 1', [agentAccount])
    const agent = result.rows[0] ?? null
    if (agent) return { ok: true, agent, account: { ...agent, type: 'agent', permission: 'agent' } }
    const managerResult = await db.query('select id, username, role, is_active, created_at from public.manager_accounts where username = $1 and is_active = true limit 1', [agentAccount])
    const manager = managerResult.rows[0] ?? null
    if (!manager) return { ok: false, agent: null, account: null }
    return { ok: true, agent: null, account: { ...manager, type: 'manager', permission: manager.role === 'total' ? 'all' : 'limited' } }
  }

  return { configured, getStatus, bootstrap, createAgent, createLicense, setLicenseStatus, extendLicense, deleteLicense, validateMemberLogin, validateAgentLogin }
}

export function hashManagerPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256').toString('hex')
  return { salt, hash }
}

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

function addDaysIso(dateText, days) {
  const date = new Date(`${dateText}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + Number(days))
  return date.toISOString().slice(0, 10)
}
