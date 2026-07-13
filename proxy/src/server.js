import http from 'node:http'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createProxyState } from './state-store.js'
import { createMtClient } from './mt-client.js'
import { createChromeCaptureClient } from './chrome-capture.js'
import { applyCloudCapturePayload, createCloudCaptureClient, parseCloudCapturePayload } from './cloud-capture.js'
import { loadLocalEnv, maskToken, resolveDeployConfig } from './config.js'
import { buildLivePrediction, createSupabaseIngestionClient } from './supabase-writer.js'
import { createOnlineCoreClient } from './online-core.js'
import { createLicenseAdminClient } from './license-admin.js'
import { chooseCaptureSource, describeCaptureStatus } from './capture-source.js'
import { buildOperationalEvent, toStatusEvent } from './event-layer.js'
import { BUILD_VERSION } from './build-version.js'

const VERSION = BUILD_VERSION
const SERVICE = 'Draven MT資料代理伺服器'

export function createApp({ autoConnect, token = process.env.MT_TOKEN, port = Number(process.env.PORT ?? 8787), host = process.env.HOST, captureUrl = process.env.CHROME_CAPTURE_URL, cloudBrowserUrl = process.env.CLOUD_BROWSER_URL, deployMode = process.env.DEPLOY_MODE ?? 'local', captureSource: requestedCaptureSource = process.env.CAPTURE_SOURCE, frontendOrigin = process.env.PUBLIC_FRONTEND_ORIGIN || '*', controlToken = process.env.PROXY_CONTROL_TOKEN || process.env.WORKER_ADMIN_KEY, controlAllowedOrigin = process.env.CONTROL_ALLOWED_ORIGIN || process.env.PUBLIC_FRONTEND_ORIGIN || '', ingestKey = process.env.INGEST_KEY || process.env.WORKER_ADMIN_KEY, now = Date.now, predictionTtlMs = Number(process.env.PREDICTION_TTL_MS ?? 120000), production = process.env.NODE_ENV === 'production', memberAuthRequired = production, memberSessionTtlMs = Number(process.env.MEMBER_SESSION_TTL_MS ?? 10 * 60 * 1000), fetchImpl = globalThis.fetch, supabaseClient = createSupabaseIngestionClient(), onlineCoreClient = createOnlineCoreClient(), licenseAdminClient = createLicenseAdminClient() } = {}) {
  const deployConfig = resolveDeployConfig({
    DEPLOY_MODE: deployMode,
    CAPTURE_SOURCE: requestedCaptureSource,
    PUBLIC_FRONTEND_ORIGIN: frontendOrigin,
    CLOUD_BROWSER_URL: cloudBrowserUrl,
    CHROME_CAPTURE_URL: captureUrl,
    MT_TOKEN: token,
    AUTO_CONNECT: autoConnect === undefined ? process.env.AUTO_CONNECT : String(autoConnect),
    CLOUD_CAPTURE_POLL_MS: process.env.CLOUD_CAPTURE_POLL_MS,
  })
  const shouldAutoConnect = autoConnect ?? deployConfig.autoConnect
  const strictRealCardRounds = process.env.REQUIRE_REAL_CARD_ROUNDS !== 'false'
  const adminSessions = new Map()
  const ingestSequences = new Map()
  const pendingPredictions = new Map()
  const settlingPredictionKeys = new Set()
  const memberSessions = new Map()
  let tablesReceivedAtMs = 0
  const actionablePredictionTtlMs = Math.max(1000, Number(predictionTtlMs) || 120000)
  const resolvedMemberSessionTtlMs = Math.min(10 * 60 * 1000, Math.max(60000, Number(memberSessionTtlMs) || 10 * 60 * 1000))
  const adminSessionTtlMs = Math.max(60000, Number(process.env.ADMIN_SESSION_TTL_MS ?? 30 * 60 * 1000) || 30 * 60 * 1000)
  const state = createProxyState({
    inferSnapshotRounds: !strictRealCardRounds,
    onTablesUpdated: (tables) => {
      tablesReceivedAtMs = now()
      for (const table of tables) savePendingPrediction(table)
    },
    onRoundEvent: async (round, table) => {
      if (!supabaseClient?.configured && !supabaseClient?.persistRound) return
      if (strictRealCardRounds && !hasRealCardCodes(round)) return
      const pendingKey = predictionTargetKey(round.tableId ?? table.tableId, round.shoe, round.round)
      const precomputedPrediction = pendingPredictions.get(pendingKey)
      if (!precomputedPrediction) return
      if (now() - Number(precomputedPrediction.createdAtMs ?? 0) > actionablePredictionTtlMs) {
        return
      }
      if (settlingPredictionKeys.has(pendingKey)) return
      settlingPredictionKeys.add(pendingKey)
      try {
        await supabaseClient.ensureInitialStrategy?.()
        await supabaseClient.persistRound?.(round, table, precomputedPrediction)
        pendingPredictions.delete(pendingKey)
        state.setStatus({ persistenceStatus: 'ok', persistenceError: null })
      } catch (error) {
        state.setStatus({ persistenceStatus: 'error', persistenceError: error?.message ?? String(error) })
      } finally {
        settlingPredictionKeys.delete(pendingKey)
      }
    },
  })
  const captureSource = deployConfig.captureSource || chooseCaptureSource({ chromeCaptureUrl: captureUrl, cloudBrowserUrl, token })
  state.setStatus({ deployMode: deployConfig.deployMode, captureSource, captureMode: captureSource, cloudReady: true, statusText: describeCaptureStatus({ captureSource }) })
  const mtClient = createMtClient({ token, state })
  const chromeClient = createChromeCaptureClient({ url: captureUrl, state })
  const cloudCaptureClient = createCloudCaptureClient({ url: cloudBrowserUrl, state, writer: supabaseClient, fetchImpl, pollMs: deployConfig.cloudCapturePollMs, adminKey: process.env.WORKER_ADMIN_KEY })

  async function recordOperationalEvent({ component, kind, message, statusCode = null, metadata = {} }) {
    const event = buildOperationalEvent({ component, kind, message, statusCode, metadata })
    state.setStatus(toStatusEvent(event))
    await supabaseClient?.writeOperationalEvent?.(event).catch(() => {})
    return event
  }

  async function handle(method, url, rawBody = '', headers = {}) {
    const requestUrl = new URL(url, 'http://127.0.0.1')
    const pathname = requestUrl.pathname
    if (method === 'OPTIONS') return jsonResponse(204, {}, frontendOrigin)
    if (!['GET', 'POST'].includes(method)) return jsonResponse(405, { error: 'Method Not Allowed' }, frontendOrigin)

    async function adminWrite(action, { requireSession = false, requireSuper = false } = {}) {
      try {
        const payload = parseJsonBody(rawBody)
        const session = requireSession ? (requireSuper ? requireSuperAdminSession(payload, requestUrl, headers) : requireAdminSession(payload, requestUrl, headers)) : null
        const scopedPayload = session ? { ...payload, adminAccount: session.adminAccount } : payload
        return jsonResponse(200, await action(scopedPayload, session), frontendOrigin)
      } catch (error) {
        return jsonResponse(error?.statusCode ?? 400, { ok: false, error: error?.message ?? String(error) }, frontendOrigin)
      }
    }

    if (pathname === '/health') {
      return jsonResponse(200, { ok: true, service: SERVICE, version: VERSION, deployMode: deployConfig.deployMode }, frontendOrigin)
    }
    if (pathname === '/api/status') {
      const status = state.snapshot().status
      await persistCloudStateSnapshot(status)
      const cloudStatus = await readCloudSnapshotStatus()
      const nextStatus = { ...state.snapshot().status, ...cloudStatus }
      return jsonResponse(200, { ...nextStatus, version: VERSION, deployMode: deployConfig.deployMode, statusText: cloudStatus?.statusText ?? describeCaptureStatus(nextStatus) }, frontendOrigin)
    }
    if (pathname === '/api/tables') {
      if (hasSensitiveAuthQuery(requestUrl)) return jsonResponse(400, { ok: false, error: 'session token is not allowed in query' }, frontendOrigin)
      if (!isMemberSessionAuthorized(headers)) return jsonResponse(401, { ok: false, error: 'member session is required' }, frontendOrigin)
      return jsonResponse(200, await readBestTables(), frontendOrigin)
    }
    if (pathname === '/api/snapshot') {
      if (hasSensitiveAuthQuery(requestUrl)) return jsonResponse(400, { ok: false, error: 'session token is not allowed in query' }, frontendOrigin)
      if (!isMemberSessionAuthorized(headers)) return jsonResponse(401, { ok: false, error: 'member session is required' }, frontendOrigin)
      return jsonResponse(200, state.snapshot(), frontendOrigin)
    }
    if (method === 'POST' && pathname === '/api/cloud-ingest/snapshot') {
      if (!ingestKey || !safeEqual(headers['x-worker-key'], ingestKey)) return jsonResponse(401, { ok: false, error: 'unauthorized' }, frontendOrigin)
      if (Buffer.byteLength(rawBody, 'utf8') > 1024 * 1024) return jsonResponse(413, { ok: false, error: 'payload_too_large' }, frontendOrigin)
      try {
        const envelope = parseJsonBody(rawBody)
        validateIngestEnvelope(envelope, now())
        const sessionId = String(envelope.snapshot.sessionId ?? envelope.snapshot.session_id ?? 'cloud-browser')
        const previous = ingestSequences.get(sessionId)
        if (previous != null && envelope.sequence <= previous) {
          return jsonResponse(200, { ok: true, duplicate: true, sequence: envelope.sequence }, frontendOrigin)
        }
        const parsed = parseCloudCapturePayload(envelope.snapshot)
        await applyCloudCapturePayload({ parsed, state, writer: supabaseClient })
        ingestSequences.set(sessionId, envelope.sequence)
        return jsonResponse(200, { ok: true, duplicate: false, sequence: envelope.sequence, tableCount: parsed.tables.length }, frontendOrigin)
      } catch (error) {
        return jsonResponse(error?.statusCode ?? 400, { ok: false, error: error?.message ?? String(error) }, frontendOrigin)
      }
    }
    if (pathname === '/api/cloud-capture/status') {
      return jsonResponse(200, buildCloudCaptureManagementStatus(), frontendOrigin)
    }
    if (pathname === '/api/cloud-data/status') {
      const snapshot = state.snapshot()
      try {
        const formalStatus = await licenseAdminClient.getCloudDataStatus?.()
        const cloudStatus = await readCloudSnapshotStatus()
        const analytics = await licenseAdminClient.getDailyAnalytics?.().catch(() => null)
        const todayRoundCount = Number(analytics?.todayRoundCount ?? await readTodayRoundCount()) || 0
        const tableCount = Number(cloudStatus?.tableCount ?? snapshot.tables.length ?? formalStatus?.tableCount ?? 0)
        const message = appendTodayRoundMessage(formalStatus?.message ?? cloudStatus?.statusText, todayRoundCount)
        return jsonResponse(200, { ok: true, mtAutoLoginEnabled: false, ...formalStatus, message, todayRoundCount, tableStats: analytics?.tableStats ?? [], dailyReports: analytics?.dailyReports ?? [], captureSource: cloudStatus?.captureSource ?? captureSource, deployMode: deployConfig.deployMode, tableCount, status: { ...snapshot.status, ...cloudStatus } }, frontendOrigin)
      } catch (error) {
        return jsonResponse(200, { ok: true, mtAutoLoginEnabled: false, captureSource, deployMode: deployConfig.deployMode, tableCount: snapshot.tables.length, status: snapshot.status, error: error?.message ?? String(error) }, frontendOrigin)
      }
    }
    if (method === 'POST' && pathname === '/api/cloud-capture/tick') {
      const controlError = requireControlAccess(headers)
      if (controlError) return controlError
      const parsed = await cloudCaptureClient.tick()
      return jsonResponse(200, { ok: Boolean(parsed), running: cloudCaptureClient.isRunning(), status: state.snapshot().status }, frontendOrigin)
    }
    if (method === 'POST' && pathname === '/api/cloud-capture/start') {
      const controlError = requireControlAccess(headers)
      if (controlError) return controlError
      if (!cloudBrowserUrl) return jsonResponse(400, { ok: false, error: 'CLOUD_BROWSER_URL is required before starting cloud capture' }, frontendOrigin)
      cloudCaptureClient.start()
      return jsonResponse(200, { ok: true, running: cloudCaptureClient.isRunning(), status: state.snapshot().status }, frontendOrigin)
    }
    if (method === 'POST' && pathname === '/api/cloud-capture/stop') {
      const controlError = requireControlAccess(headers)
      if (controlError) return controlError
      cloudCaptureClient.stop()
      return jsonResponse(200, { ok: true, running: cloudCaptureClient.isRunning(), status: state.snapshot().status }, frontendOrigin)
    }
    if (pathname === '/api/online-core/status') {
      try {
        const summary = await onlineCoreClient.getProjectSummary?.('ai-baccarat')
        return jsonResponse(200, { ...summary, connected: Boolean(summary?.connected ?? summary?.project) }, frontendOrigin)
      } catch (error) {
        return jsonResponse(200, { connected: false, configured: Boolean(onlineCoreClient?.configured), error: error?.message ?? String(error) }, frontendOrigin)
      }
    }
    if (pathname === '/api/online-core/memory-center') {
      try {
        const center = await onlineCoreClient.getMemoryCenter?.('ai-baccarat')
        return jsonResponse(200, { ...center, connected: Boolean(center?.connected ?? center?.project) }, frontendOrigin)
      } catch (error) {
        return jsonResponse(200, { connected: false, configured: Boolean(onlineCoreClient?.configured), items: [], reports: [], strategies: [], error: error?.message ?? String(error) }, frontendOrigin)
      }
    }
    if (pathname === '/api/online-core/strategy-analysis') {
      try {
        const analysis = await onlineCoreClient.getStrategyAnalysis?.('ai-baccarat')
        return jsonResponse(200, { ...analysis, connected: Boolean(analysis?.connected ?? analysis?.strategyRows) }, frontendOrigin)
      } catch (error) {
        return jsonResponse(200, { connected: false, configured: Boolean(onlineCoreClient?.configured), strategyRows: [], weakTables: [], strongTables: [], watchTables: [], suggestions: [], error: error?.message ?? String(error) }, frontendOrigin)
      }
    }
    if (method === 'POST' && pathname === '/api/online-core/settings') {
      try {
        const payload = parseJsonBody(rawBody)
        const session = requireSuperAdminSession(payload, requestUrl, headers)
        const result = await onlineCoreClient.updateAppSetting?.({ ...payload, updatedBy: session.adminAccount })
        return jsonResponse(200, { ok: true, result }, frontendOrigin)
      } catch (error) {
        return jsonResponse(error?.statusCode ?? 400, { ok: false, error: error?.message ?? String(error) }, frontendOrigin)
      }
    }
    if (method === 'POST' && pathname === '/api/online-core/feature-flags') {
      try {
        const payload = parseJsonBody(rawBody)
        const session = requireSuperAdminSession(payload, requestUrl, headers)
        const result = await onlineCoreClient.updateFeatureFlag?.({ ...payload, updatedBy: session.adminAccount })
        return jsonResponse(200, { ok: true, result }, frontendOrigin)
      } catch (error) {
        return jsonResponse(error?.statusCode ?? 400, { ok: false, error: error?.message ?? String(error) }, frontendOrigin)
      }
    }
    if (pathname === '/api/online-license/status') {
      try {
        const session = requireAdminSession({}, requestUrl, headers)
        return jsonResponse(200, await licenseAdminClient.getStatus?.({ adminAccount: session.adminAccount }), frontendOrigin)
      } catch (error) {
        return jsonResponse(error?.statusCode ?? 401, { configured: Boolean(licenseAdminClient?.configured), managers: [], agents: [], plans: [], licenses: [], error: error?.message ?? String(error) }, frontendOrigin)
      }
    }
    if (method === 'POST' && pathname === '/api/online-license/member-login') return adminWrite(async () => {
      const result = await licenseAdminClient.validateMemberLogin?.(parseJsonBody(rawBody))
      if (!result?.ok) return result
      return { ...result, ...issueMemberSession(result) }
    })
    if (method === 'POST' && pathname === '/api/online-license/agent-login') return adminWrite(async (payload) => {
      const result = await licenseAdminClient.validateAgentLogin?.(payload)
      if (!result?.ok) return result
      const session = issueAdminSession(result, payload.agentAccount)
      return { ...result, adminSessionToken: session.token, sessionExpiresAt: session.expiresAt }
    })
    if (method === 'POST' && pathname === '/api/online-license/bootstrap') return adminWrite((payload) => licenseAdminClient.bootstrap?.(payload), { requireSession: true, requireSuper: true })
    if (method === 'POST' && pathname === '/api/online-license/agents') return adminWrite((payload) => licenseAdminClient.createAgent?.(payload), { requireSession: true })
    if (method === 'POST' && pathname === '/api/online-license/agents/delete') return adminWrite((payload) => licenseAdminClient.deleteAgents?.(payload), { requireSession: true })
    if (method === 'POST' && pathname === '/api/online-license/licenses') return adminWrite((payload) => licenseAdminClient.createLicense?.(payload), { requireSession: true })
    if (method === 'POST' && pathname === '/api/online-license/licenses/status') return adminWrite((payload) => licenseAdminClient.setLicenseStatus?.(payload), { requireSession: true })
    if (method === 'POST' && pathname === '/api/online-license/licenses/extend') return adminWrite((payload) => licenseAdminClient.extendLicense?.(payload), { requireSession: true })
    if (method === 'POST' && pathname === '/api/online-license/licenses/delete') return adminWrite((payload) => licenseAdminClient.deleteLicense?.(payload), { requireSession: true })

    return jsonResponse(404, { error: 'Not Found' }, frontendOrigin)
  }

  function requireControlAccess(headers = {}) {
    const origin = headers.origin ?? headers.Origin
    const allowedOrigin = String(controlAllowedOrigin || '').trim()
    if (allowedOrigin && allowedOrigin !== '*' && origin && String(origin) !== allowedOrigin) {
      void recordOperationalEvent({ component: 'control_api', kind: 'origin_denied', statusCode: 403, message: 'control origin is not allowed', metadata: { origin } })
      return jsonResponse(403, { ok: false, error: 'control origin is not allowed' }, frontendOrigin)
    }
    if (!controlToken) {
      if (production) {
        void recordOperationalEvent({ component: 'control_api', kind: 'missing_configuration', statusCode: 503, message: 'control token is not configured' })
        return jsonResponse(503, { ok: false, error: 'control token is not configured' }, frontendOrigin)
      }
      return null
    }
    const provided = headers['x-control-token']
    if (safeEqual(provided, controlToken)) return null
    void recordOperationalEvent({ component: 'control_api', kind: 'unauthorized', statusCode: 401, message: 'control token is required' })
    return jsonResponse(401, { ok: false, error: 'control token is required' }, frontendOrigin)
  }

  function issueAdminSession(loginResult = {}, fallbackAccount = '') {
    const adminAccount = resolveAdminAccount(loginResult, fallbackAccount)
    const token = crypto.randomBytes(32).toString('base64url')
    const expiresAtMs = Date.now() + adminSessionTtlMs
    const expiresAt = new Date(expiresAtMs).toISOString()
    adminSessions.set(token, { adminAccount, role: resolveAdminRole(loginResult), expiresAtMs })
    return { token, expiresAt }
  }

  function issueMemberSession(loginResult = {}) {
    const expiresAtMs = now() + resolvedMemberSessionTtlMs
    const memberSessionToken = crypto.randomBytes(32).toString('base64url')
    for (const [token, session] of memberSessions) {
      if (session.expiresAtMs <= now()) memberSessions.delete(token)
    }
    memberSessions.set(memberSessionToken, {
      memberAccount: loginResult.memberAccount,
      expiresAtMs,
    })
    return { memberSessionToken, sessionExpiresAt: new Date(expiresAtMs).toISOString() }
  }

  function isMemberSessionAuthorized(headers = {}) {
    if (!memberAuthRequired) return true
    const token = headers.authorization?.replace(/^Bearer\s+/i, '')
    const session = token ? memberSessions.get(String(token)) : null
    if (!session || session.expiresAtMs <= now()) {
      if (token) memberSessions.delete(String(token))
      return false
    }
    return Boolean(session.memberAccount)
  }

  function requireAdminSession(payload = {}, requestUrl, headers = {}) {
    const token = payload.adminSessionToken
      ?? headers['x-admin-session-token']
      ?? headers['authorization']?.replace(/^Bearer\s+/i, '')
    const session = token ? adminSessions.get(String(token)) : null
    if (!session || session.expiresAtMs <= Date.now()) {
      if (token) adminSessions.delete(String(token))
      const error = new Error('admin session is required')
      error.statusCode = 401
      throw error
    }
    return session
  }


  function requireSuperAdminSession(payload = {}, requestUrl, headers = {}) {
    const session = requireAdminSession(payload, requestUrl, headers)
    if (String(session.adminAccount).toLowerCase() === 'dv1788' || ['total','super'].includes(String(session.role ?? '').toLowerCase())) return session
    const error = new Error('super admin session is required')
    error.statusCode = 403
    throw error
  }

  async function persistCloudStateSnapshot(status) {
    if (!supabaseClient?.configured || typeof supabaseClient.writeCloudCaptureStatus !== 'function') return
    try {
      const snapshot = state.snapshot()
      const sessionId = status.captureSessionId ?? `${deployConfig.deployMode}-${captureSource}`
      await supabaseClient.writeCloudCaptureStatus({ sessionId, captureSource, status: snapshot.status })
      if (typeof supabaseClient.writeCloudTableSnapshot === 'function') {
        await supabaseClient.writeCloudTableSnapshot({ sessionId, tables: snapshot.tables, status: snapshot.status })
      }
      state.setStatus({ persistenceStatus: 'ok', persistenceError: null })
    } catch (error) {
      const event = await recordOperationalEvent({ component: 'supabase_writer', kind: 'persist_cloud_state', message: error?.message ?? String(error) })
      state.setStatus({ persistenceStatus: 'error', persistenceError: event.eventMessage })
    }
  }

  async function readTodayRoundCount() {
    if (!supabaseClient?.configured || typeof supabaseClient.countTodayPredictionRounds !== 'function') return 0
    try {
      return Number(await supabaseClient.countTodayPredictionRounds()) || 0
    } catch (error) {
      state.setStatus({ cloudReadStatus: 'error', cloudReadError: error?.message ?? String(error) })
      return 0
    }
  }

  function appendTodayRoundMessage(message, count) {
    const base = message || '本機VPN抓牌同步中'
    return `${base}｜今日已抓${Number(count) || 0}局`
  }

  const CLOUD_SNAPSHOT_MAX_AGE_MS = Number(process.env.CLOUD_SNAPSHOT_MAX_AGE_MS ?? 120000)

  function isFreshCloudTimestamp(value, maxAgeMs = CLOUD_SNAPSHOT_MAX_AGE_MS) {
    const timestamp = Date.parse(value ?? '')
    if (!Number.isFinite(timestamp)) return false
    return Date.now() - timestamp <= Math.max(1000, Number(maxAgeMs) || 120000)
  }

  function isLiveCloudSnapshotUsable(snapshot, requireFresh = false) {
    if (!requireFresh) return true
    const source = String(snapshot?.capture_source ?? snapshot?.captureSource ?? '').toLowerCase()
    // Local/VPN snapshots are an intentional fallback feed and are not tied to the
    // cloud-browser worker heartbeat. Only cloud-browser/unknown snapshots must be
    // recent enough to be treated as live table data.
    if (source === 'local_chrome') return true
    return isFreshCloudTimestamp(snapshot?.snapshot_at ?? snapshot?.created_at ?? snapshot?.updated_at)
  }

  async function readLatestCloudSnapshot({ requireFresh = false } = {}) {
    if (!supabaseClient?.configured || typeof supabaseClient.getLatestCloudTableSnapshot !== 'function') return null
    try {
      const snapshot = await supabaseClient.getLatestCloudTableSnapshot()
      if (!snapshot || !Array.isArray(snapshot.tables)) return null
      if (!isLiveCloudSnapshotUsable(snapshot, requireFresh)) return null
      return snapshot
    } catch (error) {
      state.setStatus({ cloudReadStatus: 'error', cloudReadError: error?.message ?? String(error) })
      return null
    }
  }

  async function readBestTables() {
    const localTables = state.snapshot().tables
    if (localTables.length > 0) {
      const actionable = tablesReceivedAtMs > 0 && now() - tablesReceivedAtMs <= actionablePredictionTtlMs
      return localTables.map((table) => withLivePrediction(table, actionable))
    }
    const cloudSnapshot = await readLatestCloudSnapshot({ requireFresh: true })
    return (cloudSnapshot?.tables ?? []).map((table) => withLivePrediction(table))
  }

  function savePendingPrediction(table) {
    const generated = { ...buildLivePrediction(table), createdAtMs: now() }
    const key = predictionTargetKey(generated.targetTableId, generated.targetShoe, generated.targetRound)
    if (!pendingPredictions.has(key)) pendingPredictions.set(key, structuredClone(generated))
    return pendingPredictions.get(key)
  }

  function withLivePrediction(table, actionable = true) {
    return { ...table, prediction: actionable ? structuredClone(savePendingPrediction(table)) : null }
  }


  async function readCloudSnapshotStatus() {
    if (state.snapshot().tables.length > 0) return null
    if (!supabaseClient?.configured || typeof supabaseClient.getLatestCloudCaptureStatus !== 'function') return null
    try {
      const status = await supabaseClient.getLatestCloudCaptureStatus()
      const snapshot = await readLatestCloudSnapshot({ requireFresh: true })
      const statusSource = String(status?.capture_source ?? status?.captureSource ?? '').toLowerCase()
      const statusIsFresh = statusSource === 'local_chrome' || isFreshCloudTimestamp(status?.last_message_at ?? status?.snapshot_at ?? status?.updated_at ?? status?.created_at)
      if (!statusIsFresh && !snapshot) {
        const event = await recordOperationalEvent({ component: 'cloud_status', kind: 'stale_data', message: 'Cloud snapshot is stale' })
        return {
          captureSource: status?.capture_source ?? captureSource,
          captureMode: status?.capture_source ?? captureSource,
          connected: false,
          authenticated: false,
          tableCount: 0,
          lastMessageAt: null,
          lastTablesAt: null,
          statusText: '雲端資料過期，等待Worker重新抓牌',
          errorMessage: event.eventMessage,
          ...toStatusEvent(event),
        }
      }
      const snapshotTableCount = Array.isArray(snapshot?.tables) ? snapshot.tables.length : Number(snapshot?.table_count ?? 0)
      const preferSnapshot = snapshotTableCount > Number(statusIsFresh ? status?.table_count ?? 0 : 0)
      const source = preferSnapshot ? snapshot?.capture_source : (status?.capture_source ?? snapshot?.capture_source)
      return {
        captureSource: source ?? captureSource,
        captureMode: source ?? captureSource,
        connected: Boolean(preferSnapshot ? snapshotTableCount : (statusIsFresh ? status?.connected ?? snapshotTableCount : false)),
        authenticated: Boolean(preferSnapshot ? snapshotTableCount : (statusIsFresh ? status?.authenticated ?? snapshotTableCount : false)),
        tableCount: Number(preferSnapshot ? snapshotTableCount : (statusIsFresh ? status?.table_count ?? snapshot?.table_count ?? snapshotTableCount ?? 0 : 0)),
        lastMessageAt: preferSnapshot ? snapshot?.snapshot_at ?? status?.last_message_at ?? null : statusIsFresh ? status?.last_message_at ?? snapshot?.snapshot_at ?? null : null,
        lastTablesAt: snapshot?.snapshot_at ?? null,
        statusText: snapshotTableCount ? `本機VPN抓牌已同步${snapshotTableCount}桌` : statusIsFresh ? status?.status_text ?? null : '雲端資料過期，等待Worker重新抓牌',
        errorMessage: preferSnapshot ? null : statusIsFresh ? status?.error_message ?? null : 'Cloud snapshot is stale',
      }
    } catch (error) {
      state.setStatus({ cloudReadStatus: 'error', cloudReadError: error?.message ?? String(error) })
      return null
    }
  }

  function buildCloudCaptureManagementStatus() {
    const snapshot = state.snapshot()
    return {
      ok: true,
      workerConfigured: Boolean(cloudBrowserUrl),
      running: cloudCaptureClient.isRunning(),
      captureSource,
      deployMode: deployConfig.deployMode,
      pollMs: deployConfig.cloudCapturePollMs,
      status: snapshot.status,
      tableCount: snapshot.tables.length,
    }
  }

  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
    if ((req.method ?? 'GET') === 'GET' && requestUrl.pathname === '/api/tables/stream') {
      if (hasSensitiveAuthQuery(requestUrl)) {
        const result = jsonResponse(400, { ok: false, error: 'session token is not allowed in query' }, frontendOrigin)
        res.writeHead(result.statusCode, result.headers)
        res.end(result.body)
        return
      }
      if (!isMemberSessionAuthorized(req.headers)) {
        const result = jsonResponse(401, { ok: false, error: 'member session is required' }, frontendOrigin)
        res.writeHead(result.statusCode, result.headers)
        res.end(result.body)
        return
      }
      return streamTables(res)
    }
    let rawBody = ''
    try {
      rawBody = await readRequestBody(req)
    } catch (error) {
      const result = jsonResponse(error?.statusCode ?? 400, { ok: false, error: error?.message ?? String(error) }, frontendOrigin)
      res.writeHead(result.statusCode, result.headers)
      res.end(result.body, () => req.destroy())
      return
    }
    const result = await handle(req.method ?? 'GET', req.url ?? '/', rawBody, req.headers)
    res.writeHead(result.statusCode, result.headers)
    res.end(result.body)
  })

  const streamClients = new Set()
  let streamTimer = null
  let streamLastSignature = ''

  function compactTableSignature(table) {
    const bead = String(table.beadPlateRaw ?? table.trend?.bead_plate2 ?? '')
    const big = String(table.bigRoadRaw ?? table.trend?.big2 ?? '')
    return {
      id: table.tableId ?? table.table_id ?? table.id,
      shoe: table.shoe ?? table.trend?.current_shoe,
      round: table.round ?? table.trend?.current_round,
      beadLen: bead.length,
      beadTail: bead.slice(-24),
      bigLen: big.length,
      bigTail: big.slice(-32),
      banker: table.bankerCount ?? table.trend?.total_round_banker,
      player: table.playerCount ?? table.trend?.total_round_player,
      tie: table.tieCount ?? table.trend?.total_round_tie,
    }
  }

  function writeSse(res, event, payload) {
    if (res.destroyed || res.writableEnded) return
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
  }

  async function broadcastTables(force = false) {
    if (!streamClients.size) return
    try {
      const tables = await readBestTables()
      const signature = JSON.stringify(tables.map(compactTableSignature))
      const payload = { tables, updatedAt: new Date().toISOString(), tableCount: tables.length }
      if (tables.length && (force || signature !== streamLastSignature)) {
        streamLastSignature = signature
        for (const client of streamClients) writeSse(client, 'tables', payload)
      } else {
        const heartbeat = { updatedAt: new Date().toISOString(), tableCount: tables.length }
        for (const client of streamClients) writeSse(client, 'heartbeat', heartbeat)
      }
    } catch (error) {
      const payload = { message: error?.message ?? String(error), updatedAt: new Date().toISOString() }
      for (const client of streamClients) writeSse(client, 'error', payload)
    }
  }

  function ensureStreamTimer() {
    if (streamTimer) return
    streamTimer = setInterval(() => { void broadcastTables(false) }, 3000)
  }

  function stopStreamTimerIfIdle() {
    if (streamClients.size || !streamTimer) return
    clearInterval(streamTimer)
    streamTimer = null
  }

  function streamTables(res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'pragma': 'no-cache',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
      'access-control-allow-origin': frontendOrigin,
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'Content-Type,Authorization,X-Admin-Session-Token,X-Member-Session-Token,X-Control-Token',
    })
    streamClients.add(res)
    ensureStreamTimer()
    void broadcastTables(true)
    res.on('close', () => { streamClients.delete(res); stopStreamTimerIfIdle() })
  }
  const listenHost = host ?? (deployConfig.deployMode === 'cloud' ? '0.0.0.0' : '127.0.0.1')

  return {
    state,
    server,
    start() {
      if (shouldAutoConnect) {
        if (captureSource === 'cloud_browser' && cloudBrowserUrl) cloudCaptureClient.start()
        else if (captureUrl) chromeClient.start()
        else mtClient.connect()
      }
      return new Promise((resolve) => server.listen(port, listenHost, () => resolve(server)))
    },
    stop() {
      mtClient.stop()
      chromeClient.stop()
      cloudCaptureClient.stop()
      return new Promise((resolve) => server.close(() => resolve()))
    },
    async inject({ method = 'GET', url = '/', body = '', headers = {} } = {}) {
      return handle(method, url, body, headers)
    },
    cloudCaptureClient,
  }
}

