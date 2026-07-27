import http from 'node:http'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createProxyState } from './state-store.js'
import { createMtClient } from './mt-client.js'
import { createChromeCaptureClient } from './chrome-capture.js'
import { applyCloudCapturePayload, canonicalProductionTableId, createCloudCaptureClient, parseCloudCapturePayload, PRODUCTION_TABLE_IDS } from './cloud-capture.js'
import { loadLocalEnv, maskToken, resolveDeployConfig } from './config.js'
import { ALL_MT_EQUAL_STRATEGY_VERSION, buildLivePrediction, createSupabaseIngestionClient } from './supabase-writer.js'
import { createRecentTablePerformanceStore } from './recent-table-performance.js'
import { createV100FormalRuntime, resolveV100FormalEnabled } from './v100-formal-runtime.js'
import { createV103ShadowRuntime, resolveV103ShadowEnabled } from './v103-shadow-runtime.js'
import { createV104FormalRuntime } from './v104-formal-runtime.js'
import { createV105FormalRuntime } from './v105-formal-runtime.js'
import { createV104ShadowRuntime, resolveV104ShadowEnabled } from './v104-shadow-runtime.js'
import { createV104IterationShadowRuntime, resolveV104IterationShadowEnabled } from './v104-iteration-shadow-runtime.js'
import { createV105ShadowRuntime, resolveV105ShadowEnabled } from './v105-shadow-runtime.js'
import { createV105ShadowV7Runtime, resolveV105ShadowV7Enabled } from './v105-shadow-v7-runtime.js'
import { buildShadowAdminStatus } from './v104-iteration-shadow-report.js'
import { createOnlineCoreClient } from './online-core.js'
import { createLicenseAdminClient } from './license-admin.js'
import { chooseCaptureSource, describeCaptureStatus } from './capture-source.js'
import { buildOperationalEvent, toStatusEvent } from './event-layer.js'
import { createFormalDailyMemoryRollover } from './formal-daily-memory-rollover.js'
import { BUILD_VERSION } from './build-version.js'
import { hasExactRealCardCodes, isExactTenRawResult, isVerifiedFinalRoundAction } from '../../shared/real-card-validator.js'

const VERSION = BUILD_VERSION
const SERVICE = 'Draven MT資料代理伺服器'
const WORKER_PROTOCOL_BUILD_VERSION = '105'
const WORKER_PROTOCOL_VERSION = 'v105'
const LIFECYCLE_IDENTITIES_PER_TABLE = 256
const LIFECYCLE_SHOES_PER_TABLE = 64

function acceptLifecycleScreenIdentity(guardsByTable, { tableId, shoe, visibleRound }) {
  const identity = `${tableId}:${shoe}:${visibleRound}`
  const guard = guardsByTable.get(tableId) ?? {
    latestShoe: null,
    latestRound: null,
    seenIdentities: new Set(),
    identityOrder: [],
    seenShoes: new Set(),
    shoeOrder: [],
  }

  if (guard.seenIdentities.has(identity)) return false
  if (guard.latestShoe === shoe) {
    if (visibleRound <= guard.latestRound) return false
  } else if (guard.latestShoe != null) {
    if (guard.seenShoes.has(shoe)) return false
    const candidateNumericShoe = numericShoe(shoe)
    const latestNumericShoe = numericShoe(guard.latestShoe)
    if (candidateNumericShoe != null && latestNumericShoe != null && candidateNumericShoe <= latestNumericShoe) return false
  }

  guard.latestShoe = shoe
  guard.latestRound = visibleRound
  rememberBounded(guard.seenIdentities, guard.identityOrder, identity, LIFECYCLE_IDENTITIES_PER_TABLE)
  rememberBounded(guard.seenShoes, guard.shoeOrder, shoe, LIFECYCLE_SHOES_PER_TABLE)
  guardsByTable.set(tableId, guard)
  return true
}

function numericShoe(value) {
  const normalized = String(value ?? '')
  return /^\d+$/.test(normalized) ? BigInt(normalized) : null
}

function rememberBounded(seen, order, value, limit) {
  if (seen.has(value)) return
  seen.add(value)
  order.push(value)
  while (order.length > limit) seen.delete(order.shift())
}

export function resolveFrontendCorsOrigin(configuredOrigin, requestOrigin) {
  const configured = String(configuredOrigin ?? '*').trim() || '*'
  if (configured === '*') return '*'

  const requested = String(requestOrigin ?? '').trim()
  if (!requested) return configured

  try {
    const configuredUrl = new URL(configured)
    const requestedUrl = new URL(requested)
    if (requestedUrl.origin !== requested || requestedUrl.protocol !== 'https:') return configured
    if (requestedUrl.origin === configuredUrl.origin) return requestedUrl.origin
    if (configuredUrl.protocol !== 'https:' || !configuredUrl.hostname.endsWith('.pages.dev')) return configured

    const previewSuffix = `.${configuredUrl.hostname}`
    if (!requestedUrl.hostname.endsWith(previewSuffix)) return configured
    const previewLabel = requestedUrl.hostname.slice(0, -previewSuffix.length)
    if (!previewLabel || !/^[a-z0-9-]+$/i.test(previewLabel) || requestedUrl.port) return configured
    return requestedUrl.origin
  } catch {
    return configured
  }
}

