import crypto from 'node:crypto'
import pg from 'pg'

export function createLicenseAdminClient({ dbConnectionString, pool = null } = {}) {
  const resolvedConnectionString = dbConnectionString ?? process.env.SUPABASE_DB_CONNECTION_STRING
  const configured = Boolean(pool || resolvedConnectionString)
  const db = pool ?? (resolvedConnectionString ? new pg.Pool({ connectionString: resolvedConnectionString, ssl: { rejectUnauthorized: false }, max: 2 }) : null)

  async function getStatus() {
    if (!configured) return { configured: false, managers: [], agents: [], plans: [], licenses: [], agentRows: [], licenseRows: [] }
    const [managers, agents, plans, licenses] = await Promise.all([
      db.query('select id, username, role, is_active, created_at from public.manager_accounts order by created_at desc limit 50'),
      db.query(`select id, code, name, role, parent_code, is_active, permission, created_at
                from public.agents where coalesce(is_active, true) = true order by created_at desc limit 100`),
      db.query('select id, name, duration_days, created_at from public.plans order by duration_days asc limit 50'),
      db.query(`select l.id, l.code, l.member_account, l.status, l.starts_on, l.expires_on, a.code as agent_code, p.name as plan_name
                from public.licenses l
                join public.agents a on a.id = l.agent_id
                left join public.plans p on p.id = l.plan_id
                where l.status <> 'expired'
                order by l.created_at desc limit 100`),
    ])
    return {
      configured: true,
      managers: managers.rows,
      agents: agents.rows,
      plans: plans.rows,
      licenses: licenses.rows,
      agentRows: buildAgentRows(agents.rows),
      licenseRows: licenses.rows.map((license, index) => ({
        member: license.member_account ?? `User${String(index + 1).padStart(3, '0')}`,
        code: license.code,
        status: license.status === 'active' ? '啟用中' : license.status === 'suspended' ? '暫停中' : '已過期',
        remain: formatRemain(license.expires_on),
        expiresOn: dateOnly(license.expires_on),
        agentCode: license.agent_code,
      })),
    }
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
    await logAdminOperation({ adminAccount: username, action: 'bootstrap', targetType: 'manager', targetCode: username, payload: { planName, durationDays } })
    return { ok: true, manager: managerResult.rows[0], plan }
  }

  async function upsertPlan({ name = '正式月卡', durationDays = 30 } = {}) {
    const existing = await db.query('select id from public.plans where name = $1 limit 1', [name])
    const result = existing.rows[0]
      ? await db.query('update public.plans set duration_days = $2 where name = $1 returning id, name, duration_days', [name, Number(durationDays)])
      : await db.query('insert into public.plans(name, duration_days) values ($1, $2) returning id, name, duration_days', [name, Number(durationDays)])
    return result.rows[0]
  }

  async function createAgent({ code, name, role = 'agent', parentCode = null, permission = '可建碼', adminAccount = 'DVAI' } = {}) {
    if (!configured) return { skipped: true, reason: 'Supabase DB connection is not configured' }
    if (!code) throw new Error('Agent code is required')
    const displayName = name || code
    const existing = await db.query('select id from public.agents where code = $1 limit 1', [code])
    const result = existing.rows[0]
      ? await db.query(`update public.agents set name = $2, role = $3, parent_code = $4, permission = $5, is_active = true, updated_at = now()
                       where code = $1 returning id, code, name, role, parent_code, permission, is_active, created_at`, [code, displayName, role, parentCode, permission])
      : await db.query(`insert into public.agents(code, name, role, parent_code, permission, is_active)
                       values ($1, $2, $3, $4, $5, true)
                       returning id, code, name, role, parent_code, permission, is_active, created_at`, [code, displayName, role, parentCode, permission])
    await logAdminOperation({ adminAccount, action: 'create_agent', targetType: 'agent', targetCode: code, payload: { role, parentCode, permission } })
    return { ok: true, row: result.rows[0] }
  }

  async function deleteAgents({ codes = [], adminAccount = 'DVAI' } = {}) {
    if (!configured) return { skipped: true, reason: 'Supabase DB connection is not configured' }
    const list = Array.isArray(codes) ? codes.filter(Boolean) : []
    if (!list.length) throw new Error('Agent codes are required')
    const result = await db.query(`update public.agents set is_active = false, updated_at = now()
                                  where code = any($1::text[])
                                  returning id, code, name, role, parent_code, is_active`, [list])
    await logAdminOperation({ adminAccount, action: 'delete_agents', targetType: 'agent', targetCode: list.join(','), payload: { codes: list } })
    return { ok: true, rows: result.rows }
  }

  async function createLicense({ memberAccount, code, agentCode, planName = '正式月卡', durationDays = 30, startsOn = todayIso(), adminAccount = 'DVAI' } = {}) {
    if (!configured) return { skipped: true, reason: 'Supabase DB connection is not configured' }
    if (!code || !agentCode) throw new Error('license code and agentCode are required')
    const resolvedMemberAccount = memberAccount || `User${String(code).match(/(\d+)/)?.[1]?.slice(-4)?.padStart(4, '0') ?? '0001'}`
    const plan = await getOrCreatePlan({ name: planName, durationDays })
    const agent = await getOrCreateAgentByCode(agentCode)
    const member = await upsertMember({ account: resolvedMemberAccount, agentId: agent.id })
    const expiresOn = addDaysIso(startsOn, plan.duration_days)
    const existing = await db.query('select id from public.licenses where code = $1 limit 1', [code])
    const result = existing.rows[0]
      ? await db.query(
        `update public.licenses set member_account = $2, agent_id = $3, plan_id = $4, starts_on = $5, expires_on = $6, status = 'active', updated_at = now()
         where code = $1 returning id, code, member_account, agent_id, plan_id, starts_on, expires_on, status`,
        [code, member.account, agent.id, plan.id, startsOn, expiresOn],
      )
      : await db.query(
        `insert into public.licenses(code, member_account, agent_id, plan_id, starts_on, expires_on, status)
         values ($1, $2, $3, $4, $5, $6, 'active')
         returning id, code, member_account, agent_id, plan_id, starts_on, expires_on, status`,
        [code, member.account, agent.id, plan.id, startsOn, expiresOn],
      )
    await logAdminOperation({ adminAccount, action: 'create_license', targetType: 'license', targetCode: code, payload: { memberAccount: resolvedMemberAccount, agentCode, durationDays } })
    return { ok: true, row: result.rows[0] }
  }

  async function setLicenseStatus({ code, status, adminAccount = 'DVAI' } = {}) {
    if (!configured) return { skipped: true, reason: 'Supabase DB connection is not configured' }
    rejectPlainAgentAdmin(adminAccount)
    if (!code || !status) throw new Error('License code and status are required')
    const result = await db.query(
      `update public.licenses set status = $2, updated_at = now() where code = $1 returning id, code, status, expires_on`,
      [code, status],
    )
    await logAdminOperation({ adminAccount, action: 'set_license_status', targetType: 'license', targetCode: code, payload: { status } })
    return { ok: true, row: result.rows[0] ?? null }
  }

  async function extendLicense({ code, days = 30, adminAccount = 'DVAI' } = {}) {
    if (!configured) return { skipped: true, reason: 'Supabase DB connection is not configured' }
    if (!code) throw new Error('License code is required')
    const result = await db.query(
      `update public.licenses set expires_on = expires_on + ($2::int * interval '1 day'), updated_at = now() where code = $1 returning id, code, status, expires_on`,
      [code, Number(days)],
    )
    await logAdminOperation({ adminAccount, action: 'extend_license', targetType: 'license', targetCode: code, payload: { days: Number(days) } })
    return { ok: true, row: result.rows[0] ?? null }
  }

  async function deleteLicense({ code, adminAccount = 'DVAI' } = {}) {
    if (!configured) return { skipped: true, reason: 'Supabase DB connection is not configured' }
    if (!code) throw new Error('License code is required')
    const result = await db.query(
      `update public.licenses set status = 'expired', updated_at = now() where code = $1 returning id, code, status, expires_on`,
      [code],
    )
    await logAdminOperation({ adminAccount, action: 'delete_license', targetType: 'license', targetCode: code })
    return { ok: true, row: result.rows[0] ?? null }
  }

  async function getOrCreatePlan({ name, durationDays }) {
    const existing = await db.query('select id, name, duration_days from public.plans where name = $1 limit 1', [name])
    if (existing.rows[0]) return existing.rows[0]
    return upsertPlan({ name, durationDays })
  }

  async function getOrCreateAgentByCode(code) {
    const result = await db.query('select id, code from public.agents where code = $1 limit 1', [code])
    if (result.rows[0]) return result.rows[0]
    return (await createAgent({ code, name: code, role: 'manager', permission: '可建碼 / 線上授權', adminAccount: code })).row
  }

  async function upsertMember({ account, agentId }) {
    const result = await db.query(`insert into public.members(account, agent_id, status)
                                  values ($1, $2, 'active')
                                  on conflict (account) do update set agent_id = excluded.agent_id, status = 'active', updated_at = now()
                                  returning id, account, agent_id, status`, [account, agentId])
    return result.rows[0] ?? { account, agent_id: agentId, status: 'active' }
  }

  async function validateMemberLogin({ memberAccount, verificationPassword } = {}) {
    if (!configured) return { skipped: true, reason: 'Supabase DB connection is not configured' }
    if (!memberAccount || !verificationPassword) throw new Error('Member account and verification password are required')
    const result = await db.query(
      `select l.id, l.code, l.member_account, l.status, l.expires_on, a.code as agent_code, p.name as plan_name
       from public.licenses l
       join public.agents a on a.id = l.agent_id
       left join public.plans p on p.id = l.plan_id
       where l.code = $1 and l.member_account = $2
       limit 1`,
      [verificationPassword, memberAccount],
    )
    const license = result.rows[0] ?? null
    const ok = Boolean(license && license.status === 'active' && dateOnly(license.expires_on) >= todayIso())
    await db.query(
      'insert into public.license_validation_logs(license_id, member_account, submitted_code, result) values ($1, $2, $3, $4)',
      [license?.id ?? null, memberAccount, verificationPassword, ok ? 'valid' : 'invalid'],
    )
    return { ok, memberAccount, license }
  }

  async function validateAgentLogin({ agentAccount } = {}) {
    if (!configured) return { skipped: true, reason: 'Supabase DB connection is not configured' }
    if (!agentAccount) throw new Error('Agent account is required')
    const result = await db.query('select id, code, name, role, parent_code, permission, created_at from public.agents where code = $1 and coalesce(is_active, true) = true limit 1', [agentAccount])
    const agent = result.rows[0] ?? null
    if (agent) return { ok: true, agent, account: { ...agent, type: 'agent', permission: agent.permission ?? 'agent' } }
    const managerResult = await db.query('select id, username, role, is_active, created_at from public.manager_accounts where username = $1 and is_active = true limit 1', [agentAccount])
    const manager = managerResult.rows[0] ?? null
    if (!manager) return { ok: false, agent: null, account: null }
    return { ok: true, agent: null, account: { ...manager, type: 'manager', permission: manager.role === 'total' ? 'all' : 'limited' } }
  }

  async function getCloudDataStatus() {
    return { ok: true, mtAutoLoginEnabled: false, captureSource: process.env.CAPTURE_SOURCE || 'manual_or_worker', message: 'MT自動登入未啟用，等待手動或Worker資料來源', tableCount: 0 }
  }

  async function logAdminOperation({ adminAccount = 'system', action, targetType, targetCode, payload = {} } = {}) {
    if (!configured || !action) return null
    try {
      const result = await db.query(`insert into public.admin_operation_logs(admin_account, action, target_type, target_code, payload)
                                    values ($1, $2, $3, $4, $5::jsonb) returning id`, [adminAccount, action, targetType ?? null, targetCode ?? null, JSON.stringify(payload ?? {})])
      return result.rows[0] ?? null
    } catch {
      return null
    }
  }

  return { configured, getStatus, bootstrap, createAgent, deleteAgents, createLicense, setLicenseStatus, extendLicense, deleteLicense, validateMemberLogin, validateAgentLogin, getCloudDataStatus }
}