function hasRealCardCodes(round = {}) {
  const result = Array.isArray(round.rawResult) ? round.rawResult : []
  const playerCards = [result[0], result[2], result[4]]
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0)
  const bankerCards = [result[1], result[3], result[5]]
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0)
  return playerCards.length >= 2 && bankerCards.length >= 2
}

function resolveAdminAccount(loginResult = {}, fallbackAccount = '') {
  return loginResult.account?.code
    ?? loginResult.account?.username
    ?? loginResult.agent?.code
    ?? loginResult.manager?.username
    ?? fallbackAccount
}

function resolveAdminRole(loginResult = {}) {
  return loginResult.account?.role
    ?? loginResult.agent?.role
    ?? loginResult.manager?.role
    ?? null
}

function safeEqual(provided, expected) {
  if (provided == null || expected == null) return false
  const left = Buffer.from(String(provided))
  const right = Buffer.from(String(expected))
  if (left.length !== right.length) return false
  return crypto.timingSafeEqual(left, right)
}

function predictionTargetKey(tableId, shoe, round) {
  return `${String(tableId ?? '')}:${String(shoe ?? '')}:${Number(round ?? 0)}`
}

function hasSensitiveAuthQuery(requestUrl) {
  for (const key of requestUrl.searchParams.keys()) {
    if (/token|session|ticket|authorization/i.test(key)) return true
  }
  return false
}

