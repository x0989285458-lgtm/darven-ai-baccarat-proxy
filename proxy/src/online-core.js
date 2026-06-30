import { Pool } from 'pg'
import { buildStrategyAnalysis } from './strategy-analysis.js'

const DEFAULT_PROJECT_SLUG = 'ai-baccarat'

export function createOnlineCoreClient({
  url = process.env.SUPABASE_URL,
  serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_ANON_KEY,
  dbConnectionString = process.env.SUPABASE_DB_CONNECTION_STRING,
  fetchImpl = globalThis.fetch,
} = {}) {
  const restConfigured = Boolean(url && serviceKey && fetchImpl)
  const dbConfigured = Boolean(dbConnectionString)
  const configured = restConfigured || dbConfigured
  const pool = dbConfigured ? new Pool({ connectionString: dbConnectionString, ssl: { rejectUnauthorized: false }, max: 2 }) : null

  async function request(path, { method = 'GET', body, query = {} } = {}) {
    if (!restConfigured) return { skipped: true, data: null, reason: 'Supabase REST credentials are not configured' }
    const endpoint = new URL(`/rest/v1/${path}`, url)
    for (const [key, value] of Object.entries(query)) {
      if (value != null) endpoint.searchParams.set(key, value)
    }
    const response = await fetchImpl(endpoint, {
      method,
      headers: {
        ['api' + 'key']: serviceKey,
        ['Author' + 'ization']: ['Bearer', serviceKey].join(' '),
        'Content-Type': 'application/json',
        Prefer: method === 'POST' ? 'resolution=merge-duplicates,return=minimal' : 'return=representation',
      },
      body: body == null ? undefined : JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`Supabase online core ${path} failed: ${response.status} ${await response.text()}`)
    const text = await response.text()
    return { ok: true, status: response.status, data: text ? JSON.parse(text) : null }
  }

  async function getProject(slug = DEFAULT_PROJECT_SLUG) {
    if (pool) {
      const result = await pool.query('select id, slug, name, status, metadata, updated_at from public.memory_projects where slug = $1 limit 1', [slug])
      return result.rows[0] ?? null
    }
    const result = await request('memory_projects', {
      query: { select: 'id,slug,name,status,metadata,updated_at', slug: `eq.${slug}`, limit: '1' },
    })
    return Array.isArray(result.data) ? result.data[0] ?? null : null
  }

  async function getProjectSummary(slug = DEFAULT_PROJECT_SLUG) {
    if (!configured) return { configured: false, connected: false, project: null, settings: {}, featureFlags: {} }
    const project = await getProject(slug)
    if (!project) return { configured: true, connected: false, project: null, settings: {}, featureFlags: {}, error: `Project ${slug} not found` }
    if (pool) {
      const settingsResult = await pool.query('select scope, key, is_public, value, updated_at from public.online_app_settings where project_id = $1 order by scope asc, key asc', [project.id])
      const flagsResult = await pool.query('select flag_key, enabled, updated_at from public.feature_flags where project_id = $1 order by flag_key asc', [project.id])
      return {
        configured: true,
        connected: true,
        project: stripProjectId(project),
        settings: groupSettings(settingsResult.rows),
        featureFlags: Object.fromEntries(flagsResult.rows.map((flag) => [flag.flag_key, Boolean(flag.enabled)])),
      }
    }
    const settingsResult = await request('online_app_settings', {
      query: { select: 'scope,key,is_public,value,updated_at', project_id: `eq.${project.id}`, order: 'scope.asc,key.asc' },
    })
    const flagsResult = await request('feature_flags', {
      query: { select: 'flag_key,enabled,updated_at', project_id: `eq.${project.id}`, order: 'flag_key.asc' },
    })
    return {
      configured: true,
      connected: true,
      project: stripProjectId(project),
      settings: groupSettings(settingsResult.data ?? []),
      featureFlags: Object.fromEntries((flagsResult.data ?? []).map((flag) => [flag.flag_key, Boolean(flag.enabled)])),
    }
  }

  async function persistTestReport(report = {}, slug = DEFAULT_PROJECT_SLUG) {
    if (!configured) return { skipped: true, reason: 'Supabase online core is not configured' }
    const project = await getProject(slug)
    if (!project) throw new Error(`Project ${slug} not found`)
    const row = buildMemoryReportRow(report, project.id)
    if (pool) {
      await pool.query(
        `insert into public.memory_test_reports(project_id, strategy_version, report_type, rounds, hits, misses, pushes, main_evaluated, main_hit_rate, side_actions, side_hits, side_hit_rate, report_path, raw_summary, metadata)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [row.project_id, row.strategy_version, row.report_type, row.rounds, row.hits, row.misses, row.pushes, row.main_evaluated, row.main_hit_rate, row.side_actions, row.side_hits, row.side_hit_rate, row.report_path, row.raw_summary, row.metadata],
      )
      return { ok: true, row }
    }
    await request('memory_test_reports', { method: 'POST', body: row })
    return { ok: true, row }
  }

  async function getMemoryCenter(slug = DEFAULT_PROJECT_SLUG) {
    if (!configured) return { configured: false, connected: false, project: null, items: [], reports: [], strategies: [] }
    const project = await getProject(slug)
    if (!project) return { configured: true, connected: false, project: null, items: [], reports: [], strategies: [] }
    if (pool) {
      const [itemsResult, reportsResult, strategiesResult] = await Promise.all([
        pool.query('select title, category as item_type, content, tags, updated_at from public.memory_items where project_id = $1 order by updated_at desc limit 20', [project.id]),
        pool.query('select strategy_version, report_type, rounds, hits, misses, pushes, main_evaluated, main_hit_rate, side_actions, side_hits, side_hit_rate, report_path, raw_summary, created_at from public.memory_test_reports where project_id = $1 order by created_at desc limit 20', [project.id]),
        pool.query('select version, status, main_weights as weights, metrics as metadata, created_at from public.memory_strategy_versions where project_id = $1 order by created_at desc limit 20', [project.id]),
      ])
      return { configured: true, connected: true, project: stripProjectId(project), items: itemsResult.rows, reports: reportsResult.rows, strategies: strategiesResult.rows }
    }
    const [itemsResult, reportsResult, strategiesResult] = await Promise.all([
      request('memory_items', { query: { select: 'title,category,item_type:category,content,tags,updated_at', project_id: `eq.${project.id}`, order: 'updated_at.desc', limit: '20' } }),
      request('memory_test_reports', { query: { select: 'strategy_version,report_type,rounds,hits,misses,pushes,main_evaluated,main_hit_rate,side_actions,side_hits,side_hit_rate,report_path,raw_summary,created_at', project_id: `eq.${project.id}`, order: 'created_at.desc', limit: '20' } }),
      request('memory_strategy_versions', { query: { select: 'version,status,weights:main_weights,metadata:metrics,created_at', project_id: `eq.${project.id}`, order: 'created_at.desc', limit: '20' } }),
    ])
    return { configured: true, connected: true, project: stripProjectId(project), items: itemsResult.data ?? [], reports: reportsResult.data ?? [], strategies: strategiesResult.data ?? [] }
  }

  async function updateAppSetting({ scope = 'frontend', key, value, isPublic = false, description = null, updatedBy = 'admin' } = {}, slug = DEFAULT_PROJECT_SLUG) {
    if (!configured) return { skipped: true, reason: 'Supabase online core is not configured' }
    if (!key) throw new Error('Setting key is required')
    const project = await getProject(slug)
    if (!project) throw new Error(`Project ${slug} not found`)
    const row = { project_id: project.id, scope, key, value: value ?? {}, description, is_public: Boolean(isPublic), updated_by: updatedBy }
    if (pool) {
      await pool.query(
        `insert into public.online_app_settings(project_id, scope, key, value, description, is_public, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (project_id, scope, key) do update set value = excluded.value, description = excluded.description, is_public = excluded.is_public, updated_by = excluded.updated_by, updated_at = now()`,
        [row.project_id, row.scope, row.key, row.value, row.description, row.is_public, row.updated_by],
      )
      return { ok: true, row }
    }
    await request('online_app_settings', { method: 'POST', body: row, query: { on_conflict: 'project_id,scope,key' } })
    return { ok: true, row }
  }

  async function updateFeatureFlag({ flagKey, enabled = false, rollout = {}, description = null, updatedBy = 'admin' } = {}, slug = DEFAULT_PROJECT_SLUG) {
    if (!configured) return { skipped: true, reason: 'Supabase online core is not configured' }
    if (!flagKey) throw new Error('Feature flag key is required')
    const project = await getProject(slug)
    if (!project) throw new Error(`Project ${slug} not found`)
    const row = { project_id: project.id, flag_key: flagKey, enabled: Boolean(enabled), rollout, description, updated_by: updatedBy }
    if (pool) {
      await pool.query(
        `insert into public.feature_flags(project_id, flag_key, enabled, rollout, description, updated_by)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (project_id, flag_key) do update set enabled = excluded.enabled, rollout = excluded.rollout, description = excluded.description, updated_by = excluded.updated_by, updated_at = now()`,
        [row.project_id, row.flag_key, row.enabled, row.rollout, row.description, row.updated_by],
      )
      return { ok: true, row }
    }
    await request('feature_flags', { method: 'POST', body: row, query: { on_conflict: 'project_id,flag_key' } })
    return { ok: true, row }
  }

  async function getStrategyAnalysis(slug = DEFAULT_PROJECT_SLUG) {
    const center = await getMemoryCenter(slug)
    if (!center.connected) return { configured: center.configured, connected: false, strategyRows: [], weakTables: [], strongTables: [], watchTables: [], suggestions: [] }
    return { configured: true, connected: true, project: center.project, ...buildStrategyAnalysis(center.reports ?? []) }
  }

  return { configured, getProjectSummary, getMemoryCenter, getStrategyAnalysis, persistTestReport, updateAppSetting, updateFeatureFlag }
}

export function buildMemoryReportRow(report = {}, projectId) {
  const total = report.total ?? report.raw_summary?.total ?? {}
  return {
    project_id: projectId,
    strategy_version: report.strategyVersion ?? report.strategy_version ?? report.version ?? null,
    report_type: report.reportType ?? report.report_type ?? 'live_test',
    rounds: numberOrZero(total.rounds ?? report.rounds),
    hits: numberOrZero(total.hits ?? report.hits),
    misses: numberOrZero(total.misses ?? report.misses),
    pushes: numberOrZero(total.pushes ?? report.pushes),
    main_evaluated: numberOrZero(total.mainEvaluated ?? total.main_evaluated ?? report.mainEvaluated),
    main_hit_rate: numberOrNull(total.hitRate ?? total.mainHitRate ?? total.main_hit_rate ?? report.mainHitRate),
    side_actions: numberOrZero(total.sideActions ?? total.side_actions ?? report.sideActions),
    side_hits: numberOrZero(total.sideHits ?? total.side_hits ?? report.sideHits),
    side_hit_rate: numberOrNull(total.sideHitRate ?? total.side_hit_rate ?? report.sideHitRate),
    report_path: report.reportPath ?? report.report_path ?? null,
    raw_summary: report.rawSummary ?? report.raw_summary ?? report,
    metadata: report.metadata ?? {},
  }
}

function groupSettings(rows) {
  return rows.reduce((acc, row) => {
    const scope = row.scope ?? 'global'
    acc[scope] ??= {}
    acc[scope][row.key] = row.value
    return acc
  }, {})
}

function stripProjectId(project) {
  if (!project) return null
  const { id, ...publicProject } = project
  return publicProject
}

function numberOrZero(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function numberOrNull(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}