export function createApp({ autoConnect, token = process.env.MT_TOKEN, port = Number(process.env.PORT ?? 8787), host = process.env.HOST, captureUrl = process.env.CHROME_CAPTURE_URL, cloudBrowserUrl = process.env.CLOUD_BROWSER_URL, deployMode = process.env.DEPLOY_MODE ?? 'local', captureSource: requestedCaptureSource = process.env.CAPTURE_SOURCE, frontendOrigin: configuredFrontendOrigin = process.env.PUBLIC_FRONTEND_ORIGIN || '*', controlToken = process.env.PROXY_CONTROL_TOKEN || process.env.WORKER_ADMIN_KEY, controlAllowedOrigin = process.env.CONTROL_ALLOWED_ORIGIN || process.env.PUBLIC_FRONTEND_ORIGIN || '', ingestKey = process.env.INGEST_KEY || process.env.WORKER_ADMIN_KEY, ingestDeadlineMs = Number(process.env.INGEST_REQUEST_DEADLINE_MS ?? 110000), now = Date.now, predictionTtlMs = Number(process.env.PREDICTION_TTL_MS ?? 120000), maxExpiredPredictionKeys = Number(process.env.MAX_EXPIRED_PREDICTION_KEYS ?? 10000), production = process.env.NODE_ENV === 'production', requireVerifiedStrategy = production, memberAuthRequired = production, memberSessionTtlMs = Number(process.env.MEMBER_SESSION_TTL_MS ?? 30 * 60 * 1000), v104FormalRequestTimeoutMs = Number(process.env.V104_FORMAL_REQUEST_TIMEOUT_MS ?? 10000), v105FormalHydrationTimeoutMs = Number(process.env.V105_FORMAL_HYDRATION_TIMEOUT_MS ?? 60000), recentPerformanceRetryMs = Number(process.env.RECENT_PERFORMANCE_RETRY_MS ?? 30000), fetchImpl = globalThis.fetch, supabaseClient = createSupabaseIngestionClient({ dbConnectionString: process.env.SUPABASE_DB_CONNECTION_STRING, requestTimeoutMs: Number(process.env.SUPABASE_REQUEST_TIMEOUT_MS ?? 30000), durableWriteRequestTimeoutMs: Number(process.env.DURABLE_INGEST_REQUEST_TIMEOUT_MS ?? 30000) }), onlineCoreClient = createOnlineCoreClient(), licenseAdminClient = createLicenseAdminClient(), v100FormalRuntime = null, v103ShadowRuntime = null, v104ShadowRuntime = null, v104IterationShadowRuntime = null, v105ShadowRuntime = null, v105ShadowV7Runtime = null, v104FormalRuntime = null, dailyMemoryRollover = null } = {}) {
  const deployConfig = resolveDeployConfig({
    DEPLOY_MODE: deployMode,
    CAPTURE_SOURCE: requestedCaptureSource,
    PUBLIC_FRONTEND_ORIGIN: configuredFrontendOrigin,
    CLOUD_BROWSER_URL: cloudBrowserUrl,
    CHROME_CAPTURE_URL: captureUrl,
    MT_TOKEN: token,
    AUTO_CONNECT: autoConnect === undefined ? process.env.AUTO_CONNECT : String(autoConnect),
    CLOUD_CAPTURE_POLL_MS: process.env.CLOUD_CAPTURE_POLL_MS,
  })
  const frontendOrigin = configuredFrontendOrigin
  assertSecureCloudBrowserUrl(cloudBrowserUrl, { production, deployMode: deployConfig.deployMode })
  const shouldAutoConnect = autoConnect ?? deployConfig.autoConnect
  const strictRealCardRounds = process.env.REQUIRE_REAL_CARD_ROUNDS !== 'false'
  const adminSessions = new Map()
  const ingestSequences = new Map()
  const ingestSessionLocks = new Map()
  const pendingPredictions = new Map()
  const preparingPredictionPromises = new Map()
  const issuingPredictionPromises = new Map()
  const readingIssuedPredictionPromises = new Map()
  const issuedPredictionReadRetryAt = new Map()
  const expiredPredictionKeys = new Set()
  const settlingPredictionPromises = new Map()
  const lifecycleGuardsByTable = new Map()
  const memberSessions = new Map()
  const recentTablePerformance = createRecentTablePerformanceStore({ windowSize: 60 })
  const resolvedDailyMemoryRollover = dailyMemoryRollover ?? (
    onlineCoreClient?.configured === true
      && typeof onlineCoreClient.loadDailySummary === 'function'
      && typeof onlineCoreClient.upsertDailySummary === 'function'
      ? createFormalDailyMemoryRollover({
          loadDailySummary: (reportDate) => onlineCoreClient.loadDailySummary(reportDate),
          onlineCoreClient,
        })
      : null
  )
  let recentPerformanceReady = !(production && supabaseClient?.configured === true && typeof supabaseClient.getRecentPredictionRows === 'function')
  let recentPerformanceHydrationPromise = null
  let recentPerformanceRetryAtMs = 0
  const resolvedRecentPerformanceRetryMs = Math.max(1000, Number(recentPerformanceRetryMs) || 30000)
  const resolvedIngestDeadlineMs = Math.min(110000, Math.max(1, Number(ingestDeadlineMs) || 110000))
  let tablesReceivedAtMs = 0
  let v103Shadow = null
  let v104Shadow = null
  let v104IterationShadow = null
  let v105Shadow = null
  let v105ShadowV7 = null
  let v104IterationShadowAdminCache = { expiresAtMs: 0, state: null }
  const v104Formal = v104FormalRuntime ?? (ALL_MT_EQUAL_STRATEGY_VERSION === 'v105'
    ? createV105FormalRuntime({ writer: supabaseClient, requestTimeoutMs: Math.max(1000, Number(v105FormalHydrationTimeoutMs) || 60000), allowUnconfigured: !requireVerifiedStrategy })
    : ALL_MT_EQUAL_STRATEGY_VERSION === 'v104'
      ? createV104FormalRuntime({ writer: supabaseClient, requestTimeoutMs: Math.max(1000, Number(v104FormalRequestTimeoutMs) || 10000), allowUnconfigured: !requireVerifiedStrategy })
      : null)
  const actionablePredictionTtlMs = Math.max(1000, Number(predictionTtlMs) || 120000)
  const expiredPredictionKeyLimit = Math.max(1, Number(maxExpiredPredictionKeys) || 10000)
  const resolvedMemberSessionTtlMs = Math.min(30 * 60 * 1000, Math.max(60000, Number(memberSessionTtlMs) || 30 * 60 * 1000))
  const adminSessionTtlMs = Math.max(60000, Number(process.env.ADMIN_SESSION_TTL_MS ?? 30 * 60 * 1000) || 30 * 60 * 1000)
  const state = createProxyState({
    inferSnapshotRounds: !strictRealCardRounds,
    onTablesUpdated: (tables) => {
      tablesReceivedAtMs = now()
      for (const table of tables) {
        void reconcileThenSavePendingPrediction(table)
        if (v103Shadow?.enabled === true) void v103Shadow.observeTable(table).catch(() => {})
        if (v104Shadow?.enabled === true) void v104Shadow.observeTable(table).catch(() => {})
        if (v104IterationShadow?.enabled === true) void v104IterationShadow.observeTable(table).catch(() => {})
        if (v105Shadow?.enabled === true) void Promise.resolve().then(() => v105Shadow.observeTable(table)).catch(() => {})
        if (v105ShadowV7?.enabled === true) void Promise.resolve().then(() => v105ShadowV7.observeTable(table)).catch(() => {})
      }
    },
    onRoundEvent: async (round, table) => {
      if (!supabaseClient?.configured && !supabaseClient?.persistRound) return
      if (!isVerifiedFinalRoundAction(round?.sourceAction)) return
      if (strictRealCardRounds && !hasRealCardCodes(round)) return
      if (v103Shadow?.enabled === true) void v103Shadow.settleRound(round).catch(() => {})
      if (v104Shadow?.enabled === true) void v104Shadow.settleRound(round).catch(() => {})
      if (v104IterationShadow?.enabled === true) {
        v104IterationShadowAdminCache = { expiresAtMs: 0, state: null }
        void v104IterationShadow.settleRound(round)
          .then(() => { v104IterationShadowAdminCache = { expiresAtMs: 0, state: null } })
          .catch(() => {})
      }
      if (v105Shadow?.enabled === true) void Promise.resolve().then(() => v105Shadow.settleRound(round)).catch(() => {})
      if (v105ShadowV7?.enabled === true) void Promise.resolve().then(() => v105ShadowV7.settleRound(round)).catch(() => {})
      const pendingKey = predictionTargetKey(round.tableId ?? table.tableId, round.shoe, round.round)
      let issuedCandidate
      try {
        if (preparingPredictionPromises.has(pendingKey)) await preparingPredictionPromises.get(pendingKey)
        issuedCandidate = pendingPredictions.get(pendingKey)
        if (!issuedCandidate && issuingPredictionPromises.has(pendingKey)) issuedCandidate = await issuingPredictionPromises.get(pendingKey)
        if (!issuedCandidate && typeof supabaseClient?.readIssuedPrediction === 'function') {
          issuedCandidate = await supabaseClient.readIssuedPrediction({
            tableId: round.tableId ?? table.tableId,
            shoe: round.shoe,
            round: round.round,
            strategyVersion: ALL_MT_EQUAL_STRATEGY_VERSION,
          }, { priority: 'settlement' })
        }
      } catch (error) {
        state.setStatus({ persistenceStatus: 'error', persistenceError: error?.message ?? String(error) })
        throw error
      }
      const precomputedPrediction = issuedCandidate
        && predictionTargetKey(issuedCandidate.targetTableId, issuedCandidate.targetShoe, issuedCandidate.targetRound) === pendingKey
        && issuedCandidate.strategyVersion === ALL_MT_EQUAL_STRATEGY_VERSION
        ? issuedCandidate
        : null
      if (!precomputedPrediction) return
      const existingSettlement = settlingPredictionPromises.get(pendingKey)
      if (existingSettlement) return existingSettlement
      const settlementPromise = (async () => {
        try {
          const persisted = await supabaseClient.persistRound?.(round, table, precomputedPrediction)
          if (persisted?.prediction) {
            recentTablePerformance.record(persisted.prediction)
            v104Formal?.recordSettlement?.({
              ...persisted.prediction,
              predictionId: persisted.prediction.predictionId ?? persisted.prediction.prediction_id ?? persisted.prediction.id ?? precomputedPrediction.predictionId,
            })
            const resolvedAt = persisted.prediction.resolved_at ?? persisted.prediction.resolvedAt
            const nestedSettlementFinal = persisted.prediction.prediction_features?.settlement_final
            const settlementFinal = nestedSettlementFinal === true
              || (nestedSettlementFinal == null && persisted.prediction.settlement_final === true)
            if (settlementFinal && resolvedAt && typeof resolvedDailyMemoryRollover?.observe === 'function') {
              void Promise.resolve()
                .then(() => resolvedDailyMemoryRollover.observe({ settlementFinal: true, resolvedAt }))
                .catch(() => {})
            }
          }
          pendingPredictions.delete(pendingKey)
          state.setStatus({ persistenceStatus: 'ok', persistenceError: null })
          return persisted
        } catch (error) {
          state.setStatus({ persistenceStatus: 'error', persistenceError: error?.message ?? String(error) })
          throw error
        }
      })()
      settlingPredictionPromises.set(pendingKey, settlementPromise)
      try {
        return await settlementPromise
      } finally {
        if (settlingPredictionPromises.get(pendingKey) === settlementPromise) settlingPredictionPromises.delete(pendingKey)
      }
    },
  })
  const captureSource = deployConfig.captureSource || chooseCaptureSource({ chromeCaptureUrl: captureUrl, cloudBrowserUrl, token })
  state.setStatus({ deployMode: deployConfig.deployMode, captureSource, captureMode: captureSource, cloudReady: true, statusText: describeCaptureStatus({ captureSource }) })
  const mtClient = createMtClient({ token, state })
  const chromeClient = createChromeCaptureClient({ url: captureUrl, state })
  const v100Formal = v100FormalRuntime ?? createV100FormalRuntime({
    enabled: resolveV100FormalEnabled(),
    writer: supabaseClient,
  })
  v103Shadow = v103ShadowRuntime ?? createV103ShadowRuntime({
    enabled: resolveV103ShadowEnabled(),
    writer: supabaseClient,
  })
  v104Shadow = ALL_MT_EQUAL_STRATEGY_VERSION === 'v104'
    ? createV104ShadowRuntime({ enabled: false, writer: supabaseClient })
    : (v104ShadowRuntime ?? createV104ShadowRuntime({
      enabled: resolveV104ShadowEnabled(),
      writer: supabaseClient,
    }))
  v104IterationShadow = v104IterationShadowRuntime ?? createV104IterationShadowRuntime({
    enabled: resolveV104IterationShadowEnabled(),
    writer: supabaseClient,
  })
  v105Shadow = v105ShadowRuntime ?? createV105ShadowRuntime({
    enabled: resolveV105ShadowEnabled()
      && typeof supabaseClient?.getV105ShadowHistory === 'function'
      && typeof supabaseClient?.issueV105ShadowPrediction === 'function'
      && typeof supabaseClient?.readV105ShadowIssuance === 'function'
      && typeof supabaseClient?.settleV105ShadowPrediction === 'function',
    writer: supabaseClient,
  })
  v105ShadowV7 = v105ShadowV7Runtime ?? createV105ShadowV7Runtime({
    enabled: resolveV105ShadowV7Enabled()
      && typeof supabaseClient?.getV105ShadowV7History === 'function'
      && typeof supabaseClient?.issueV105ShadowV7Prediction === 'function'
      && typeof supabaseClient?.readV105ShadowV7Issuance === 'function'
      && typeof supabaseClient?.settleV105ShadowV7Prediction === 'function',
    writer: supabaseClient,
  })
  const cloudCaptureClient = createCloudCaptureClient({ url: cloudBrowserUrl, state, writer: supabaseClient, v100Formal, fetchImpl, pollMs: deployConfig.cloudCapturePollMs, adminKey: process.env.WORKER_ADMIN_KEY })

  async function readV104IterationShadowAdminState() {
    const currentTime = Number(now())
    if (v104IterationShadowAdminCache.state && v104IterationShadowAdminCache.expiresAtMs > currentTime) {
      return v104IterationShadowAdminCache.state
    }
    if (typeof supabaseClient?.getV104IterationShadowCounters !== 'function'
        || typeof supabaseClient?.getV104IterationShadowSettledRange !== 'function'
        || typeof supabaseClient?.getV104IterationShadowCycleReports !== 'function'
        || typeof supabaseClient?.getV104IterationShadowSuggestions !== 'function') throw new Error('iteration shadow durable admin data is unavailable')
    const counters = await supabaseClient.getV104IterationShadowCounters()
    if (!counters) throw new Error('iteration shadow counters are unavailable')
    const settledRounds = Number(counters.settlement_count) || 0
    const remainder = settledRounds % 1000
    const endSequence = settledRounds
    const startSequence = settledRounds > 0 ? settledRounds - (remainder || Math.min(1000, settledRounds)) + 1 : 1
    const [rows, reportRows, suggestionRows] = await Promise.all([
      settledRounds > 0 ? supabaseClient.getV104IterationShadowSettledRange({ startSequence, endSequence }) : [],
      supabaseClient.getV104IterationShadowCycleReports({ limit: 1000 }),
      supabaseClient.getV104IterationShadowSuggestions({ limit: 1000 }),
    ])
    const state = { counters, rows, reportRows, suggestionRows }
    v104IterationShadowAdminCache = { expiresAtMs: currentTime + 30000, state }
    return state
  }

  async function recordOperationalEvent({ component, kind, message, statusCode = null, metadata = {} }) {
    const event = buildOperationalEvent({ component, kind, message, statusCode, metadata })
    state.setStatus(toStatusEvent(event))
    await supabaseClient?.writeOperationalEvent?.(event).catch(() => {})
    return event
  }

  async function withIngestSessionLock(sessionId, task) {
    const previous = ingestSessionLocks.get(sessionId) ?? Promise.resolve()
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const current = previous.then(() => gate)
    ingestSessionLocks.set(sessionId, current)
    await previous
    try {
      return await task()
    } finally {
      release()
      if (ingestSessionLocks.get(sessionId) === current) ingestSessionLocks.delete(sessionId)
    }
  }

  async function handle(method, url, rawBody = '', headers = {}) {
    const requestUrl = new URL(url, 'http://127.0.0.1')
    const frontendOrigin = resolveFrontendCorsOrigin(configuredFrontendOrigin, headers.origin)
    const pathname = requestUrl.pathname
    if (production && String(headers['x-forwarded-proto'] ?? '').toLowerCase() !== 'https') {
      return jsonResponse(426, { ok: false, error: 'HTTPS is required' }, frontendOrigin)
    }
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
      const health = buildServiceHealth()
      return jsonResponse(health.degraded ? 503 : 200, { ok: !health.degraded, service: SERVICE, version: VERSION, buildVersion: BUILD_VERSION, deployMode: deployConfig.deployMode, ...health }, frontendOrigin)
    }
    if (pathname === '/api/status') {
      const status = state.snapshot().status
      const cloudStatus = await readCloudSnapshotStatus()
      const nextStatus = { ...state.snapshot().status, ...cloudStatus }
      const health = buildServiceHealth()
      return jsonResponse(200, { ...nextStatus, version: VERSION, buildVersion: BUILD_VERSION, deployMode: deployConfig.deployMode, ...health, statusText: cloudStatus?.statusText ?? describeCaptureStatus(nextStatus) }, frontendOrigin)
    }
    if (pathname === '/api/v103-shadow/status') {
      const controlError = requireControlAccess(headers)
      if (controlError) return controlError
      return jsonResponse(200, { ok: true, activeStrategyVersion: ALL_MT_EQUAL_STRATEGY_VERSION, v103Shadow: v103Shadow?.snapshot?.() ?? { status: 'unavailable' } }, frontendOrigin)
    }
    if (pathname === '/api/v104-shadow/status') {
      const controlError = requireControlAccess(headers)
      if (controlError) return controlError
      return jsonResponse(200, { ok: true, activeStrategyVersion: ALL_MT_EQUAL_STRATEGY_VERSION, v104Shadow: v104Shadow?.snapshot?.() ?? { status: 'unavailable' } }, frontendOrigin)
    }
    if (pathname === '/api/v104-iteration-shadow/control/status') {
      const controlError = requireControlAccess(headers)
      if (controlError) return controlError
      return jsonResponse(200, {
        ok: true,
        formalStrategyVersion: ALL_MT_EQUAL_STRATEGY_VERSION,
        runtime: v104IterationShadow?.snapshot?.() ?? { status: 'unavailable' },
      }, frontendOrigin)
    }
    if (pathname === '/api/v104-iteration-shadow/admin/status') {
      if (method !== 'GET') return jsonResponse(405, { ok: false, error: 'Method Not Allowed' }, frontendOrigin)
      if (hasSensitiveAuthQuery(requestUrl)) return jsonResponse(400, { ok: false, error: 'admin session is not allowed in query' }, frontendOrigin)
      try {
        requireSuperAdminSession({}, requestUrl, headers)
        const { counters, rows, reportRows, suggestionRows } = await readV104IterationShadowAdminState()
        const status = buildShadowAdminStatus(rows)
        const actionCounts = {
          main: Number(counters.main_action_count) || 0, tie: Number(counters.tie_action_count) || 0,
          superSix: Number(counters.super_six_action_count) || 0, bankerDragon: Number(counters.banker_dragon_action_count) || 0,
          playerDragon: Number(counters.player_dragon_action_count) || 0, bankerPair: Number(counters.banker_pair_action_count) || 0,
          playerPair: Number(counters.player_pair_action_count) || 0,
        }
        status.settledRounds = Number(counters.settlement_count) || 0
        status.currentCycleProgress = status.settledRounds % 1000
        status.heads = status.heads.map((head) => ({ ...head, iterationProgress: actionCounts[head.key] % 1000 }))
        status.reports = (Array.isArray(reportRows) ? reportRows : []).map((row) => ({
          cycleNumber: Number(row.cycle_number), settledRounds: 1000,
          startedAt: row.report_payload?.startedAt ?? null, completedAt: row.report_payload?.completedAt ?? null,
        }))
        status.suggestions = (Array.isArray(suggestionRows) ? suggestionRows : []).map((row) => ({
          id: row.suggestion_id, headKey: row.head_key, actionCycle: Number(row.action_cycle),
          modelVersion: row.model_version, searchMethod: row.search_method,
          currentWeights: row.current_weights, suggestedWeights: row.suggested_weights,
          baselineMetrics: row.baseline_metrics, candidateMetrics: row.candidate_metrics,
          status: row.status, autoApply: row.auto_apply, reviewedBy: row.reviewed_by, reviewedAt: row.reviewed_at,
        }))
        const runtime = v104IterationShadow?.snapshot?.() ?? { status: 'unavailable' }
        return jsonResponse(200, { ...status, enabled: v104IterationShadow?.enabled === true, runtime }, frontendOrigin)
      } catch (error) {
        return jsonResponse(error?.statusCode ?? 503, { ok: false, error: error?.message ?? String(error) }, frontendOrigin)
      }
    }
    const shadowSuggestionReviewMatch = pathname.match(/^\/api\/v104-iteration-shadow\/admin\/suggestions\/([^/]+)\/review$/)
    if (shadowSuggestionReviewMatch) {
      if (method !== 'POST') return jsonResponse(405, { ok: false, error: 'Method Not Allowed' }, frontendOrigin)
      if (hasSensitiveAuthQuery(requestUrl)) return jsonResponse(400, { ok: false, error: 'admin session is not allowed in query' }, frontendOrigin)
      try {
        const payload = parseJsonBody(rawBody)
        const session = requireSuperAdminSession(payload, requestUrl, headers)
        if (typeof supabaseClient?.reviewV104IterationShadowSuggestion !== 'function') throw new Error('iteration shadow review writer is unavailable')
        const reviewed = await supabaseClient.reviewV104IterationShadowSuggestion({
          suggestionId: decodeURIComponent(shadowSuggestionReviewMatch[1]), decision: payload.decision, reviewer: session.adminAccount,
        })
        v104IterationShadowAdminCache = { expiresAtMs: 0, state: null }
        return jsonResponse(200, { ok: true, ...reviewed }, frontendOrigin)
      } catch (error) {
        return jsonResponse(error?.statusCode ?? 400, { ok: false, error: error?.message ?? String(error) }, frontendOrigin)
      }
    }
    const shadowReportImageMatch = pathname.match(/^\/api\/v104-iteration-shadow\/admin\/reports\/(\d+)\/image\.svg$/)
    if (shadowReportImageMatch) {
      if (method !== 'GET') return jsonResponse(405, { ok: false, error: 'Method Not Allowed' }, frontendOrigin)
      if (hasSensitiveAuthQuery(requestUrl)) return jsonResponse(400, { ok: false, error: 'admin session is not allowed in query' }, frontendOrigin)
      try {
        requireSuperAdminSession({}, requestUrl, headers)
        const { reportRows } = await readV104IterationShadowAdminState()
        const cycleNumber = Number(shadowReportImageMatch[1])
        const reportRow = (Array.isArray(reportRows) ? reportRows : []).find((item) => Number(item.cycle_number) === cycleNumber)
        if (!reportRow?.report_svg) return jsonResponse(404, { ok: false, error: 'shadow report not found' }, frontendOrigin)
        return svgResponse(200, reportRow.report_svg, frontendOrigin)
      } catch (error) {
        return jsonResponse(error?.statusCode ?? 503, { ok: false, error: error?.message ?? String(error) }, frontendOrigin)
      }
    }
    if (pathname === '/api/tables') {
      if (hasSensitiveAuthQuery(requestUrl)) return jsonResponse(400, { ok: false, error: 'session token is not allowed in query' }, frontendOrigin)
      if (!await isMemberSessionAuthorized(headers)) return jsonResponse(401, { ok: false, error: 'member session is required' }, frontendOrigin)
      return jsonResponse(200, await readBestTables(), frontendOrigin)
    }
    const uiHistoryMatch = pathname.match(/^\/api\/tables\/([^/]+)\/ui-history$/)
    if (uiHistoryMatch) {
      if (hasSensitiveAuthQuery(requestUrl)) return jsonResponse(400, { ok: false, error: 'session token is not allowed in query' }, frontendOrigin)
      if (!await isMemberSessionAuthorized(headers)) return jsonResponse(401, { ok: false, error: 'member session is required' }, frontendOrigin)
      const tableId = canonicalProductionTableId(decodeURIComponent(uiHistoryMatch[1]))
      if (!PRODUCTION_TABLE_IDS.includes(tableId)) return jsonResponse(404, { ok: false, error: 'table not found' }, frontendOrigin)
      const liveTables = await readBestTables({ includePrediction: false })
      const table = liveTables.find((candidate) => canonicalProductionTableId(candidate?.tableId ?? candidate?.table_id ?? candidate?.id) === tableId)
      if (!table || table.shoe == null || table.shoe === '') return jsonResponse(404, { ok: false, error: 'table not found' }, frontendOrigin)
      if (supabaseClient?.configured !== true
        || typeof supabaseClient.getTableUiSettledPredictions !== 'function'
        || typeof supabaseClient.getTableUiRealCardRounds !== 'function') {
        return jsonResponse(503, { ok: false, error: 'table ui history is unavailable' }, frontendOrigin)
      }
      const shoe = table.shoe
      try {
        const [settledPredictions, realCardHistory] = await Promise.all([
          supabaseClient.getTableUiSettledPredictions({ tableId, shoe, limit: 10 }),
          supabaseClient.getTableUiRealCardRounds({ tableId, shoe, limit: 100 }),
        ])
        if (!Array.isArray(settledPredictions)
          || !(Array.isArray(realCardHistory) || Array.isArray(realCardHistory?.rounds))) {
          throw new Error('table ui history returned an invalid result')
        }
        return jsonResponse(200, {
          ok: true,
          buildVersion: BUILD_VERSION,
          tableId,
          shoe,
          settledPredictions,
          realCardRounds: Array.isArray(realCardHistory?.rounds) ? realCardHistory.rounds : (Array.isArray(realCardHistory) ? realCardHistory : []),
          realCardHistoryCompleteThroughRound: Number(realCardHistory?.completeThroughRound) || 0,
        }, frontendOrigin)
      } catch {
        return jsonResponse(503, { ok: false, error: 'table ui history is unavailable' }, frontendOrigin)
      }
    }
    if (pathname === '/api/snapshot') {
      if (hasSensitiveAuthQuery(requestUrl)) return jsonResponse(400, { ok: false, error: 'session token is not allowed in query' }, frontendOrigin)
      if (!await isMemberSessionAuthorized(headers)) return jsonResponse(401, { ok: false, error: 'member session is required' }, frontendOrigin)
      const snapshot = state.snapshot()
      return jsonResponse(200, { ...snapshot, tables: await readBestTables() }, frontendOrigin)
    }
    if (method === 'POST' && pathname === '/api/cloud-ingest/snapshot') {
      if (!ingestKey && (production || deployConfig.deployMode === 'cloud')) return jsonResponse(503, { ok: false, error: 'ingest key is not configured' }, frontendOrigin)
      if (!ingestKey || !safeEqual(headers['x-worker-key'], ingestKey)) return jsonResponse(401, { ok: false, error: 'unauthorized' }, frontendOrigin)
      if (Buffer.byteLength(rawBody, 'utf8') > 1024 * 1024) return jsonResponse(413, { ok: false, error: 'payload_too_large' }, frontendOrigin)
      try {
        const envelope = parseJsonBody(rawBody)
        const validatedRoundKeys = validateIngestEnvelope(envelope, now())
        const sessionId = String(envelope.snapshot.sessionId ?? envelope.snapshot.session_id ?? 'cloud-browser')
        const ingestOperation = withIngestSessionLock(sessionId, async () => {
          const previous = ingestSequences.get(sessionId)
          if (previous != null && envelope.sequence <= previous.sequence) {
            if (envelope.sequence === previous.sequence) {
              const accepted = new Set(previous.ack?.acceptedRoundKeys ?? [])
              if (!validatedRoundKeys.every((roundKey) => accepted.has(roundKey))) {
                return jsonResponse(409, { ok: false, accepted: false, error: 'sequence_payload_conflict' }, frontendOrigin)
              }
              return jsonResponse(200, {
                ...previous.ack,
                duplicate: true,
                sequence: envelope.sequence,
                acceptedRoundKeys: validatedRoundKeys,
              }, frontendOrigin)
            }
            return jsonResponse(200, { ...previous.ack, duplicate: true, sequence: envelope.sequence }, frontendOrigin)
          }
          const parsed = parseCloudCapturePayload(envelope.snapshot)
          let captureResult = null
          try {
            assertDurableIngestWriter(supabaseClient, parsed.rounds.length)
            captureResult = await applyCloudCapturePayload({ parsed, state, writer: supabaseClient, v100Formal })
          } catch (error) {
            const durableError = new Error(error?.message ?? String(error))
            durableError.statusCode = 503
            durableError.durableFailure = true
            throw durableError
          }
          state.setStatus({ durableTimings: captureResult?.durableTimings ?? null })
          const ack = {
            ok: true,
            accepted: true,
            duplicate: false,
            sessionId,
            sequence: envelope.sequence,
            acceptedRoundKeys: validatedRoundKeys,
          }
          ingestSequences.set(sessionId, { sequence: envelope.sequence, ack })
          state.setStatus({
            health: 'ok', reason: null,
            expectedProtocolVersion: WORKER_PROTOCOL_VERSION,
            receivedProtocolVersion: WORKER_PROTOCOL_VERSION,
            eventLayer: null, eventSeverity: null, eventComponent: null,
            eventMessage: null, eventStatusCode: null, eventKind: null, eventAt: null,
          })
          return jsonResponse(200, ack, frontendOrigin)
        })
        return await withDeadline(ingestOperation, resolvedIngestDeadlineMs, 'durable ingest deadline exceeded')
      } catch (error) {
        if (error?.message === 'durable ingest deadline exceeded') {
          error.statusCode = 503
          error.durableFailure = true
        }
        if (error?.versionMismatch) {
          state.setStatus({ health: 'degraded', reason: 'version_mismatch', expectedProtocolVersion: WORKER_PROTOCOL_VERSION, receivedProtocolVersion: error.receivedProtocolVersion ?? null })
        }
        return jsonResponse(error?.statusCode ?? 400, {
          ok: false,
          ...(error?.durableFailure ? { accepted: false } : {}),
          error: error?.versionMismatch ? 'version_mismatch' : error?.message ?? String(error),
        }, frontendOrigin)
      }
    }
    if (pathname === '/api/cloud-capture/status') {
      return jsonResponse(200, buildCloudCaptureManagementStatus(), frontendOrigin)
    }
    if (pathname === '/api/stable-report/rows') {
      const controlError = requireControlAccess(headers)
      if (controlError) return controlError
      if (!supabaseClient?.configured || typeof supabaseClient.getStablePredictionRows !== 'function') {
        return jsonResponse(503, { ok: false, error: 'saved prediction rows are unavailable' }, frontendOrigin)
      }
      try {
        const rows = await supabaseClient.getStablePredictionRows({
          since: requestUrl.searchParams.get('since'),
          limit: requestUrl.searchParams.get('limit') ?? 10000,
        })
        return jsonResponse(200, { ok: true, buildVersion: BUILD_VERSION, rows }, frontendOrigin)
      } catch (error) {
        return jsonResponse(503, { ok: false, error: error?.message ?? String(error) }, frontendOrigin)
      }
    }
    if (pathname === '/api/cloud-data/status') {
      const snapshot = state.snapshot()
      try {
        const formalStatus = await licenseAdminClient.getCloudDataStatus?.()
        const cloudStatus = await readCloudSnapshotStatus()
        const [analytics, lifecycleStats] = await Promise.all([
          licenseAdminClient.getDailyAnalytics?.().catch(() => null),
          supabaseClient.getPredictionLifecycleStats?.().catch(() => null),
        ])
        const todayRoundCount = Number(analytics?.todayRoundCount ?? await readTodayRoundCount()) || 0
        const tableCount = Number(cloudStatus?.tableCount ?? snapshot.tables.length ?? formalStatus?.tableCount ?? 0)
        const message = appendTodayRoundMessage(formalStatus?.message ?? cloudStatus?.statusText, todayRoundCount)
        return jsonResponse(200, { ok: true, mtAutoLoginEnabled: false, ...formalStatus, message, todayRoundCount, tableStats: analytics?.tableStats ?? [], dailyReports: analytics?.dailyReports ?? [], ...(lifecycleStats ? { lifecycleStats } : {}), captureSource: cloudStatus?.captureSource ?? captureSource, deployMode: deployConfig.deployMode, tableCount, status: { ...snapshot.status, ...cloudStatus } }, frontendOrigin)
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
    if (method === 'GET' && pathname === '/api/online-license/health') {
      try {
        const configured = Boolean(licenseAdminClient?.configured)
        const connected = configured && await licenseAdminClient.checkConnection?.() === true
        return jsonResponse(connected ? 200 : 503, { configured, connected }, frontendOrigin)
      } catch {
        return jsonResponse(503, { configured: Boolean(licenseAdminClient?.configured), connected: false }, frontendOrigin)
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
    if (method === 'POST' && pathname === '/api/online-license/member-session') {
      const token = extractBearerToken(headers.authorization)
      const authorized = Boolean(token) && await isMemberSessionAuthorized(headers)
      const session = token ? memberSessions.get(String(token)) : null
      if (!authorized || !session) return jsonResponse(401, { ok: false, error: 'member session is invalid or expired' }, frontendOrigin)
      return jsonResponse(200, { ok: true, sessionExpiresAt: new Date(session.expiresAtMs).toISOString() }, frontendOrigin)
    }
    if (method === 'POST' && pathname === '/api/online-license/member-login') return adminWrite(async () => {
      const credentials = parseJsonBody(rawBody)
      const result = await licenseAdminClient.validateMemberLogin?.(credentials)
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
      ?? extractBearerToken(headers.authorization)
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
      licenseId: loginResult.license?.id ?? null,
      authorizationVersion: loginResult.license?.updated_at ?? loginResult.license?.updatedAt ?? null,
      expiresAtMs,
    })
    return { memberSessionToken, sessionExpiresAt: new Date(expiresAtMs).toISOString() }
  }

  async function isMemberSessionAuthorized(headers = {}) {
    if (!memberAuthRequired) return true
    const token = extractBearerToken(headers.authorization)
    const session = token ? memberSessions.get(String(token)) : null
    if (!session || session.expiresAtMs <= now()) {
      if (token) memberSessions.delete(String(token))
      return false
    }
    try {
      if (typeof licenseAdminClient.validateMemberSession !== 'function') {
        memberSessions.delete(String(token))
        return false
      }
      const validation = await licenseAdminClient.validateMemberSession({
        memberAccount: session.memberAccount,
        licenseId: session.licenseId,
        authorizationVersion: session.authorizationVersion,
      })
      if (!validation?.ok) {
        memberSessions.delete(String(token))
        return false
      }
      return true
    } catch {
      memberSessions.delete(String(token))
      return false
    }
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

  async function readBestTables({ includePrediction = true } = {}) {
    const localTables = state.snapshot().tables
    if (localTables.length > 0) {
      const actionable = tablesReceivedAtMs > 0 && now() - tablesReceivedAtMs <= actionablePredictionTtlMs
      return includePrediction ? Promise.all(localTables.map((table) => withLivePrediction(table, actionable))) : localTables
    }
    if (tablesReceivedAtMs > 0) return []
    const cloudSnapshot = await readLatestCloudSnapshot({ requireFresh: true })
    return includePrediction ? Promise.all((cloudSnapshot?.tables ?? []).map((table) => withLivePrediction(table))) : (cloudSnapshot?.tables ?? [])
  }

  async function ensureRecentPerformanceReady() {
    if (recentPerformanceReady) return true
    if (!(production && supabaseClient?.configured === true && typeof supabaseClient.getRecentPredictionRows === 'function')) {
      recentPerformanceReady = true
      return true
    }
    if (recentPerformanceHydrationPromise) return recentPerformanceHydrationPromise
    if (now() < recentPerformanceRetryAtMs) return false
    recentPerformanceHydrationPromise = Promise.resolve()
      .then(() => supabaseClient.getRecentPredictionRows({ limit: 10000 }))
      .then((rows) => {
        recentTablePerformance.hydrate(rows)
        recentPerformanceReady = true
        recentPerformanceRetryAtMs = 0
        return true
      })
      .catch((error) => {
        recentPerformanceReady = false
        recentPerformanceRetryAtMs = now() + resolvedRecentPerformanceRetryMs
        state.setStatus({ persistenceStatus: 'error', persistenceError: error?.message ?? String(error) })
        return false
      })
      .finally(() => { recentPerformanceHydrationPromise = null })
    return recentPerformanceHydrationPromise
  }

  async function reconcileThenSavePendingPrediction(table) {
    let reconciliationError = null
    const tableId = canonicalProductionTableId(table?.tableId)
    const shoe = table?.shoe == null ? '' : String(table.shoe)
    const visibleRound = Number(table?.round)
    const canReconcile = supabaseClient?.configured === true
      && typeof supabaseClient.reconcilePredictionLifecycle === 'function'
      && PRODUCTION_TABLE_IDS.includes(tableId)
      && Boolean(shoe)
      && Number.isSafeInteger(visibleRound)
      && visibleRound > 0
    if (canReconcile) {
      const accepted = acceptLifecycleScreenIdentity(lifecycleGuardsByTable, { tableId, shoe, visibleRound })
      if (!accepted) return
      try {
        await supabaseClient.reconcilePredictionLifecycle({
          source: 'ofalive99',
          tableId,
          currentShoe: shoe,
          currentVisibleRound: visibleRound,
        })
      } catch (error) {
        reconciliationError = error
      }
    }
    await savePendingPrediction(table)
    if (reconciliationError) {
      state.setStatus({ persistenceStatus: 'error', persistenceError: reconciliationError?.message ?? String(reconciliationError) })
    }
  }

  function savePendingPrediction(table) {
    const currentRound = Number(table?.round)
    if (!table?.tableId || table?.shoe == null || !Number.isSafeInteger(currentRound)) return Promise.resolve(null)
    const expectedKey = predictionTargetKey(table.tableId, table.shoe, currentRound + 1)
    if (preparingPredictionPromises.has(expectedKey)) return preparingPredictionPromises.get(expectedKey)
    const preparation = savePendingPredictionImpl(table)
      .finally(() => preparingPredictionPromises.delete(expectedKey))
    preparingPredictionPromises.set(expectedKey, preparation)
    return preparation
  }

  async function savePendingPredictionImpl(table) {
    if (!isPredictionRuntimeReady()) return null
    if (!recentPerformanceReady && !await ensureRecentPerformanceReady()) return null
    const tablePerformance = recentTablePerformance.summary(table?.tableId, table?.shoe)
    const predictionInput = { ...table, ...tablePerformance }
    const formalPrediction = v104Formal
      ? await v104Formal.buildPrediction(predictionInput)
      : buildLivePrediction(predictionInput)
    const generated = { ...formalPrediction, createdAtMs: now() }
    if (!isValidPendingPrediction(generated)) return null
    const key = predictionTargetKey(generated.targetTableId, generated.targetShoe, generated.targetRound)
    if (expiredPredictionKeys.has(key)) return null
    const existing = pendingPredictions.get(key)
    if (existing && isPendingPredictionExpired(existing)) {
      pendingPredictions.delete(key)
      rememberExpiredPredictionKey(key)
      return null
    }
    if (pendingPredictions.has(key)) return pendingPredictions.get(key)
    if (issuingPredictionPromises.has(key)) return issuingPredictionPromises.get(key)
    const durableIssuanceRequired = isDurablePredictionIssuanceRequired()
    if (!durableIssuanceRequired) {
      const localPrediction = deepFreeze(structuredClone(generated))
      pendingPredictions.set(key, localPrediction)
      return localPrediction
    }
    if (typeof supabaseClient.issuePrediction !== 'function') {
      state.setStatus({ persistenceStatus: 'error', persistenceError: 'durable prediction issuance is unavailable' })
      return null
    }
    const issuance = Promise.resolve()
      .then(() => supabaseClient.issuePrediction(generated))
      .then((issued) => {
        if (!isValidPendingPrediction(issued) || !issued.predictionId || !issued.issuedAt
          || predictionTargetKey(issued.targetTableId, issued.targetShoe, issued.targetRound) !== key
          || issued.strategyVersion !== generated.strategyVersion) {
          throw new Error('durable prediction issuance acknowledgement failed')
        }
        const immutable = deepFreeze(structuredClone({
          ...issued,
          createdAtMs: Number(issued.createdAtMs ?? Date.parse(issued.issuedAt)) || generated.createdAtMs,
        }))
        v104Formal?.recordIssuance?.(immutable)
        pendingPredictions.set(key, immutable)
        state.setStatus({ persistenceStatus: 'ok', persistenceError: null })
        return immutable
      })
      .catch((error) => {
        state.setStatus({ persistenceStatus: 'error', persistenceError: error?.message ?? String(error) })
        return null
      })
      .finally(() => issuingPredictionPromises.delete(key))
    issuingPredictionPromises.set(key, issuance)
    return issuance
  }

  function rememberIssuedPredictionReadBackoff(key) {
    issuedPredictionReadRetryAt.set(key, now() + 2000)
    while (issuedPredictionReadRetryAt.size > 1000) {
      issuedPredictionReadRetryAt.delete(issuedPredictionReadRetryAt.keys().next().value)
    }
  }

  function startIssuedPredictionRead(table, targetRound, key, durableIssuanceRequired) {
    if (readingIssuedPredictionPromises.has(key)) return readingIssuedPredictionPromises.get(key)
    const retryAt = Number(issuedPredictionReadRetryAt.get(key) ?? 0)
    if (retryAt > now()) return Promise.resolve(null)
    issuedPredictionReadRetryAt.delete(key)
    if (typeof supabaseClient?.readIssuedPrediction !== 'function') return Promise.resolve(null)
    const read = Promise.resolve()
      .then(() => supabaseClient.readIssuedPrediction({
        tableId: table.tableId,
        shoe: table.shoe,
        round: targetRound,
        strategyVersion: ALL_MT_EQUAL_STRATEGY_VERSION,
      }))
      .then((candidate) => {
        if (!isExactScreenPrediction(candidate, table, targetRound, durableIssuanceRequired)) {
          rememberIssuedPredictionReadBackoff(key)
          return null
        }
        issuedPredictionReadRetryAt.delete(key)
        const exact = deepFreeze(structuredClone({
          ...candidate,
          createdAtMs: Number(candidate.createdAtMs ?? Date.parse(candidate.issuedAt)) || now(),
        }))
        pendingPredictions.set(key, exact)
        return exact
      })
      .catch((error) => {
        rememberIssuedPredictionReadBackoff(key)
        state.setStatus({ persistenceStatus: 'error', persistenceError: error?.message ?? String(error) })
        return null
      })
      .finally(() => readingIssuedPredictionPromises.delete(key))
    readingIssuedPredictionPromises.set(key, read)
    return read
  }

  async function withLivePrediction(table, actionable = true) {
    if (!actionable || table?.tableId == null || table?.shoe == null || table?.round == null) {
      return { ...table, buildVersion: BUILD_VERSION, prediction: null }
    }

    await Promise.race([
      savePendingPrediction(table),
      new Promise((resolve) => setTimeout(() => resolve(null), 25)),
    ])
    const targetRound = Number(table.round)
    const key = predictionTargetKey(table.tableId, table.shoe, targetRound)
    const durableIssuanceRequired = isDurablePredictionIssuanceRequired()
    let exact = pendingPredictions.get(key)
    if (exact && isPendingPredictionExpired(exact)) {
      pendingPredictions.delete(key)
      rememberExpiredPredictionKey(key)
      exact = null
    }
    if (!exact && durableIssuanceRequired) {
      exact = await Promise.race([
        startIssuedPredictionRead(table, targetRound, key, durableIssuanceRequired),
        new Promise((resolve) => setTimeout(() => resolve(null), 50)),
      ])
    }
    if (!exact && !durableIssuanceRequired && !expiredPredictionKeys.has(key) && isPredictionRuntimeReady() && recentPerformanceReady) {
      const tablePerformance = recentTablePerformance.summary(table.tableId)
      const localPrediction = v104Formal
        ? await v104Formal.buildPrediction({ ...table, ...tablePerformance })
        : buildLivePrediction({ ...table, ...tablePerformance })
      exact = deepFreeze(structuredClone({
        ...localPrediction,
        targetRound,
        createdAtMs: now(),
      }))
      pendingPredictions.set(key, exact)
    }
    if (!isExactScreenPrediction(exact, table, targetRound, durableIssuanceRequired)) exact = null
    if (exact && !pendingPredictions.has(key)) {
      exact = deepFreeze(structuredClone({
        ...exact,
        createdAtMs: Number(exact.createdAtMs ?? Date.parse(exact.issuedAt)) || now(),
      }))
      pendingPredictions.set(key, exact)
    }
    return { ...table, buildVersion: BUILD_VERSION, prediction: exact ? structuredClone(exact) : null }
  }

  function isDurablePredictionIssuanceRequired() {
    return supabaseClient?.configured === true
      && (requireVerifiedStrategy || typeof supabaseClient.issuePrediction === 'function')
  }

  function isExactScreenPrediction(prediction, table, targetRound, durableRequired) {
    return Boolean(prediction)
      && isValidPendingPrediction(prediction)
      && (!durableRequired || (Boolean(prediction.predictionId) && Boolean(prediction.issuedAt)))
      && prediction.strategyVersion === ALL_MT_EQUAL_STRATEGY_VERSION
      && predictionTargetKey(prediction.targetTableId, prediction.targetShoe, prediction.targetRound)
        === predictionTargetKey(table.tableId, table.shoe, targetRound)
  }

  function isPendingPredictionExpired(prediction) {
    return now() - Number(prediction?.createdAtMs ?? 0) > actionablePredictionTtlMs
  }

  function rememberExpiredPredictionKey(key) {
    expiredPredictionKeys.delete(key)
    expiredPredictionKeys.add(key)
    while (expiredPredictionKeys.size > expiredPredictionKeyLimit) {
      expiredPredictionKeys.delete(expiredPredictionKeys.values().next().value)
    }
  }

  function buildServiceHealth() {
    const runtimeStatus = typeof supabaseClient?.getRuntimeStatus === 'function' ? supabaseClient.getRuntimeStatus() : null
    const runtimeUnavailable = requireVerifiedStrategy && (
      supabaseClient?.configured !== true
      || runtimeStatus == null
      || runtimeStatus.ready !== true
      || runtimeStatus.degraded === true
    )
    const missingIngestKey = !ingestKey && (production || deployConfig.deployMode === 'cloud')
    const stateStatus = state.snapshot().status
    const stateDegraded = stateStatus.health === 'degraded'
    const degraded = missingIngestKey || runtimeUnavailable || stateDegraded
    return {
      health: degraded ? 'degraded' : 'ok',
      degraded,
      reason: missingIngestKey ? 'ingest_key_missing' : runtimeUnavailable ? (runtimeStatus.reason ?? 'active_strategy_not_ready') : stateDegraded ? stateStatus.reason : null,
      runtimeStatus,
    }
  }

  function isPredictionRuntimeReady() {
    if (!requireVerifiedStrategy) return true
    if (supabaseClient?.configured !== true) return false
    if (typeof supabaseClient?.getRuntimeStatus !== 'function') return false
    const runtimeStatus = supabaseClient.getRuntimeStatus()
    return runtimeStatus?.ready === true && runtimeStatus?.degraded !== true
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
    const requestFrontendOrigin = resolveFrontendCorsOrigin(configuredFrontendOrigin, req.headers.origin)
    if ((req.method ?? 'GET') === 'GET' && requestUrl.pathname === '/api/tables/stream') {
      if (production && String(req.headers['x-forwarded-proto'] ?? '').toLowerCase() !== 'https') {
        const result = jsonResponse(426, { ok: false, error: 'HTTPS is required' }, requestFrontendOrigin)
        res.writeHead(result.statusCode, result.headers)
        res.end(result.body)
        return
      }
      if (hasSensitiveAuthQuery(requestUrl)) {
        const result = jsonResponse(400, { ok: false, error: 'session token is not allowed in query' }, requestFrontendOrigin)
        res.writeHead(result.statusCode, result.headers)
        res.end(result.body)
        return
      }
      if (!await isMemberSessionAuthorized(req.headers)) {
        const result = jsonResponse(401, { ok: false, error: 'member session is required' }, requestFrontendOrigin)
        res.writeHead(result.statusCode, result.headers)
        res.end(result.body)
        return
      }
      return streamTables(res, req.headers)
    }
    let rawBody = ''
    try {
      rawBody = await readRequestBody(req)
    } catch (error) {
      const result = jsonResponse(error?.statusCode ?? 400, { ok: false, error: error?.message ?? String(error) }, requestFrontendOrigin)
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

  function writeSse(res, event, payload) {
    if (res.destroyed || res.writableEnded) return
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
  }

  async function broadcastTables(force = false) {
    if (!streamClients.size) return
    try {
      const tables = await readBestTables()
      const signature = JSON.stringify(tables)
      const payload = { tables, updatedAt: new Date().toISOString(), tableCount: tables.length }
      const authorizedClients = []
      for (const client of streamClients) {
        if (await isMemberSessionAuthorized(client.headers)) authorizedClients.push(client)
        else {
          writeSse(client.res, 'unauthorized', { status: 401, error: 'member session is required' })
          client.res.end()
          streamClients.delete(client)
        }
      }
      if (!authorizedClients.length) {
        stopStreamTimerIfIdle()
        return
      }
      if (force || signature !== streamLastSignature) {
        streamLastSignature = signature
        for (const client of authorizedClients) writeSse(client.res, 'tables', payload)
      } else {
        const heartbeat = { updatedAt: new Date().toISOString(), tableCount: tables.length }
        for (const client of authorizedClients) writeSse(client.res, 'heartbeat', heartbeat)
      }
    } catch (error) {
      const payload = { message: error?.message ?? String(error), updatedAt: new Date().toISOString() }
      for (const client of streamClients) writeSse(client.res, 'error', payload)
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

  function streamTables(res, headers) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'pragma': 'no-cache',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
      'access-control-allow-origin': resolveFrontendCorsOrigin(configuredFrontendOrigin, headers.origin),
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'Content-Type,Authorization,X-Admin-Session-Token,X-Member-Session-Token,X-Control-Token',
    })
    const client = { res, headers }
    streamClients.add(client)
    ensureStreamTimer()
    void broadcastTables(true)
    res.on('close', () => { streamClients.delete(client); stopStreamTimerIfIdle() })
  }
  const listenHost = host ?? (deployConfig.deployMode === 'cloud' ? '0.0.0.0' : '127.0.0.1')

  return {
    state,
    server,
    async start() {
      const listeningServer = await new Promise((resolve) => server.listen(port, listenHost, () => resolve(server)))
      if (requireVerifiedStrategy && supabaseClient?.configured === true && typeof supabaseClient.ensureInitialStrategy === 'function') {
        try {
          await supabaseClient.ensureInitialStrategy()
          await ensureRecentPerformanceReady()
        } catch (error) {
          recentPerformanceReady = false
          state.setStatus({ persistenceStatus: 'error', persistenceError: error?.message ?? String(error) })
        }
      }
      if (v104Formal && typeof v104Formal.start === 'function') {
        try {
          await v104Formal.start()
        } catch (error) {
          state.setStatus({ persistenceStatus: 'error', persistenceError: error?.message ?? String(error) })
        }
      }
      if (shouldAutoConnect) {
        if (captureSource === 'cloud_browser' && cloudBrowserUrl) cloudCaptureClient.start()
        else if (captureUrl) chromeClient.start()
        else mtClient.connect()
      }
      if (v103Shadow?.enabled === true && typeof v103Shadow.start === 'function') void v103Shadow.start().catch(() => {})
      if (v104Shadow?.enabled === true && typeof v104Shadow.start === 'function') void v104Shadow.start().catch(() => {})
      if (v104IterationShadow?.enabled === true && typeof v104IterationShadow.start === 'function') void v104IterationShadow.start().catch(() => {})
      if (v105Shadow?.enabled === true && typeof v105Shadow.start === 'function') void Promise.resolve().then(() => v105Shadow.start()).catch(() => {})
      if (v105ShadowV7?.enabled === true && typeof v105ShadowV7.start === 'function') void Promise.resolve().then(() => v105ShadowV7.start()).catch(() => {})
      return listeningServer
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
  return hasExactRealCardCodes(round)
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

function extractBearerToken(value) {
  const match = /^Bearer\s+(\S+)$/i.exec(String(value ?? '').trim())
  return match?.[1] ?? null
}

function predictionTargetKey(tableId, shoe, round) {
  return `${String(tableId ?? '')}:${String(shoe ?? '')}:${Number(round ?? 0)}`
}

const SIDE_PREDICTION_KEYS = ['tie', 'superSix', 'bankerPair', 'playerPair', 'bankerDragon', 'playerDragon']

function isValidPendingPrediction(prediction = {}) {
  if (!String(prediction.targetTableId ?? '').trim()) return false
  if (!String(prediction.targetShoe ?? '').trim()) return false
  if (!Number.isSafeInteger(Number(prediction.targetRound)) || Number(prediction.targetRound) < 1) return false
  if (!hasExactKeys(prediction.sidePredictions, SIDE_PREDICTION_KEYS)) return false
  if (!hasExactKeys(prediction.sideActions, SIDE_PREDICTION_KEYS)) return false
  if (!SIDE_PREDICTION_KEYS.every((key) => Number.isFinite(prediction.sidePredictions[key]))) return false
  if (!SIDE_PREDICTION_KEYS.every((key) => typeof prediction.sideActions[key] === 'boolean')) return false
  return true
}

function hasExactKeys(value, expectedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  const expected = [...expectedKeys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
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

async function withDeadline(operation, timeoutMs, message) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), Math.max(1, Number(timeoutMs) || 1))
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function validateIngestEnvelope(envelope, currentTime) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error('invalid payload')
  if (envelope.protocolVersion !== WORKER_PROTOCOL_VERSION) {
    const error = new Error('version_mismatch')
    error.statusCode = 409
    error.versionMismatch = true
    error.receivedProtocolVersion = envelope.protocolVersion
    throw error
  }
  const timestamp = Number(envelope.timestamp)
  if (!Number.isFinite(timestamp) || Math.abs(Number(currentTime) - timestamp) > 5 * 60 * 1000) {
    const error = new Error('timestamp outside allowed window')
    error.statusCode = 409
    throw error
  }
  if (!Number.isSafeInteger(envelope.sequence) || envelope.sequence < 0) throw new Error('sequence must be a non-negative integer')
  const snapshot = envelope.snapshot
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('snapshot must be an object')
  if (snapshot.buildVersion !== WORKER_PROTOCOL_BUILD_VERSION) {
    const error = new Error('version_mismatch')
    error.statusCode = 409
    error.versionMismatch = true
    error.receivedProtocolVersion = snapshot.buildVersion
    throw error
  }
  if (!Array.isArray(snapshot.tables)) throw new Error('tables must be an array')
  if (snapshot.tables.length > 128) throw new Error('tables exceeds maximum length')
  for (const table of snapshot.tables) {
    if (!table || typeof table !== 'object' || Array.isArray(table)) throw new Error('each table must be an object')
    if (table.tableId == null && table.table_id == null && table.id == null) throw new Error('each table requires tableId')
  }
  if (snapshot.rounds != null && !Array.isArray(snapshot.rounds)) throw new Error('rounds must be an array')
  const rounds = snapshot.rounds ?? []
  for (const round of rounds) validateIngestRound(round)
  if (!Array.isArray(envelope.roundKeys)) throw new Error('roundKeys must be an array')
  if (envelope.roundKeys.length !== rounds.length) throw new Error('roundKeys length must match rounds length')
  const expectedRoundKeys = rounds.map(buildAcceptedRoundKey)
  for (let index = 0; index < expectedRoundKeys.length; index += 1) {
    if (envelope.roundKeys[index] !== expectedRoundKeys[index]) throw new Error(`roundKeys[${index}] must equal ${expectedRoundKeys[index]}`)
  }
  return expectedRoundKeys
}

function validateIngestRound(round) {
  if (!round || typeof round !== 'object' || Array.isArray(round)) throw new Error('each round must be an object')
  if (!isVerifiedFinalRoundAction(round.sourceAction)) throw new Error('provisional show_poker or unknown action cannot be durably ingested without a verified final action')
  if (!String(round.tableId ?? '').trim()) throw new Error('each round requires tableId')
  if (!String(round.shoe ?? '').trim()) throw new Error('each round requires shoe')
  if (!Number.isSafeInteger(Number(round.round)) || Number(round.round) < 1) throw new Error('each round requires a positive integer round')
  if (!['banker', 'player', 'tie'].includes(round.winner)) throw new Error('each round requires a valid winner')
  if (!isExactTenRawResult(round.rawResult)) {
    throw new Error('each round requires a ten-value rawResult')
  }
}

function buildAcceptedRoundKey(round = {}) {
  return `${String(round.tableId).trim()}:${String(round.shoe).trim()}:${Number(round.round)}`
}

function assertDurableIngestWriter(writer, roundCount) {
  if (!writer?.configured || typeof writer.writeCloudTableSnapshot !== 'function') {
    throw new Error('durable snapshot writer is not configured')
  }
  if (roundCount > 0 && typeof writer.writeCloudRoundEvent !== 'function') {
    throw new Error('durable round writer is not configured')
  }
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

function svgResponse(statusCode, svg, frontendOrigin = '*') {
  return {
    statusCode,
    headers: {
      'content-type': 'image/svg+xml; charset=utf-8',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'x-content-type-options': 'nosniff',
      'access-control-allow-origin': frontendOrigin,
      'access-control-allow-methods': 'GET,OPTIONS',
      'access-control-allow-headers': 'Authorization,X-Admin-Session-Token',
      'cache-control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      pragma: 'no-cache',
    },
    body: String(svg),
  }
}

function assertSecureCloudBrowserUrl(value, { production = false, deployMode = 'local' } = {}) {
  if (!value || (!production && deployMode !== 'cloud')) return
  let parsed
  try { parsed = new URL(value) } catch { throw new Error('CLOUD_BROWSER_URL must be a valid URL') }
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)
  if (parsed.protocol !== 'https:' && !loopback) throw new Error('CLOUD_BROWSER_URL must use HTTPS')
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