function parseJsonBody(rawBody) {
  if (!rawBody) return {}
  return JSON.parse(rawBody)
}

function validateIngestEnvelope(envelope, currentTime) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error('invalid payload')
  const timestamp = Number(envelope.timestamp)
  if (!Number.isFinite(timestamp) || Math.abs(Number(currentTime) - timestamp) > 5 * 60 * 1000) {
    const error = new Error('timestamp outside allowed window')
    error.statusCode = 409
    throw error
  }
  if (!Number.isSafeInteger(envelope.sequence) || envelope.sequence < 0) throw new Error('sequence must be a non-negative integer')
  const snapshot = envelope.snapshot
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('snapshot must be an object')
  if (!Array.isArray(snapshot.tables)) throw new Error('tables must be an array')
  if (snapshot.tables.length > 128) throw new Error('tables exceeds maximum length')
  for (const table of snapshot.tables) {
    if (!table || typeof table !== 'object' || Array.isArray(table)) throw new Error('each table must be an object')
    if (table.tableId == null && table.table_id == null && table.id == null) throw new Error('each table requires tableId')
  }
  if (snapshot.rounds != null && !Array.isArray(snapshot.rounds)) throw new Error('rounds must be an array')
}

export function readRequestBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    req.on('data', (chunk) => {
      if (settled) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > maxBytes) {
        settled = true
        req.pause?.()
        const error = new Error('payload_too_large')
        error.statusCode = 413
        reject(error)
        return
      }
      chunks.push(buffer)
    })
    req.on('end', () => {
      if (!settled) resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', reject)
  })
}

function jsonResponse(statusCode, payload, frontendOrigin = '*') {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': frontendOrigin,
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'Content-Type,Authorization,X-Admin-Session-Token,X-Member-Session-Token,X-Control-Token,X-Worker-Key',
      'cache-control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      pragma: 'no-cache',
    },
    body: JSON.stringify(payload),
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  loadLocalEnv()
  const port = Number(process.env.PORT ?? 8787)
  const app = createApp({ port })
  app.start().then(() => {
    console.log(`${SERVICE} v${VERSION} 已啟動`)
    console.log(`本機 API: http://127.0.0.1:${port}`)
    console.log('健康檢查: /health')
    if (!process.env.MT_TOKEN && !process.env.CHROME_CAPTURE_URL) console.log('未設定 MT_TOKEN / CHROME_CAPTURE_URL，目前為測試/離線模式')
    if (process.env.MT_TOKEN) console.log(`MT_TOKEN 已載入：${maskToken(process.env.MT_TOKEN)}`)
    if (process.env.CHROME_CAPTURE_URL) console.log('Chrome背景抓取模式已啟用：CHROME_CAPTURE_URL 已載入')
  })
}