export function hashManagerPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256').toString('hex')
  return { salt, hash }
}

function buildAgentRows(agents) {
  return agents.map((agent) => ({
    account: agent.code,
    level: roleLabel(agent.role, agent.name),
    permission: agent.permission ?? '可建碼',
    parent: agent.parent_code ?? undefined,
    depth: inferDepth(agent.role),
  }))
}

function roleLabel(role, fallback = '') {
  if (String(role).includes('manager')) return '管理員'
  if (String(role).includes('viewer')) return '觀察者'
  if (String(role).includes('super')) return '超級管理員'
  return fallback || '代理'
}

function inferDepth(role) {
  if (String(role).includes('super')) return 0
  if (String(role).includes('manager')) return 1
  if (String(role).includes('viewer')) return 3
  return 2
}

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

function rejectPlainAgentAdmin(adminAccount) {
  if (/^Agent/i.test(String(adminAccount ?? ''))) throw new Error('Operation requires total manager permission')
}

function dateOnly(value) {
  if (!value) return null
  return String(value).slice(0, 10)
}

function formatRemain(expiresOn) {
  if (!expiresOn) return '未設定'
  const today = new Date()
  const expiry = String(expiresOn).includes('T') ? new Date(expiresOn) : new Date(`${expiresOn}T00:00:00`)
  const diff = Math.ceil((expiry.getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 86400000)
  return diff > 0 ? `${diff}天` : '已到期'
}

function addDaysIso(dateText, days) {
  const date = new Date(`${dateText}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + Number(days))
  return date.toISOString().slice(0, 10)
}
