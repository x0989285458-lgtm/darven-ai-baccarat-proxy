import crypto from 'node:crypto'
import pg from 'pg'
import { ALL_MT_EQUAL_STRATEGY_VERSION, resolveBackendReadConnectionString } from './supabase-writer.js'

export function createLicenseAdminClient({ dbConnectionString, pool = null, poolFactory = (options) => new pg.Pool(options) } = {}) {
  const resolvedConnectionString = dbConnectionString ?? process.env.SUPABASE_DB_CONNECTION_STRING
  const configured = Boolean(pool || resolvedConnectionString)
  const db = pool ?? (resolvedConnectionString ? poolFactory({
    connectionString: resolveBackendReadConnectionString(resolvedConnectionString),
    ssl: { rejectUnauthorized: false },
    max: 2,
    connectionTimeoutMillis: 9000,
    query_timeout: 9000,
    statement_timeout: 8500,
    idleTimeoutMillis: 30000,
  }) : null)
  const dailyAnalyticsCacheMs = 60_000
  let dailyAnalyticsCache = null
  let dailyAnalyticsCacheAt = 0
  let dailyAnalyticsInFlight = null

  async function getStatus({ adminAccount = null } = {}) {
    if (!configured) return { configured: false, managers: [], agents: [], plans: [], licenses: [], agentRows: [], licenseRows: [], usedLicenseCodes: [] }
    const [managers, agents, plans, licenses, usedLicenses] = await Promise.all([
      db.query("select id, username, role, is_active, created_at from public.manager_accounts where lower(username) = 'dv1788' order by created_at desc limit 50"),
      db.query(`select id, code, name, role, parent_code, is_active, permission, created_at
                from public.agents where coalesce(is_active, true) = true order by created_at desc limit 100`),
      db.query('select id, name, duration_days, created_at from public.plans order by duration_days asc limit 50'),
      db.query(`select l.id, l.code, l.member_account, l.status, l.starts_on, l.expires_on, a.code as agent_code, p.name as plan_name
                from public.licenses l
                join public.agents a on a.id = l.agent_id
                left join public.plans p on p.id = l.plan_id
                where l.status <> 'expired'
                order by l.created_at desc limit 100`),
      db.query(`select l.code, a.code as agent_code
                from public.licenses l
                join public.agents a on a.id = l.agent_id
                order by l.created_at desc`),
    ])
    const scopedAgents = scopeAgents(agents.rows, adminAccount)
    const scopedCodes = new Set(scopedAgents.map((agent) => agent.code))
    const inLicenseScope = (license) => isSuperAdmin(adminAccount) || !adminAccount || scopedCodes.has(license.agent_code) || license.agent_code === adminAccount
    const scopedLicenses = licenses.rows.filter(inLicenseScope)
    const scopedUsedLicenses = usedLicenses.rows.filter(inLicenseScope)
    return {
      configured: true,
      managers: managers.rows,
      agents: scopedAgents,
      plans: plans.rows,
      licenses: scopedLicenses,
      agentRows: buildAgentRows(scopedAgents),
      licenseRows: scopedLicenses.map((license, index) => ({
        member: license.member_account ?? `User${String(index + 1).padStart(3, '0')}`,
        code: license.code,
        status: license.status === 'active' ? '啟用中' : license.status === 'suspended' ? '暫停中' : '已過期',
        remain: formatRemain(license.expires_on),
        expiresOn: dateOnly(license.expires_on),
        agentCode: license.agent_code,
      })),
      usedLicenseCodes: scopedUsedLicenses.map((license) => license.code),
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

  async function createAgent({ code, name, role = 'agent', parentCode = null, permission = '可建碼', adminAccount = 'dv1788' } = {}) {
    if (!configured) return { skipped: true, reason: 'Supabase DB connection is not configured' }
    if (!code) throw new Error('Agent code is required')
    await assertCanManageRole(adminAccount, role)
    const displayName = name || code
    const resolvedParentCode = isSuperAdmin(parentCode) ? null : (parentCode || (isSuperAdmin(adminAccount) ? null : adminAccount))
    if (resolvedParentCode && String(resolvedParentCode).toLowerCase() === String(code).toLowerCase()) throw new Error('不能把帳號新增到自己底下')
    if (resolvedParentCode) await assertCanManageAgentCode(adminAccount, resolvedParentCode)
    const existing = await db.query('select id from public.agents where code = $1 limit 1', [code])
    if (existing.rows[0]) await assertCanManageAgentCode(adminAccount, code)
    const result = existing.rows[0]
      ? await db.query(`update public.agents set name = $2, role = $3, parent_code = $4, permission = $5, is_active = true, updated_at = now()
                       where code = $1 returning id, code, name, role, parent_code, permission, is_active, created_at`, [code, displayName, role, resolvedParentCode, permission])
      : await db.query(`insert into public.agents(code, name, role, parent_code, permission, is_active)
                       values ($1, $2, $3, $4, $5, true)
                       returning id, code, name, role, parent_code, permission, is_active, created_at`, [code, displayName, role, resolvedParentCode, permission])
    await logAdminOperation({ adminAccount, action: 'create_agent', targetType: 'agent', targetCode: code, payload: { role, parentCode: resolvedParentCode, permission } })
    return { ok: true, row: result.rows[0] }
  }

  async function deleteAgents({ codes = [], adminAccount = 'dv1788' } = {}) {
    if (!configured) return { skipped: true, reason: 'Supabase DB connection is not configured' }
    const list = Array.isArray(codes) ? codes.filter(Boolean) : []
    if (!list.length) throw new Error('Agent codes are required')
    const allAgents = await db.query(`select code, parent_code, role from public.agents where coalesce(is_active, true) = true`)
    for (const code of list) assertAgentInScope(adminAccount, code, allAgents.rows)
    const toDelete = collectAgentDeleteCodes(list, allAgents.rows)
    const result = await db.query(`update public.agents set is_active = false, updated_at = now()
                                  where code = any($1::text[])
                                  returning id, code, name, role, parent_code, is_active`, [toDelete])
    const suspendedLicenses = await db.query(`update public.licenses l set status = 'suspended', updated_at = now()
                                  from public.agents a
                                  where l.agent_id = a.id
                                    and a.code = any($1::text[])
                                    and l.status <> 'expired'
                                  returning l.id, l.code, l.status`, [toDelete])
    await logAdminOperation({ adminAccount, action: 'delete_agents', targetType: 'agent', targetCode: toDelete.join(','), payload: { requestedCodes: list, deletedCodes: toDelete, suspendedLicenseCodes: suspendedLicenses.rows.map((row) => row.code) } })
    return { ok: true, rows: result.rows, deletedCodes: toDelete, suspendedLicenses: suspendedLicenses.rows }
  }

  async function createLicense({ memberAccount, code, agentCode, planName = '正式月卡', durationDays = 30, startsOn = todayIso(), adminAccount = 'dv1788' } = {}) {
    if (!configured) return { skipped: true, reason: 'Supabase DB connection is not configured' }
    if (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > 30) {
      throw httpError(400, 'durationDays must be an integer from 1 through 30')
    }
    if (!code || !agentCode) throw new Error('license code and agentCode are required')
    await assertCanManageCodes(adminAccount)
    await assertCanManageAgentCode(adminAccount, agentCode)
    const resolvedMemberAccount = memberAccount || `User${String(code).match(/(\d+)/)?.[1]?.slice(-4)?.padStart(4, '0') ?? '0001'}`
    const plan = await getOrCreatePlan({ name: planName, durationDays })
    const agent = await getOrCreateAgentByCode(agentCode)
    const existing = await db.query(
      `select l.id, l.code, l.member_account, l.agent_id, a.code as agent_code,
              l.plan_id, p.duration_days, l.starts_on, l.expires_on, l.status
       from public.licenses l
       join public.agents a on a.id = l.agent_id
       join public.plans p on p.id = l.plan_id
       where l.code = $1 limit 1`,
      [code],
    )
    if (existing.rows[0]) {
      const row = existing.rows[0]
      const sameIdentity = row.member_account === resolvedMemberAccount
        && row.agent_code === agentCode
        && Number(row.duration_days) === durationDays
      if (!sameIdentity) throw httpError(409, 'license code already belongs to a different license identity')
      return { ok: true, idempotent: true, durationDays, row }
    }
    const member = await upsertMember({ account: resolvedMemberAccount, agentId: agent.id })
    const expiresOn = addDaysIso(startsOn, durationDays)
    let result
    try {
      result = await db.query(
        `insert into public.licenses(code, member_account, agent_id, plan_id, starts_on, expires_on, status)
         values ($1, $2, $3, $4, $5, $6, 'active')
         returning id, code, member_account, agent_id, plan_id, starts_on, expires_on, status`,
        [code, member.account, agent.id, plan.id, startsOn, expiresOn],
      )
    } catch (error) {
      if (error?.code === '23505') throw httpError(409, 'license code already exists')
      throw error
    }
    await logAdminOperation({ adminAccount, action: 'create_license', targetType: 'license', targetCode: code, payload: { memberAccount: resolvedMemberAccount, agentCode, durationDays } })
    return { ok: true, durationDays, row: result.rows[0] }
  }

  async function setLicenseStatus({ code, status, adminAccount = 'DVAI' } = {}) {
    if (!configured) return { skipped: true, reason: 'Supabase DB connection is not configured' }
    await assertCanManageCodes(adminAccount)
    if (!code || !status) throw new Error('License code and status are required')
    await assertCanManageLicenseCode(adminAccount, code)
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
    await assertCanManageCodes(adminAccount)
    await assertCanManageLicenseCode(adminAccount, code)
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
    await assertCanManageCodes(adminAccount)
    await assertCanManageLicenseCode(adminAccount, code)
    const result = await db.query(
      `update public.licenses set status = 'expired', updated_at = now() where code = $1 returning id, code, status, expires_on`,
      [code],
    )
    await logAdminOperation({ adminAccount, action: 'delete_license', targetType: 'license', targetCode: code })
    return { ok: true, row: result.rows[0] ?? null }
  }

  async function getOrCreatePlan({ name, durationDays }) {
    const resolvedName = durationDays === 30 ? name : `${name}-${durationDays}天`
    const existing = await db.query('select id, name, duration_days from public.plans where name = $1 limit 1', [resolvedName])
    if (existing.rows[0]) {
      if (Number(existing.rows[0].duration_days) !== durationDays) {
        throw httpError(409, 'plan name already exists with a different duration')
      }
      return existing.rows[0]
    }
    const result = await db.query(
      'insert into public.plans(name, duration_days) values ($1, $2) returning id, name, duration_days',
      [resolvedName, durationDays],
    )
    return result.rows[0]
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


  async function isMaintenanceMode() {
    try {
      const result = await db.query(`select s.value
        from public.online_app_settings s
        join public.memory_projects p on p.id = s.project_id
        where p.slug = 'ai-baccarat' and s.scope = 'frontend' and s.key = 'ui_defaults'
        limit 1`)
      return Boolean(result.rows[0]?.value?.maintenanceMode)
    } catch {
      return false
    }
  }

  async function validateMemberLogin({ memberAccount, verificationPassword } = {}) {
    if (!configured) return { skipped: true, reason: 'Supabase DB connection is not configured' }
    if (await isMaintenanceMode()) return { ok: false, maintenanceMode: true, error: '系統維護中，暫停登入' }
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
    try {
      const auditWrite = db.query(
        'insert into public.license_validation_logs(license_id, member_account, submitted_code, result) values ($1, $2, $3, $4)',
        [license?.id ?? null, memberAccount, '[REDACTED]', ok ? 'valid' : 'failed'],
      )
      void Promise.resolve(auditWrite).catch((error) => {
        console.warn('[license-validation-log-skipped]', error?.message || error)
      })
    } catch (error) {
      console.warn('[license-validation-log-skipped]', error?.message || error)
    }
    return { ok, memberAccount, license, error: ok ? undefined : (license?.status === 'suspended' ? '驗證碼已暫停' : '會員帳號或驗證碼錯誤') }
  }

  async function validateMemberSession({ memberAccount, licenseId, authorizationVersion = null } = {}) {
    if (!configured || !memberAccount || !licenseId) return { ok: false }
    const result = await db.query(
      `select l.id, l.member_account, l.status, l.expires_on, l.updated_at
       from public.licenses l
       where l.id = $1 and l.member_account = $2
       limit 1`,
      [licenseId, memberAccount],
    )
    const license = result.rows[0] ?? null
    const sameVersion = authorizationVersion == null
      || (license?.updated_at != null && new Date(license.updated_at).getTime() === new Date(authorizationVersion).getTime())
    const ok = Boolean(license && sameVersion && license.status === 'active' && dateOnly(license.expires_on) >= todayIso())
    return { ok, memberAccount, license }
  }

  async function validateAgentLogin({ agentAccount } = {}) {
    if (!configured) return { skipped: true, reason: 'Supabase DB connection is not configured' }
    if (!isSuperAdmin(agentAccount) && await isMaintenanceMode()) return { ok: false, maintenanceMode: true, error: '系統維護中，僅超級管理員可登入' }
    if (!agentAccount) throw new Error('Agent account is required')
    const managerResult = await db.query("select id, username, role, is_active, created_at from public.manager_accounts where lower(username) = lower($1) and lower(username) = 'dv1788' and is_active = true limit 1", [agentAccount])
    const manager = managerResult.rows[0] ?? null
    if (manager) return { ok: true, agent: null, account: { ...manager, type: 'manager', permission: manager.role === 'total' ? 'all' : 'limited' } }
    const result = await db.query("select id, code, name, role, parent_code, permission, created_at from public.agents where code = $1 and lower(code) <> 'dv1788' and coalesce(is_active, true) = true limit 1", [agentAccount])
    const agent = result.rows[0] ?? null
    if (agent) return { ok: true, agent, account: { ...agent, type: 'agent', permission: agent.permission ?? 'agent' } }
    return { ok: false, agent: null, account: null }
  }

  async function getDailyAnalytics() {
    if (!configured) return { todayRoundCount: 0, tableStats: [], dailyReports: [] }
    if (dailyAnalyticsCache && Date.now() - dailyAnalyticsCacheAt < dailyAnalyticsCacheMs) return dailyAnalyticsCache
    if (dailyAnalyticsInFlight) return dailyAnalyticsInFlight
    dailyAnalyticsInFlight = loadDailyAnalytics()
    try {
      const result = await dailyAnalyticsInFlight
      dailyAnalyticsCache = result
      dailyAnalyticsCacheAt = Date.now()
      return result
    } catch (error) {
      if (dailyAnalyticsCache) return dailyAnalyticsCache
      throw error
    } finally {
      dailyAnalyticsInFlight = null
    }
  }

  async function loadDailyAnalytics() {
    const todayCountPromise = db.query(`select count(distinct table_id || ':' || shoe_no || ':' || round_no)::int as rounds
      from public.daily_prediction_results
      where created_at >= ((timezone('Asia/Taipei', now())::date)::timestamp at time zone 'Asia/Taipei') and strategy_version = $1
        and settlement_final is true`, [ALL_MT_EQUAL_STRATEGY_VERSION])
    const tableRowsPromise = db.query(`with scoped as (
        select table_id, shoe_no, round_no, predicted_result, actual_result, is_hit, settlement_final, side_hits, prediction_features
        from public.daily_prediction_results
        where created_at >= ((timezone('Asia/Taipei', now())::date)::timestamp at time zone 'Asia/Taipei') and strategy_version = $1
          and settlement_final is true
      ), validated as (
        select *,
          jsonb_typeof(prediction_features->'side_actions') = 'object'
          and (prediction_features->'side_actions' ? 'tie')
          and (prediction_features->'side_actions' ? 'superSix')
          and (prediction_features->'side_actions' ? 'bankerPair')
          and (prediction_features->'side_actions' ? 'playerPair')
          and (prediction_features->'side_actions' ? 'bankerDragon')
          and (prediction_features->'side_actions' ? 'playerDragon')
          and (prediction_features->'side_actions'->>'tie') in ('true','false')
          and (prediction_features->'side_actions'->>'superSix') in ('true','false')
          and (prediction_features->'side_actions'->>'bankerPair') in ('true','false')
          and (prediction_features->'side_actions'->>'playerPair') in ('true','false')
          and (prediction_features->'side_actions'->>'bankerDragon') in ('true','false')
          and (prediction_features->'side_actions'->>'playerDragon') in ('true','false')
          and jsonb_typeof(coalesce(side_hits, prediction_features->'side_hits')) = 'object'
          and (coalesce(side_hits, prediction_features->'side_hits') ? 'tie')
          and (coalesce(side_hits, prediction_features->'side_hits') ? 'superSix')
          and (coalesce(side_hits, prediction_features->'side_hits') ? 'bankerPair')
          and (coalesce(side_hits, prediction_features->'side_hits') ? 'playerPair')
          and (coalesce(side_hits, prediction_features->'side_hits') ? 'bankerDragon')
          and (coalesce(side_hits, prediction_features->'side_hits') ? 'playerDragon')
          and (coalesce(side_hits, prediction_features->'side_hits')->>'tie') in ('true','false')
          and (coalesce(side_hits, prediction_features->'side_hits')->>'superSix') in ('true','false')
          and (coalesce(side_hits, prediction_features->'side_hits')->>'bankerPair') in ('true','false')
          and (coalesce(side_hits, prediction_features->'side_hits')->>'playerPair') in ('true','false')
          and (coalesce(side_hits, prediction_features->'side_hits')->>'bankerDragon') in ('true','false')
          and (coalesce(side_hits, prediction_features->'side_hits')->>'playerDragon') in ('true','false') as side_actions_available
        from scoped
      ), side as (
        select table_id,
          bool_and(side_actions_available) as side_actions_available,
          sum(
            case when (prediction_features->'side_actions'->>'tie')::boolean is true then 1 else 0 end +
            case when (prediction_features->'side_actions'->>'superSix')::boolean is true then 1 else 0 end +
            case when (prediction_features->'side_actions'->>'bankerPair')::boolean is true then 1 else 0 end +
            case when (prediction_features->'side_actions'->>'playerPair')::boolean is true then 1 else 0 end +
            case when (prediction_features->'side_actions'->>'bankerDragon')::boolean is true then 1 else 0 end +
            case when (prediction_features->'side_actions'->>'playerDragon')::boolean is true then 1 else 0 end
          )::int as side_actions,
          sum(
            case when (prediction_features->'side_actions'->>'tie')::boolean is true and (coalesce(side_hits, prediction_features->'side_hits')->>'tie')::boolean is true then 1 else 0 end +
            case when (prediction_features->'side_actions'->>'superSix')::boolean is true and (coalesce(side_hits, prediction_features->'side_hits')->>'superSix')::boolean is true then 1 else 0 end +
            case when (prediction_features->'side_actions'->>'bankerPair')::boolean is true and (coalesce(side_hits, prediction_features->'side_hits')->>'bankerPair')::boolean is true then 1 else 0 end +
            case when (prediction_features->'side_actions'->>'playerPair')::boolean is true and (coalesce(side_hits, prediction_features->'side_hits')->>'playerPair')::boolean is true then 1 else 0 end +
            case when (prediction_features->'side_actions'->>'bankerDragon')::boolean is true and (coalesce(side_hits, prediction_features->'side_hits')->>'bankerDragon')::boolean is true then 1 else 0 end +
            case when (prediction_features->'side_actions'->>'playerDragon')::boolean is true and (coalesce(side_hits, prediction_features->'side_hits')->>'playerDragon')::boolean is true then 1 else 0 end
          )::int as side_hits,
          sum(case when (prediction_features->'side_actions'->>'tie')::boolean is true then 1 else 0 end)::int as tie_total,
          sum(case when (prediction_features->'side_actions'->>'tie')::boolean is true and (coalesce(side_hits, prediction_features->'side_hits')->>'tie')::boolean is true then 1 else 0 end)::int as tie_hits,
          sum(case when predicted_result='banker' and (prediction_features->'side_actions'->>'bankerDragon')::boolean is true then 1 when predicted_result='player' and (prediction_features->'side_actions'->>'playerDragon')::boolean is true then 1 else 0 end)::int as dragon_total,
          sum(case when predicted_result='banker' and (prediction_features->'side_actions'->>'bankerDragon')::boolean is true and (coalesce(side_hits, prediction_features->'side_hits')->>'bankerDragon')::boolean is true then 1 when predicted_result='player' and (prediction_features->'side_actions'->>'playerDragon')::boolean is true and (coalesce(side_hits, prediction_features->'side_hits')->>'playerDragon')::boolean is true then 1 else 0 end)::int as dragon_hits,
          sum(case when (prediction_features->'side_actions'->>'bankerPair')::boolean is true then 1 else 0 end + case when (prediction_features->'side_actions'->>'playerPair')::boolean is true then 1 else 0 end)::int as pair_total,
          sum(case when (prediction_features->'side_actions'->>'bankerPair')::boolean is true and (coalesce(side_hits, prediction_features->'side_hits')->>'bankerPair')::boolean is true then 1 else 0 end + case when (prediction_features->'side_actions'->>'playerPair')::boolean is true and (coalesce(side_hits, prediction_features->'side_hits')->>'playerPair')::boolean is true then 1 else 0 end)::int as pair_hits,
          sum(case when (prediction_features->'side_actions'->>'superSix')::boolean is true then 1 else 0 end)::int as six_total,
          sum(case when (prediction_features->'side_actions'->>'superSix')::boolean is true and (coalesce(side_hits, prediction_features->'side_hits')->>'superSix')::boolean is true then 1 else 0 end)::int as six_hits
        from validated group by table_id
      ) select s.table_id,
          count(distinct s.table_id || ':' || s.shoe_no || ':' || s.round_no)::int as rounds,
          count(*) filter (where s.predicted_result in ('banker','player') and s.actual_result in ('banker','player'))::int as main_total,
          count(*) filter (where s.predicted_result in ('banker','player') and s.is_hit is true)::int as main_hits,
          count(*) filter (where s.predicted_result='banker' and s.actual_result in ('banker','player'))::int as banker_total,
          count(*) filter (where s.predicted_result='banker' and s.actual_result='banker')::int as banker_hits,
          count(*) filter (where s.predicted_result='player' and s.actual_result in ('banker','player'))::int as player_total,
          count(*) filter (where s.predicted_result='player' and s.actual_result='player')::int as player_hits,
          coalesce(side.side_actions,0)::int as side_actions, coalesce(side.side_hits,0)::int as side_hits,
          coalesce(side.tie_total,0)::int as tie_total, coalesce(side.tie_hits,0)::int as tie_hits,
          coalesce(side.dragon_total,0)::int as dragon_total, coalesce(side.dragon_hits,0)::int as dragon_hits,
          coalesce(side.pair_total,0)::int as pair_total, coalesce(side.pair_hits,0)::int as pair_hits,
          coalesce(side.six_total,0)::int as six_total, coalesce(side.six_hits,0)::int as six_hits,
          coalesce(side.side_actions_available, false) as side_actions_available
        from scoped s left join side on side.table_id=s.table_id
        group by s.table_id, side.side_actions, side.side_hits, side.tie_total, side.tie_hits,
          side.dragon_total, side.dragon_hits, side.pair_total, side.pair_hits, side.six_total, side.six_hits,
          side.side_actions_available`, [ALL_MT_EQUAL_STRATEGY_VERSION])
    const [todayCount, tableRows] = await Promise.all([todayCountPromise, tableRowsPromise])
    const sum = (key) => tableRows.rows.reduce((total, row) => total + Number(row[key] ?? 0), 0)
    const sideActionsAvailable = tableRows.rows.length > 0 && tableRows.rows.every((row) => row.side_actions_available === true)
    const dailyReports = [{
      date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date()),
      rounds: Number(todayCount.rows[0]?.rounds ?? 0), side_actions_available: sideActionsAvailable,
      banker_hit_rate: pctText(sum('banker_hits'), sum('banker_total')),
      player_hit_rate: pctText(sum('player_hits'), sum('player_total')),
      tie_hit_rate: sideActionsAvailable ? pctText(sum('tie_hits'), sum('tie_total')) : 'unavailable',
      dragon_hit_rate: sideActionsAvailable ? pctText(sum('dragon_hits'), sum('dragon_total')) : 'unavailable',
      pair_hit_rate: sideActionsAvailable ? pctText(sum('pair_hits'), sum('pair_total')) : 'unavailable',
      six_hit_rate: sideActionsAvailable ? pctText(sum('six_hits'), sum('six_total')) : 'unavailable',
    }]
    const rowsByTable = new Map(tableRows.rows.map((row) => [row.table_id, row]))
    const order = ['BAG01','BAG02','BAG03','BAG03A','BAG05','BAG06','BAG07','BAG08','BAG09','BAG10']
    return {
      todayRoundCount: Number(todayCount.rows[0]?.rounds ?? 0),
      tableStats: order.map((tableId) => {
        const row = rowsByTable.get(tableId) ?? {}
        const sideActionsAvailable = row.side_actions_available === true
        return { tableId, tableName: tableLabel(tableId), rounds: Number(row.rounds ?? 0), mainHitRate: pctText(Number(row.main_hits ?? 0), Number(row.main_total ?? 0)), sideHitRate: sideActionsAvailable ? pctText(Number(row.side_hits ?? 0), Number(row.side_actions ?? 0)) : 'unavailable', sideActionsAvailable }
      }),
      dailyReports,
    }
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


function isSuperAdmin(account) {
  return String(account ?? '').toLowerCase() === 'dv1788'
}

function scopeAgents(agents, adminAccount) {
  if (!adminAccount || isSuperAdmin(adminAccount)) return agents.filter((agent) => String(agent.code).toLowerCase() !== 'dv1788')
  return agents.filter((agent) => isDescendantAgent(agent, adminAccount, agents))
}

function isDescendantAgent(agent, ancestor, agents) {
  let parent = agent.parent_code
  const seen = new Set()
  while (parent) {
    if (seen.has(parent)) return false
    seen.add(parent)
    if (parent === ancestor) return true
    parent = agents.find((item) => item.code === parent)?.parent_code
  }
  return false
}
function assertAgentInScope(adminAccount, targetCode, agents) {
  if (!targetCode || isSuperAdmin(adminAccount)) return true
  if (String(targetCode).toLowerCase() === String(adminAccount).toLowerCase()) return true
  const target = agents.find((agent) => String(agent.code).toLowerCase() === String(targetCode).toLowerCase())
  if (target && isDescendantAgent(target, adminAccount, agents)) return true
  throw new Error('無權操作此代理或下級')
}

async function assertCanManageAgentCode(adminAccount, targetCode) {
  if (!targetCode || isSuperAdmin(adminAccount)) return true
  const allAgents = await db.query(`select code, parent_code, role from public.agents where coalesce(is_active, true) = true`)
  return assertAgentInScope(adminAccount, targetCode, allAgents.rows)
}

async function assertCanManageLicenseCode(adminAccount, licenseCode) {
  if (!licenseCode || isSuperAdmin(adminAccount)) return true
  const result = await db.query(`select a.code as agent_code
    from public.licenses l
    join public.agents a on a.id = l.agent_id
    where l.code = $1
    limit 1`, [licenseCode])
  const agentCode = result.rows[0]?.agent_code
  if (!agentCode) throw new Error('驗證碼不存在')
  return assertCanManageAgentCode(adminAccount, agentCode)
}


function collectAgentDeleteCodes(requestedCodes, agents) {
  const requested = new Set(requestedCodes.map(String))
  const deleteSet = new Set(requested)
  const selectedManagers = agents.filter((agent) => requested.has(agent.code) && String(agent.role).toLowerCase().includes('manager'))
  for (const manager of selectedManagers) {
    for (const agent of agents) {
      if (isDescendantAgent(agent, manager.code, agents)) deleteSet.add(agent.code)
    }
  }
  return Array.from(deleteSet)
}

async function assertCanManageRole(adminAccount, role) {
  if (isSuperAdmin(adminAccount)) return true
  const admin = await dbQueryAgentRole(adminAccount)
  if (!admin) throw new Error('管理者未開通')
  if (admin.role === 'viewer') throw new Error('觀察者不可開設帳號')
  if (admin.role === 'agent') throw new Error('代理不能開設下級')
  if (admin.role === 'manager' && role === 'manager') throw new Error('下級等級不能高於或平級於上級')
  return true
}

async function assertCanManageCodes(adminAccount) {
  if (isSuperAdmin(adminAccount)) return true
  const admin = await dbQueryAgentRole(adminAccount)
  if (!admin) throw new Error('管理者未開通')
  if (admin.role === 'viewer') throw new Error('觀察者不能管理驗證碼')
  return true
}

async function dbQueryAgentRole(code) {
  try {
    const result = await db.query('select role from public.agents where code = $1 and coalesce(is_active, true) = true limit 1', [code])
    return result.rows[0] ?? null
  } catch {
    return null
  }
}

  async function checkConnection() {
    if (!configured) return false
    await db.query('select 1 as ok')
    return true
  }

  return { configured, checkConnection, getStatus, bootstrap, createAgent, deleteAgents, createLicense, setLicenseStatus, extendLicense, deleteLicense, validateMemberLogin, validateMemberSession, validateAgentLogin, getCloudDataStatus, getDailyAnalytics }
}


function countDistinctRounds(rows) {
  return new Set(rows.map((r) => `${r.table_id}:${r.shoe_no}:${r.round_no}`)).size
}
function pctText(hits, total) { return total ? `${((hits / total) * 100).toFixed(1)}%` : '-' }
function sideAction(row, key) { return row?.prediction_features?.side_actions?.[key] === true }
function effectiveSideHits(row = {}) { return row.side_hits ?? row.prediction_features?.side_hits }
function sideHit(row, key) { return effectiveSideHits(row)?.[key] === true }
function isFinalSettlementRow(row = {}) { return row.settlement_final === true || (row.settlement_final == null && row.prediction_features?.settlement_final === true) }
const SAVED_SIDE_ACTION_KEYS = ['tie','superSix','bankerPair','playerPair','bankerDragon','playerDragon']
function hasCompleteSavedSideActions(row = {}) {
  const actions = row.prediction_features?.side_actions
  const hits = effectiveSideHits(row)
  return actions && typeof actions === 'object' && !Array.isArray(actions)
    && Object.keys(actions).length === SAVED_SIDE_ACTION_KEYS.length
    && SAVED_SIDE_ACTION_KEYS.every((key) => typeof actions[key] === 'boolean')
    && hits && typeof hits === 'object' && !Array.isArray(hits)
    && Object.keys(hits).length === SAVED_SIDE_ACTION_KEYS.length
    && SAVED_SIDE_ACTION_KEYS.every((key) => typeof hits[key] === 'boolean')
}
function sideActionStats(rows, keys) {
  if (rows.some((row) => !hasCompleteSavedSideActions(row))) {
    return { actions: 0, hits: 0, rate: 'unavailable', available: false }
  }
  let actions = 0, hits = 0
  for (const r of rows) {
    for (const key of keys) {
      if (key === 'bankerDragon' || key === 'playerDragon') continue
      if (sideAction(r, key)) { actions += 1; if (sideHit(r, key)) hits += 1 }
    }
    if (keys.includes('bankerDragon') || keys.includes('playerDragon')) {
      const dragonKey = r.predicted_result === 'banker' ? 'bankerDragon' : r.predicted_result === 'player' ? 'playerDragon' : null
      if (dragonKey && keys.includes(dragonKey) && sideAction(r, dragonKey)) { actions += 1; if (sideHit(r, dragonKey)) hits += 1 }
    }
  }
  return { actions, hits, rate: pctText(hits, actions), available: true }
}
function tableLabel(tableId) {
  const map = { BAG01:'1桌', BAG02:'2桌', BAG03:'3桌', BAG03A:'3A桌', BAG05:'5桌', BAG06:'6桌', BAG07:'7桌', BAG08:'8桌', BAG09:'9桌', BAG10:'10桌' }
  return map[tableId] ?? String(tableId ?? '')
}
export function buildTableStats(rows) {
  const order = ['BAG01','BAG02','BAG03','BAG03A','BAG05','BAG06','BAG07','BAG08','BAG09','BAG10']
  return order.map((tableId) => {
    const list = rows.filter((r) => isFinalSettlementRow(r) && r.table_id === tableId)
    const mainRows = list.filter((r) => ['banker', 'player'].includes(r.predicted_result) && ['banker', 'player'].includes(r.actual_result))
    const mainTotal = mainRows.length
    const mainHits = mainRows.filter((r) => r.is_hit === true).length
    const side = sideActionStats(list, ['tie','superSix','bankerPair','playerPair','bankerDragon','playerDragon'])
    return { tableId, tableName: tableLabel(tableId), rounds: countDistinctRounds(list), mainHitRate: pctText(mainHits, mainTotal), sideHitRate: side.rate, sideActionsAvailable: side.available }
  })
}
export function buildDailyReports(rows) {
  const groups = new Map()
  for (const r of rows) {
    if (!isFinalSettlementRow(r)) continue
    const key = String(r.day).slice(0, 10)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(r)
  }
  return [...groups.entries()].sort((a,b)=>b[0].localeCompare(a[0])).slice(0,7).map(([date, list]) => {
    const category = (name) => {
      if (name === 'tie') return sideActionStats(list, ['tie']).rate
      const rows = list.filter((r) => r.predicted_result === name && ['banker', 'player'].includes(r.actual_result))
      return pctText(rows.filter((r) => r.actual_result === name).length, rows.length)
    }
    return {
      date,
      rounds: countDistinctRounds(list),
      side_actions_available: list.every((row) => hasCompleteSavedSideActions(row)),
      banker_hit_rate: category('banker'),
      player_hit_rate: category('player'),
      tie_hit_rate: category('tie'),
      dragon_hit_rate: sideActionStats(list, ['bankerDragon','playerDragon']).rate,
      pair_hit_rate: sideActionStats(list, ['bankerPair','playerPair']).rate,
      six_hit_rate: sideActionStats(list, ['superSix']).rate,
    }
  })
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
  const value = String(role ?? '').toLowerCase()
  if (value.includes('manager')) return '管理員'
  if (value.includes('viewer')) return '觀察者'
  if (value.includes('super') || value.includes('total')) return '超級管理員'
  return '代理'
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

function httpError(statusCode, message) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function addDaysIso(dateText, days) {
  const date = new Date(`${dateText}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + Number(days))
  return date.toISOString().slice(0, 10)
}
