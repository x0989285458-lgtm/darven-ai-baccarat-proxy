import http from 'node:http'
import crypto from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { fileURLToPath } from 'node:url'
import { createProxyState } from './state-store.js'
import { createMtClient } from './mt-client.js'
import { createChromeCaptureClient } from './chrome-capture.js'
import { applyCloudCapturePayload, canonicalProductionTableId, createCloudCaptureClient, parseCloudCapturePayload, PRODUCTION_TABLE_IDS } from './cloud-capture.js'
import { loadLocalEnv, maskToken, resolveDeployConfig } from './config.js'
import { ALL_MT_EQUAL_STRATEGY_VERSION, buildLivePrediction, createSupabaseIngestionClient } from './supabase-writer.js'
import { createRecentTablePerformanceStore } from './recent-table-performance.js'
import { createV100FormalRuntime, resolveV100FormalEnabled } from './v100-formal-runtime.js'
import { createV105FormalRuntime } from './v105-formal-runtime.js'
import { createOnlineCoreClient } from './online-core.js'
import { createLicenseAdminClient } from './license-admin.js'
import { chooseCaptureSource, describeCaptureStatus } from './capture-source.js'
import { buildOperationalEvent, toStatusEvent } from './event-layer.js'
import { createFormalDailyMemoryRollover } from './formal-daily-memory-rollover.js'
import { BUILD_VERSION } from './build-version.js'
import { hasExactRealCardCodes, isExactTenRawResult, isVerifiedFinalRoundAction } from '../../shared/real-card-validator.js'
import { createInMemoryIngestSourceFence, normalizeSource } from './ingest-source-fence.js'

const VERSION = BUILD_VERSION
const SERVICE = 'Draven MT資料代理伺服器'
const WORKER_PROTOCOL_BUILD_VERSION = '105'
const WORKER_PROTOCOL_VERSION = 'v105'
const LIFECYCLE_IDENTITIES_PER_TABLE = 256
const LIFECYCLE_SHOES_PER_TABLE = 64
const MEMBER_SESSION_TOKEN_VERSION = 1
const ADMIN_SESSION_TOKEN_VERSION = 1
const ADMIN_SESSION_SECRET_MIN_BYTES = 32

export function createServiceWorkScheduler({ yieldControl = () => new Promise((resolve) => setImmediate(resolve)) } = {}) {
  const priorityQueue = []
  const latestByKey = new Map()
  const idleWaiters = []
  let running = false
  let scheduled = false
  let priorityStreak = 0
  let closing = false

  const resolveIdle = () => {
    if (running || priorityQueue.length > 0 || latestByKey.size > 0) return
    for (const resolve of idleWaiters.splice(0)) resolve()
  }
  const schedule = () => {
    if (scheduled || running) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      void drain()
    })
  }
  const createWaiter = () => {
    let resolve
    let reject
    const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject })
    return { promise, resolve, reject }
  }
  const settleItem = (item, method, value) => {
    for (const waiter of item.waiters) waiter[method](value)
  }
  const drain = async () => {
    if (running) return
    running = true
    try {
      while (priorityQueue.length > 0 || latestByKey.size > 0) {
        const usePriority = priorityQueue.length > 0 && (latestByKey.size === 0 || priorityStreak < 4)
        const item = usePriority ? priorityQueue.shift() : latestByKey.values().next().value
        if (usePriority) priorityStreak += 1
        else {
          latestByKey.delete(item.key)
          priorityStreak = 0
        }
        try {
          settleItem(item, 'resolve', await item.task())
        } catch (error) {
          settleItem(item, 'reject', error)
        }
        await yieldControl()
      }
    } finally {
      running = false
      resolveIdle()
      if (priorityQueue.length > 0 || latestByKey.size > 0) schedule()
    }
  }

  const waitForIdle = () => {
    if (!running && priorityQueue.length === 0 && latestByKey.size === 0) return Promise.resolve()
    return new Promise((resolve) => idleWaiters.push(resolve))
  }

  return {
    enqueuePriority(task) {
      if (closing) return Promise.reject(new Error('service work scheduler is closing'))
      const waiter = createWaiter()
      priorityQueue.push({ key: null, task, waiters: [waiter] })
      schedule()
      return waiter.promise
    },
    enqueueLatest(key, task) {
      if (closing) return Promise.reject(new Error('service work scheduler is closing'))
      const normalizedKey = String(key)
      const waiter = createWaiter()
      const pending = latestByKey.get(normalizedKey)
      if (pending) {
        pending.task = task
        pending.waiters.push(waiter)
      } else {
        latestByKey.set(normalizedKey, { key: normalizedKey, task, waiters: [waiter] })
      }
      schedule()
      return waiter.promise
    },
    waitForIdle,
    closeAndWait() {
      closing = true
      return waitForIdle()
    },
  }
}

function createTrackedServiceWorkController() {
  const active = new Set()
  const activeByKey = new Map()
  const controllers = new Map()
  let closing = false

  function run(key, operation, timeoutMs, label) {
    if (closing) return Promise.reject(new Error('tracked service work is closing'))
    const activeWork = activeByKey.get(key)
    if (activeWork) return activeWork.catch(() => {}).then(() => run(key, operation, timeoutMs, label))
    const controller = new AbortController()
    const underlying = Promise.resolve().then(() => operation({ signal: controller.signal }))
    active.add(underlying)
    activeByKey.set(key, underlying)
    controllers.set(underlying, controller)
    const cleanup = () => {
      active.delete(underlying)
      controllers.delete(underlying)
      if (activeByKey.get(key) === underlying) activeByKey.delete(key)
    }
    void underlying.then(cleanup, cleanup)
    let timer = null
    return Promise.race([
      underlying,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(new Error(label))
          reject(new Error(label))
        }, Math.max(1, Number(timeoutMs) || 1))
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer)
    })
  }

  async function waitForIdle() {
    while (active.size > 0) await Promise.allSettled([...active])
  }

  async function closeAndWait() {
    closing = true
    for (const controller of controllers.values()) controller.abort(new Error('tracked service work is closing'))
    await waitForIdle()
  }

  return { run, waitForIdle, closeAndWait }
}

function deriveMemberSessionKey(secret) {
  const value = String(secret ?? '')
  return value ? crypto.createHash('sha256').update(value).digest() : null
}

function sealMemberSession(session, key) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(session), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([Buffer.from([MEMBER_SESSION_TOKEN_VERSION]), iv, tag, encrypted]).toString('base64url')
}

function openMemberSession(token, key) {
  try {
    const value = Buffer.from(String(token ?? ''), 'base64url')
    if (value.length <= 29 || value[0] !== MEMBER_SESSION_TOKEN_VERSION) return null
    const iv = value.subarray(1, 13)
    const tag = value.subarray(13, 29)
    const encrypted = value.subarray(29)
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    const session = JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8'))
    if (!session || typeof session !== 'object' || Array.isArray(session)
      || typeof session.memberAccount !== 'string' || !session.memberAccount
      || typeof session.licenseId !== 'string' || !session.licenseId
      || !Number.isFinite(session.expiresAtMs)) return null
    return session
  } catch {
    return null
  }
}

function deriveAdminSessionKey(secret) {
  const value = String(secret ?? '')
  return Buffer.byteLength(value, 'utf8') >= ADMIN_SESSION_SECRET_MIN_BYTES
    ? crypto.createHash('sha256').update(`admin-session-v1:${value}`).digest()
    : null
}

function sealAdminSession(session, key) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(session), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([Buffer.from([ADMIN_SESSION_TOKEN_VERSION]), iv, tag, encrypted]).toString('base64url')
}

function openAdminSession(token, key) {
  try {
    const value = Buffer.from(String(token ?? ''), 'base64url')
    if (value.length <= 29 || value[0] !== ADMIN_SESSION_TOKEN_VERSION) return null
    const iv = value.subarray(1, 13)
    const tag = value.subarray(13, 29)
    const encrypted = value.subarray(29)
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    const session = JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8'))
    if (!session || typeof session !== 'object' || Array.isArray(session)
      || typeof session.adminAccount !== 'string' || !session.adminAccount
      || typeof session.role !== 'string' || !Number.isFinite(session.expiresAtMs)) return null
    return session
  } catch {
    return null
  }
}

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

function isOlderTableScreen(candidate = {}, current = {}) {
  const candidateShoe = String(candidate?.shoe ?? '')
  const currentShoe = String(current?.shoe ?? '')
  const candidateRound = Number(candidate?.round)
  const currentRound = Number(current?.round)
  if (!candidateShoe || !currentShoe || !Number.isSafeInteger(candidateRound) || !Number.isSafeInteger(currentRound)) return false
  if (candidateShoe === currentShoe) return candidateRound < currentRound
  const candidateNumericShoe = numericShoe(candidateShoe)
  const currentNumericShoe = numericShoe(currentShoe)
  return candidateNumericShoe != null && currentNumericShoe != null && candidateNumericShoe < currentNumericShoe
}

function mergeMonotonicTableScreens(currentTables = [], candidateTables = []) {
  const candidateByTable = new Map(candidateTables.map((table) => [canonicalProductionTableId(table?.tableId), table]))
  const merged = currentTables.map((current) => {
    const tableId = canonicalProductionTableId(current?.tableId)
    const candidate = candidateByTable.get(tableId)
    candidateByTable.delete(tableId)
    if (!candidate || isOlderTableScreen(candidate, current)) return structuredClone(current)
    return candidate
  })
  return [...merged, ...candidateByTable.values()]
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

function resolveBoundedConcurrency(value, name, maximum) {
  const resolved = value === undefined || value === null || value === '' ? maximum : Number(value)
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`)
  }
  return resolved
}

export function resolveProductionConcurrency(env = process.env) {
  return {
    formalIdentityConcurrency: resolveBoundedConcurrency(env?.V100_FORMAL_IDENTITY_CONCURRENCY, 'V100_FORMAL_IDENTITY_CONCURRENCY', 9),
    strategyPriorityConcurrency: resolveBoundedConcurrency(env?.STRATEGY_PRIORITY_CONCURRENCY, 'STRATEGY_PRIORITY_CONCURRENCY', 8),
  }
}

export function createApp({ autoConnect, token = process.env.MT_TOKEN, port = Number(process.env.PORT ?? 8787), host = process.env.HOST, captureUrl = process.env.CHROME_CAPTURE_URL, cloudBrowserUrl = process.env.CLOUD_BROWSER_URL, deployMode = process.env.DEPLOY_MODE ?? 'local', captureSource: requestedCaptureSource = process.env.CAPTURE_SOURCE, frontendOrigin: configuredFrontendOrigin = process.env.PUBLIC_FRONTEND_ORIGIN || '*', controlToken = process.env.PROXY_CONTROL_TOKEN || process.env.WORKER_ADMIN_KEY, controlAllowedOrigin = process.env.CONTROL_ALLOWED_ORIGIN || process.env.PUBLIC_FRONTEND_ORIGIN || '', ingestKey = process.env.INGEST_KEY || process.env.WORKER_ADMIN_KEY, ingestDeadlineMs = Number(process.env.INGEST_REQUEST_DEADLINE_MS ?? 110000), outboxWorkDeadlineMs = Number(process.env.CAPTURE_OUTBOX_WORK_DEADLINE_MS ?? 45000), outboxBackoffMs = Number(process.env.CAPTURE_OUTBOX_BACKOFF_MS ?? 1000), outboxCoalesceMs = process.env.CAPTURE_OUTBOX_COALESCE_MS ?? 1000, captureOutboxBatchLimit = process.env.CAPTURE_OUTBOX_BATCH_LIMIT ?? 30, captureOutboxConsumerEnabled = process.env.CAPTURE_OUTBOX_CONSUMER_ENABLED ?? true, captureOutboxPollMs = process.env.CAPTURE_OUTBOX_POLL_MS ?? 0, now = Date.now, predictionTtlMs = Number(process.env.PREDICTION_TTL_MS ?? 120000), maxExpiredPredictionKeys = Number(process.env.MAX_EXPIRED_PREDICTION_KEYS ?? 10000), production = process.env.NODE_ENV === 'production', requireVerifiedStrategy = production, memberAuthRequired = production, memberSessionTtlMs = Number(process.env.MEMBER_SESSION_TTL_MS ?? 30 * 60 * 1000), memberSessionSecret = process.env.MEMBER_SESSION_SECRET, adminSessionSecret = process.env.ADMIN_SESSION_SECRET || memberSessionSecret, adminSessionTtlMs: requestedAdminSessionTtlMs = Number(process.env.ADMIN_SESSION_TTL_MS ?? 30 * 60 * 1000), memberSessionValidationTtlMs = Number(process.env.MEMBER_SESSION_VALIDATION_TTL_MS ?? 0), v105FormalHydrationTimeoutMs = Number(process.env.V105_FORMAL_HYDRATION_TIMEOUT_MS ?? 60000), recentPerformanceRetryMs = Number(process.env.RECENT_PERFORMANCE_RETRY_MS ?? 30000), predictionIssuanceRetryMs = Number(process.env.PREDICTION_ISSUANCE_RETRY_MS ?? 10000), streamHeartbeatMs = Number(process.env.STREAM_HEARTBEAT_MS ?? 3000), serviceShutdownDeadlineMs = 5000, fatalHandler = null, fetchImpl = globalThis.fetch, supabaseClient = createSupabaseIngestionClient({ dbConnectionString: process.env.SUPABASE_DB_CONNECTION_STRING, requestTimeoutMs: Number(process.env.SUPABASE_REQUEST_TIMEOUT_MS ?? 30000), durableWriteRequestTimeoutMs: Number(process.env.DURABLE_INGEST_REQUEST_TIMEOUT_MS ?? 30000) }), onlineCoreClient = createOnlineCoreClient(), licenseAdminClient = createLicenseAdminClient(), v100FormalRuntime = null, v104FormalRuntime = null, dailyMemoryRollover = null, requireFencedIngest = process.env.REQUIRE_FENCED_INGEST === 'true', sourceFenceStore = null } = {}) {
  const ingestSourceFence = sourceFenceStore ?? createInMemoryIngestSourceFence()
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
  const resolvedCaptureOutboxConsumerEnabled = captureOutboxConsumerEnabled !== false
    && String(captureOutboxConsumerEnabled).trim().toLowerCase() !== 'false'
  const captureOutboxPollText = typeof captureOutboxPollMs === 'string' ? captureOutboxPollMs.trim() : null
  const resolvedCaptureOutboxPollMs = Number(captureOutboxPollMs)
  if (captureOutboxPollText === ''
    || !Number.isSafeInteger(resolvedCaptureOutboxPollMs)
    || resolvedCaptureOutboxPollMs < 0
    || (resolvedCaptureOutboxPollMs > 0 && resolvedCaptureOutboxPollMs < 10)
    || resolvedCaptureOutboxPollMs > 60_000) {
    throw new Error('capture outbox poll interval must be zero or a safe integer from 10 through 60000 milliseconds')
  }
  const strictRealCardRounds = process.env.REQUIRE_REAL_CARD_ROUNDS !== 'false'
  const adminSessions = new Map()
  const adminSessionKey = deriveAdminSessionKey(adminSessionSecret)
  const legacyIngestSequences = new Map()
  const ingestSessionLocks = new Map()
  let outboxDrainPromise = null
  let outboxWakeTimer = null
  let outboxWakeAtMs = null
  let outboxWakePromise = null
  let resolveOutboxWake = null
  let outboxWakeGeneration = 0
  let outboxStopping = false
  let captureOutboxFatal = null
  let fatalHandlerCalled = false
  let outboxRetryCount = 0
  let outboxHealthRetryCount = 0
  const attemptedFailureAcks = new Set()
  const pendingPredictions = new Map()

  const preparingPredictionPromises = new Map()
  const issuingPredictionPromises = new Map()
  const readingIssuedPredictionPromises = new Map()
  const issuedPredictionReadRetryAt = new Map()
  const issuanceRetryAt = new Map()
  const expiredPredictionKeys = new Set()
  const immediateBroadcastPredictionIds = new Set()
  const settlingPredictionPromises = new Map()
  const lifecycleGuardsByTable = new Map()
  const latestObservedScreenByTable = new Map()
  const latestObservedScreenGuardsByTable = new Map()
  const memberSessions = new Map()
  const memberSessionKey = deriveMemberSessionKey(memberSessionSecret)
  const memberSessionValidationCache = new Map()
  const memberSessionValidationInFlight = new Map()
  const memberSessionRejectedUntil = new Map()
  const resolvedMemberSessionValidationTtlMs = Math.max(0, Number(memberSessionValidationTtlMs) || 0)
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
  const resolvedPredictionIssuanceRetryMs = Math.max(1000, Number(predictionIssuanceRetryMs) || 10000)
  const resolvedServiceShutdownDeadlineMs = Math.max(1, Number(serviceShutdownDeadlineMs) || 5000)
  const resolvedIngestDeadlineMs = Math.min(110000, Math.max(1, Number(ingestDeadlineMs) || 110000))
  const resolvedOutboxWorkDeadlineMs = Math.max(1, Number(outboxWorkDeadlineMs) || 45000)
  const resolvedOutboxBackoffMs = Math.max(1, Number(outboxBackoffMs) || 1000)
  const resolvedOutboxCoalesceMs = Number(outboxCoalesceMs)
  if ((typeof outboxCoalesceMs === 'string' && outboxCoalesceMs.trim() === '')
    || !Number.isSafeInteger(resolvedOutboxCoalesceMs)
    || resolvedOutboxCoalesceMs < 0
    || resolvedOutboxCoalesceMs > 5000) {
    throw new Error('outbox coalesce must be an integer from 0 through 5000 milliseconds')
  }
  const resolvedCaptureOutboxBatchLimit = Number(captureOutboxBatchLimit)
  if ((typeof captureOutboxBatchLimit === 'string' && captureOutboxBatchLimit.trim() === '')
    || !Number.isSafeInteger(resolvedCaptureOutboxBatchLimit)
    || resolvedCaptureOutboxBatchLimit < 1
    || resolvedCaptureOutboxBatchLimit > 100) {
    throw new Error('outbox batch limit must be an integer from 1 through 100')
  }
  const resolvedFatalHandler = fatalHandler ?? (production
    ? ({ exitCode }) => process.exit(exitCode)
    : () => {})
  let tablesReceivedAtMs = 0
  const serviceWorkScheduler = createServiceWorkScheduler()
  const v104Formal = v104FormalRuntime ?? createV105FormalRuntime({
    writer: supabaseClient,
    requestTimeoutMs: Math.max(1000, Number(v105FormalHydrationTimeoutMs) || 60000),
    allowUnconfigured: !requireVerifiedStrategy,
  })
  const actionablePredictionTtlMs = Math.max(1000, Number(predictionTtlMs) || 120000)
  const captureProgressMaxAgeMs = Math.max(30000, Number(process.env.CAPTURE_PROGRESS_MAX_AGE_MS ?? 180000) || 180000)
  const expiredPredictionKeyLimit = Math.max(1, Number(maxExpiredPredictionKeys) || 10000)
  const resolvedMemberSessionTtlMs = Math.min(30 * 60 * 1000, Math.max(60000, Number(memberSessionTtlMs) || 30 * 60 * 1000))
  const resolvedAdminSessionTtlInput = Number(requestedAdminSessionTtlMs)
  const adminSessionTtlMs = Math.min(30 * 60 * 1000, Math.max(60000, Number.isFinite(resolvedAdminSessionTtlInput) ? resolvedAdminSessionTtlInput : 30 * 60 * 1000))
  let requestTablesBroadcast = () => {}
  let requestTablesRefresh = () => {}
  const tableUpdateWorkContext = new AsyncLocalStorage()
  let latestStreamScreenSignature = ''
  const state = createProxyState({
    inferSnapshotRounds: !strictRealCardRounds,
    onTablesUpdated: (tables) => {
      tablesReceivedAtMs = now()
      const streamScreenSignature = JSON.stringify(tables
        .map((table) => ({
          tableId: canonicalProductionTableId(table?.tableId),
          shoe: table?.shoe == null ? '' : String(table.shoe),
          round: Number(table?.round),
        }))
        .filter((screen) => screen.tableId && screen.shoe && Number.isSafeInteger(screen.round))
        .sort((left, right) => left.tableId.localeCompare(right.tableId)))
      let screenProgressChanged = streamScreenSignature !== latestStreamScreenSignature
      latestStreamScreenSignature = streamScreenSignature
      for (const table of tables) {
        const observedTableId = canonicalProductionTableId(table?.tableId)
        const observedShoe = table?.shoe == null ? '' : String(table.shoe)
        const observedRound = Number(table?.round)
        if (observedTableId && observedShoe && Number.isSafeInteger(observedRound)) {
          const accepted = acceptLifecycleScreenIdentity(latestObservedScreenGuardsByTable, {
            tableId: observedTableId,
            shoe: observedShoe,
            visibleRound: observedRound,
          })
          if (accepted) {
            screenProgressChanged = true
            latestObservedScreenByTable.set(observedTableId, { shoe: observedShoe, visibleRound: observedRound })
          }
        }
        if (!resolvedCaptureOutboxConsumerEnabled || tableUpdateWorkContext.getStore()?.suppressPredictionWork) continue
        const tableKey = `table:${String(table?.tableId ?? '')}`
        void serviceWorkScheduler.enqueueLatest(tableKey, async () => {
          await reconcileThenSavePendingPrediction(table)
        }).catch((error) => {
          state.setStatus({ persistenceStatus: 'error', persistenceError: error?.message ?? String(error) })
        })
      }
      if (screenProgressChanged) requestTablesRefresh()
    },
    onRoundEvent: async (round, table) => {
      if (!resolvedCaptureOutboxConsumerEnabled) return
      if (!supabaseClient?.configured && !supabaseClient?.persistRound) return
      if (!isVerifiedFinalRoundAction(round?.sourceAction)) return
      if (strictRealCardRounds && !hasRealCardCodes(round)) return
      const pendingKey = predictionTargetKey(round.tableId ?? table.tableId, round.shoe, round.round)
      let issuedCandidate
      let exactIssuanceReadPerformed = false
      try {
        if (preparingPredictionPromises.has(pendingKey)) await preparingPredictionPromises.get(pendingKey)
        issuedCandidate = pendingPredictions.get(pendingKey)
        if (!issuedCandidate && issuingPredictionPromises.has(pendingKey)) issuedCandidate = await issuingPredictionPromises.get(pendingKey)
        if (!issuedCandidate) {
          if (typeof supabaseClient?.readIssuedPrediction !== 'function') {
            throw new Error('exact issuance read capability is unavailable')
          }
          issuedCandidate = await supabaseClient.readIssuedPrediction({
            tableId: round.tableId ?? table.tableId,
            shoe: round.shoe,
            round: round.round,
            strategyVersion: ALL_MT_EQUAL_STRATEGY_VERSION,
          }, { priority: 'settlement' })
          exactIssuanceReadPerformed = true
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
      if (!precomputedPrediction && issuedCandidate) {
        throw new Error('durable prediction issuance identity mismatch')
      }
      if (!precomputedPrediction && exactIssuanceReadPerformed && issuedCandidate !== null) {
        throw new Error('exact issuance read must return null when no issuance exists')
      }
      if (!precomputedPrediction) {
        return {
          durable: true,
          disposition: 'no_issuance',
          tableId: String(round.tableId ?? table.tableId ?? ''),
          shoe: String(round.shoe ?? ''),
          round: Number(round.round),
        }
      }
      const existingSettlement = settlingPredictionPromises.get(pendingKey)
      if (existingSettlement) return existingSettlement
      const settlementPromise = (async () => {
        try {
          const persisted = await supabaseClient.persistRound?.(round, table, precomputedPrediction)
          const persistedPrediction = persisted?.prediction ?? persisted?.compactPrediction
          const nestedSettlementFinal = persistedPrediction?.prediction_features?.settlement_final
          const settlementFinal = nestedSettlementFinal === true
            || (nestedSettlementFinal == null && persistedPrediction?.settlement_final === true)
          if (!persisted || typeof persisted !== 'object' || !persistedPrediction || settlementFinal !== true) {
            throw new Error('durable settlement receipt is required before outbox acknowledgement')
          }
          const persistedIdentity = {
            predictionId: String(persistedPrediction.predictionId ?? persistedPrediction.prediction_id ?? persistedPrediction.id ?? ''),
            tableId: String(persistedPrediction.targetTableId ?? persistedPrediction.table_id ?? ''),
            shoe: String(persistedPrediction.targetShoe ?? persistedPrediction.shoe_no ?? ''),
            round: Number(persistedPrediction.targetRound ?? persistedPrediction.round_no),
            strategyVersion: String(persistedPrediction.strategyVersion ?? persistedPrediction.strategy_version ?? ''),
          }
          if (!persistedIdentity.predictionId
            || persistedIdentity.predictionId !== String(precomputedPrediction.predictionId ?? '')
            || persistedIdentity.tableId !== String(precomputedPrediction.targetTableId ?? round.tableId ?? table.tableId ?? '')
            || persistedIdentity.shoe !== String(precomputedPrediction.targetShoe ?? round.shoe ?? '')
            || persistedIdentity.round !== Number(precomputedPrediction.targetRound ?? round.round)
            || persistedIdentity.strategyVersion !== String(precomputedPrediction.strategyVersion ?? ALL_MT_EQUAL_STRATEGY_VERSION)) {
            throw new Error('durable settlement receipt identity mismatch')
          }
          if (persisted.prediction) {
            recentTablePerformance.record(persisted.prediction)
            v104Formal?.recordSettlement?.({
              ...persisted.prediction,
              predictionId: persisted.prediction.predictionId ?? persisted.prediction.prediction_id ?? persisted.prediction.id ?? precomputedPrediction.predictionId,
            })
            const resolvedAt = persisted.prediction.resolved_at ?? persisted.prediction.resolvedAt
            if (settlementFinal && resolvedAt && typeof resolvedDailyMemoryRollover?.observe === 'function') {
              void Promise.resolve()
                .then(() => resolvedDailyMemoryRollover.observe({ settlementFinal: true, resolvedAt }))
                .catch(() => {})
            }
          }
          pendingPredictions.delete(pendingKey)
          state.setStatus({ persistenceStatus: 'ok', persistenceError: null })
          return {
            durable: true,
            disposition: 'settled_final',
            tableId: persistedIdentity.tableId,
            shoe: persistedIdentity.shoe,
            round: persistedIdentity.round,
            predictionId: persistedIdentity.predictionId,
            strategyVersion: persistedIdentity.strategyVersion,
          }
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
  function setCaptureOutboxPhase(phase, attempt = null) {
    const diagnostics = { phase, startedAt: new Date(Number(now())).toISOString() }
    if (Number.isSafeInteger(attempt) && attempt > 0) diagnostics.attempt = attempt
    state.setStatus({ captureOutboxPhase: diagnostics })
  }

  function enterCaptureOutboxFatal(code) {
    if (captureOutboxFatal) return
    captureOutboxFatal = {
      phase: 'fatal',
      code: /^SHADOW_[A-Z0-9_]+$/.test(String(code ?? '')) ? String(code) : 'SHADOW_PROCESS_FATAL',
      startedAt: new Date(Number(now())).toISOString(),
    }
    outboxStopping = true
    if (outboxWakeTimer) clearTimeout(outboxWakeTimer)
    outboxWakeTimer = null
    outboxWakeAtMs = null
    resolveOutboxWake?.()
    resolveOutboxWake = null
    outboxWakePromise = null
    state.setStatus({
      captureOutboxPhase: captureOutboxFatal,
    })
    if (fatalHandlerCalled) return
    fatalHandlerCalled = true
    try { resolvedFatalHandler({ code: captureOutboxFatal.code, exitCode: 70 }) } catch {}
  }
  const captureSource = deployConfig.captureSource || chooseCaptureSource({ chromeCaptureUrl: captureUrl, cloudBrowserUrl, token })
  state.setStatus({ deployMode: deployConfig.deployMode, captureSource, captureMode: captureSource, cloudReady: true, statusText: describeCaptureStatus({ captureSource }) })
  const mtClient = createMtClient({ token, state })
  const chromeClient = createChromeCaptureClient({ url: captureUrl, state })
  const v100Formal = v100FormalRuntime ?? createV100FormalRuntime({
    enabled: resolveV100FormalEnabled(),
    writer: supabaseClient,
    identityConcurrency: resolveProductionConcurrency().formalIdentityConcurrency,
  })
  const cloudCaptureClient = createCloudCaptureClient({ url: cloudBrowserUrl, state, writer: supabaseClient, v100Formal, fetchImpl, pollMs: deployConfig.cloudCapturePollMs, adminKey: process.env.WORKER_ADMIN_KEY })

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

  function scheduleCaptureOutboxDrain(delayMs = 0) {
    if (!resolvedCaptureOutboxConsumerEnabled) return Promise.resolve()
    if (outboxStopping) return outboxWakePromise ?? Promise.resolve()
    outboxWakeGeneration += 1
    const normalizedDelayMs = Math.max(0, Number(delayMs) || 0)
    const targetWakeAtMs = Date.now() + normalizedDelayMs
    if (outboxWakeTimer) {
      if (Number.isFinite(outboxWakeAtMs) && outboxWakeAtMs <= targetWakeAtMs) return outboxWakePromise
      clearTimeout(outboxWakeTimer)
      outboxWakeTimer = null
      outboxWakeAtMs = null
      const resolveSupersededWake = resolveOutboxWake
      outboxWakePromise = null
      resolveOutboxWake = null
      resolveSupersededWake?.()
    }
    let resolveThisWake
    const thisWake = new Promise((resolve) => { resolveThisWake = resolve })
    outboxWakePromise = thisWake
    resolveOutboxWake = resolveThisWake
    outboxWakeAtMs = targetWakeAtMs
    outboxWakeTimer = setTimeout(() => {
      outboxWakeTimer = null
      outboxWakeAtMs = null
      if (outboxWakePromise === thisWake) outboxWakePromise = null
      if (resolveOutboxWake === resolveThisWake) resolveOutboxWake = null
      void drainCaptureOutbox()
        .catch(() => {})
        .finally(() => {
          resolveThisWake()
        })
    }, normalizedDelayMs)
    outboxWakeTimer.unref?.()
    return thisWake
  }

  function nextCaptureOutboxDrainRetryDelay() {
    outboxRetryCount += 1
    return Math.min(30000, resolvedOutboxBackoffMs * (2 ** Math.min(outboxRetryCount - 1, 5)))
  }

  function nextCaptureOutboxHealthRetryDelay() {
    outboxHealthRetryCount += 1
    return Math.min(30000, resolvedOutboxBackoffMs * (2 ** Math.min(outboxHealthRetryCount - 1, 5)))
  }

  function mergeClaimedCaptureWork(claimedRows) {
    const parsedRows = claimedRows.map((row) => {
      const sessionId = String(row?.session_id ?? '')
      const work = row?.payload?.work
      if (!work || typeof work !== 'object') throw new Error('capture outbox work payload is missing')
      return work.status && Array.isArray(work.tables) && Array.isArray(work.rounds)
        ? { sessionId: work.sessionId ?? sessionId, status: work.status, tables: work.tables, rounds: work.rounds }
        : parseCloudCapturePayload({ ...work, buildVersion: work.buildVersion ?? WORKER_PROTOCOL_BUILD_VERSION })
    })
    const latest = parsedRows.at(-1)
    const tablesByIdentity = new Map()
    for (const parsed of parsedRows) {
      for (const table of parsed.tables) {
        const identity = JSON.stringify([String(table?.tableId ?? ''), String(table?.shoe ?? '')])
        tablesByIdentity.set(identity, table)
      }
    }
    return {
      sessionId: latest?.sessionId ?? String(claimedRows[0]?.session_id ?? ''),
      status: latest?.status ?? {},
      tables: [...tablesByIdentity.values()],
      rounds: parsedRows.flatMap((parsed) => parsed.rounds),
    }
  }

  function drainCaptureOutbox() {
    if (!resolvedCaptureOutboxConsumerEnabled) return Promise.resolve()
    if (outboxDrainPromise) return outboxDrainPromise
    const drainWakeGeneration = outboxWakeGeneration
    let deferredWakeDelayMs = null
    const deferWake = (delayMs) => {
      const normalizedDelayMs = Math.max(0, Number(delayMs) || 0)
      deferredWakeDelayMs = deferredWakeDelayMs == null
        ? normalizedDelayMs
        : Math.min(deferredWakeDelayMs, normalizedDelayMs)
    }
    outboxDrainPromise = (async () => {
      if (outboxStopping || captureOutboxFatal || typeof supabaseClient?.claimCaptureOutbox !== 'function') return { processed: 0, failed: 0 }
      let processed = 0
      let failed = 0
      let shouldContinue = false
      let nextWakeDelayMs = null
      try {
        if (supabaseClient?.configured === true && typeof supabaseClient.getLatestCloudTableSnapshot === 'function') {
          setCaptureOutboxPhase('fresh_screen')
          const freshSnapshot = await readLatestCloudSnapshot({ requireFresh: true })
          const freshTables = Array.isArray(freshSnapshot?.tables) ? freshSnapshot.tables : []
          const freshTableIds = new Set(freshTables.map((table) => canonicalProductionTableId(table?.tableId)))
          const freshSnapshotTimestamp = freshSnapshot?.snapshot_at ?? freshSnapshot?.created_at ?? freshSnapshot?.updated_at
          const hasFreshSnapshotTimestamp = isFreshCloudTimestamp(freshSnapshotTimestamp, 120000)
          const hasCompleteProductionTables = hasFreshSnapshotTimestamp
            && freshTables.length === PRODUCTION_TABLE_IDS.length
            && freshTableIds.size === PRODUCTION_TABLE_IDS.length
            && PRODUCTION_TABLE_IDS.every((tableId) => freshTableIds.has(tableId))
          if (production && !hasCompleteProductionTables) {
            throw new Error('fresh complete cloud snapshot is required before capture outbox claim')
          }
          if (freshTables.length > 0) {
            const previousTableById = new Map(state.snapshot().tables.map((table) => [
              canonicalProductionTableId(table?.tableId), table,
            ]))
            const normalizedFreshRounds = new Map()
            for (const table of freshTables) {
              const tableId = canonicalProductionTableId(table?.tableId)
              const roundText = table?.round == null ? '' : String(table.round).trim()
              if (!/^\d+$/.test(roundText)) {
                throw new Error('fresh cloud table round must be a non-negative integer')
              }
              const round = Number(roundText)
              if (!Number.isSafeInteger(round)) {
                throw new Error('fresh cloud table round must be a non-negative integer')
              }
              const previous = previousTableById.get(tableId)
              if (previous && String(previous?.shoe ?? '') === String(table?.shoe ?? '')
                && Number.isSafeInteger(Number(previous?.round)) && round < Number(previous.round)) {
                throw new Error('fresh cloud table round regression is not claimable')
              }
              normalizedFreshRounds.set(tableId, round)
            }
            await tableUpdateWorkContext.run({ suppressPredictionWork: true }, async () => {
              state.setTables(mergeMonotonicTableScreens(state.snapshot().tables, freshTables))
            })
            if (production && isDurablePredictionIssuanceRequired()) {
              setCaptureOutboxPhase('fresh_prediction')
              const actionableFreshTables = freshTables.filter((table) => (
                Number(normalizedFreshRounds.get(canonicalProductionTableId(table?.tableId))) > 0
              ))
              const freshPredictionResults = await Promise.allSettled(actionableFreshTables.map((table) => (
                reconcileThenResolveLatestOutboxPrediction(table)
              )))
              const failedFreshPrediction = freshPredictionResults.find((result) => result.status === 'rejected')
              if (failedFreshPrediction) throw failedFreshPrediction.reason
              if (freshPredictionResults.some((result) => (
                result.status !== 'fulfilled'
                || !result.value
                || result.value.strategyVersion !== ALL_MT_EQUAL_STRATEGY_VERSION
                || !isLatestObservedPredictionTarget(result.value)
              ))) {
                throw new Error('latest actionable cloud tables require durable v105 predictions before capture outbox claim')
              }
            }
          }
        } else if (production) {
          throw new Error('fresh cloud snapshot reader is required before capture outbox claim')
        }
        setCaptureOutboxPhase('claim')
        const batchEnabled = typeof supabaseClient?.completeCaptureOutboxBatch === 'function'
          && typeof supabaseClient?.failCaptureOutboxBatch === 'function'
        const rows = await supabaseClient.claimCaptureOutbox({ limit: batchEnabled ? resolvedCaptureOutboxBatchLimit : 1 })
        outboxRetryCount = 0
        if (Array.isArray(rows) && rows.length > 0) {
          const claimedRows = batchEnabled ? rows : [rows[0]]
          const claims = claimedRows.map((row) => ({
            sessionId: String(row?.session_id ?? ''),
            sequence: Number(row?.sequence),
            claimToken: String(row?.claim_token ?? ''),
            attempt: Number(row?.attempts),
          }))
          const sessionId = claims[0].sessionId
          if (claims.some((claim) => claim.sessionId !== sessionId)) throw new Error('capture outbox batch crossed session boundary')
          if (claims.some((claim, index) => index > 0 && claim.sequence <= claims[index - 1].sequence)) {
            throw new Error('capture outbox batch sequence order is invalid')
          }
          const firstSequence = claims[0].sequence
          const lastSequence = claims.at(-1).sequence
          const attempt = Math.max(...claims.map((claim) => claim.attempt))
          const leaseWorkDeadlineMs = resolveCaptureOutboxLeaseDeadlineMs(
            resolvedOutboxWorkDeadlineMs,
            claims.length,
          )
          const leaseDeadline = createLeaseDeadline(
            leaseWorkDeadlineMs,
            `capture outbox work deadline exceeded for ${sessionId}:${firstSequence}-${lastSequence}`,
          )
          const runLeasePhase = async (phase, operation) => {
            leaseDeadline.assertActive()
            setCaptureOutboxPhase(phase, attempt)
            const underlying = Promise.resolve().then(operation)
            try {
              return await leaseDeadline.race(underlying)
            } catch (error) {
              setCaptureOutboxPhase(`${phase}_settling`, attempt)
              await Promise.allSettled([underlying])
              throw error
            }
          }
          const completeClaims = () => (batchEnabled
            ? supabaseClient.completeCaptureOutboxBatch({ claims })
            : supabaseClient.completeCaptureOutbox(claims[0]))
          const failClaims = (error) => (batchEnabled
            ? supabaseClient.failCaptureOutboxBatch({ claims, error })
            : supabaseClient.failCaptureOutbox({ ...claims[0], error }))
          try {
            const parsed = mergeClaimedCaptureWork(claimedRows)
            if (parsed.rounds.length === 0) {
              await runLeasePhase('heartbeat_complete_ack', completeClaims)
              processed += claimedRows.length
            } else {
              let publishedTables
              let settlementReceipts
              await tableUpdateWorkContext.run({ suppressPredictionWork: true }, async () => {
                const applied = await runLeasePhase('formal', () => (
                  applyCloudCapturePayload({
                    parsed, state, writer: supabaseClient, v100Formal,
                    persistAncillary: false,
                    publishSnapshot: false,
                    onDurablePhase: ({ phase }) => state.setStatus({
                      captureOutboxPhase: {
                        phase: `formal_${phase}`,
                        startedAt: new Date(Number(now())).toISOString(),
                      },
                    }),
                  })
                ))
                leaseDeadline.assertActive()
                publishedTables = Array.isArray(applied?.tables) ? applied.tables : parsed.tables
                settlementReceipts = Array.isArray(applied?.settlementReceipts) ? applied.settlementReceipts : []
                state.setStatus(parsed.status)
                state.setTables(mergeMonotonicTableScreens(state.snapshot().tables, publishedTables))
              })
              const finalizedIdentities = new Set(parsed.rounds.map((round) => JSON.stringify([
                String(round?.tableId ?? ''),
                String(round?.shoe ?? ''),
              ])))
              const publishedTableByIdentity = new Map(publishedTables.map((table) => [JSON.stringify([
                String(table?.tableId ?? ''),
                String(table?.shoe ?? ''),
              ]), table]))
              const currentPublishedTableByTableId = new Map()
              for (const table of publishedTables) {
                currentPublishedTableByTableId.set(String(table?.tableId ?? ''), table)
              }
              const parsePositiveIntegerShoe = (value) => {
                const text = String(value ?? '').trim()
                if (!/^\d+$/.test(text)) return null
                const number = Number(text)
                return Number.isSafeInteger(number) && number > 0 ? number : null
              }
              const missingFinalizedIdentities = []
              for (const identity of finalizedIdentities) {
                const [tableId, finalizedShoe] = JSON.parse(identity)
                const finalizedShoeNumber = parsePositiveIntegerShoe(finalizedShoe)
                if (!tableId || finalizedShoeNumber == null) {
                  missingFinalizedIdentities.push(identity)
                  continue
                }
                if (publishedTableByIdentity.has(identity)) continue
                const advancedTable = currentPublishedTableByTableId.get(tableId)
                const advancedShoeNumber = parsePositiveIntegerShoe(advancedTable?.shoe)
                if (advancedShoeNumber == null || advancedShoeNumber <= finalizedShoeNumber) {
                  missingFinalizedIdentities.push(identity)
                }
              }
              if (missingFinalizedIdentities.length > 0) {
                throw new Error('finalized identity missing from published tables before outbox acknowledgement')
              }
              const receiptByRoundIdentity = new Map(settlementReceipts.map((receipt) => [JSON.stringify([
                String(receipt?.tableId ?? ''),
                String(receipt?.shoe ?? ''),
                Number(receipt?.round),
              ]), receipt]))
              const missingSettlementReceipts = parsed.rounds.filter((round) => {
                const receipt = receiptByRoundIdentity.get(JSON.stringify([
                  String(round?.tableId ?? ''),
                  String(round?.shoe ?? ''),
                  Number(round?.round),
                ]))
                return receipt?.durable !== true || !['no_issuance', 'settled_final'].includes(receipt?.disposition)
              })
              if (missingSettlementReceipts.length > 0) {
                throw new Error('durable settlement receipt is required before outbox acknowledgement')
              }
              const liveTableByTableId = new Map(state.snapshot().tables.map((table) => [
                String(table?.tableId ?? ''), table,
              ]))
              const predictionTables = [...currentPublishedTableByTableId.values()]
                .filter((table) => finalizedIdentities.has(JSON.stringify([
                  String(table?.tableId ?? ''),
                  String(table?.shoe ?? ''),
                ])))
                .map((table) => {
                  const liveTable = liveTableByTableId.get(String(table?.tableId ?? ''))
                  return liveTable
                    && String(liveTable?.shoe ?? '') === String(table?.shoe ?? '')
                    && Number(liveTable?.round) >= Number(table?.round)
                    ? liveTable
                    : table
                })
              const nextPredictions = await runLeasePhase('formal_prediction', async () => {
                const predictionResults = await Promise.allSettled(predictionTables.map((table) => (
                  reconcileThenResolveLatestOutboxPrediction(table)
                )))
                const failedPrediction = predictionResults.find((result) => result.status === 'rejected')
                if (failedPrediction) throw failedPrediction.reason
                return predictionResults.map((result) => result.value)
              })
              const missingLatestPrediction = nextPredictions.some((prediction) => (
                !prediction || !isLatestObservedPredictionTarget(prediction)
              ))
              if (missingLatestPrediction) {
                throw new Error('prediction issuance failed before outbox acknowledgement')
              }
              leaseDeadline.assertActive()
              await runLeasePhase('complete_ack', completeClaims)
              processed += claimedRows.length
            }
          } catch (error) {
            failed += claimedRows.length
            state.setStatus({ persistenceStatus: 'error', persistenceError: error?.message ?? String(error) })
            setCaptureOutboxPhase('failure_ack', attempt)
            const failureAckKey = claims.map((claim) => (
              `${claim.sessionId}\u0000${claim.sequence}\u0000${claim.claimToken}\u0000${claim.attempt}`
            )).join('\u0001')
            if (!attemptedFailureAcks.has(failureAckKey)) {
              attemptedFailureAcks.add(failureAckKey)
              if (attemptedFailureAcks.size > 10000) attemptedFailureAcks.delete(attemptedFailureAcks.values().next().value)
              await withDeadline(
                failClaims(error?.message ?? String(error)),
                resolvedOutboxWorkDeadlineMs,
                `capture outbox failure acknowledgement deadline exceeded for ${sessionId}:${firstSequence}-${lastSequence}`,
              )
            }
          } finally {
            leaseDeadline.close()
          }
          shouldContinue = true
          nextWakeDelayMs = 0
          await new Promise((resolve) => setImmediate(resolve))
        }
      } catch (error) {
        deferWake(nextCaptureOutboxDrainRetryDelay())
        throw error
      }
      if (shouldContinue) deferWake(nextWakeDelayMs ?? 0)
      if (typeof supabaseClient?.getCaptureOutboxHealth === 'function') {
        try {
          setCaptureOutboxPhase('health')
          const captureOutbox = await supabaseClient.getCaptureOutboxHealth()
          outboxHealthRetryCount = 0
          state.setStatus({ captureOutbox })
          const nextWakeAt = Date.parse(captureOutbox?.next_wakeup_at ?? '')
          const unfinished = Number(captureOutbox?.pending) + Number(captureOutbox?.error) + Number(captureOutbox?.processing)
          if (!outboxStopping && unfinished > 0 && Number.isFinite(nextWakeAt)) {
            deferWake(Math.max(0, nextWakeAt - Date.now() + 5))
          }
        } catch (error) {
          state.setStatus({ persistenceStatus: 'error', persistenceError: error?.message ?? String(error) })
          deferWake(nextCaptureOutboxHealthRetryDelay())
        }
      }
      return { processed, failed }
    })().finally(() => {
      if (!captureOutboxFatal) setCaptureOutboxPhase('idle')
      const freshWakeRequested = outboxWakeGeneration !== drainWakeGeneration
      outboxDrainPromise = null
      const freshWakeDelayMs = freshWakeRequested ? resolvedOutboxCoalesceMs : null
      const idlePollDelayMs = resolvedCaptureOutboxConsumerEnabled && resolvedCaptureOutboxPollMs > 0
        ? resolvedCaptureOutboxPollMs
        : null
      const nextDelayMs = [deferredWakeDelayMs, freshWakeDelayMs, idlePollDelayMs]
        .filter((value) => value != null)
        .reduce((minimum, value) => minimum == null ? value : Math.min(minimum, value), null)
      if (!outboxStopping && !captureOutboxFatal && nextDelayMs != null) scheduleCaptureOutboxDrain(nextDelayMs)
    })
    return outboxDrainPromise
  }

  async function waitForCaptureOutboxIdle() {
    while (outboxDrainPromise || outboxWakePromise) {
      if (outboxDrainPromise) await outboxDrainPromise.catch(() => {})
      else if (outboxWakePromise) await outboxWakePromise
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
        const session = requireSession ? await (requireSuper ? requireSuperAdminSession(payload, requestUrl, headers) : requireAdminSession(payload, requestUrl, headers)) : null
        const scopedPayload = session ? { ...payload, adminAccount: session.adminAccount } : payload
        return jsonResponse(200, await action(scopedPayload, session), frontendOrigin)
      } catch (error) {
        return jsonResponse(error?.statusCode ?? 400, { ok: false, error: error?.message ?? String(error) }, frontendOrigin)
      }
    }

    if (pathname === '/health') {
      const cloudStatus = await readCloudSnapshotStatus()
      const nextStatus = {
        ...state.snapshot().status,
        ...cloudStatus,
      }
      const health = buildServiceHealth(nextStatus)
      return jsonResponse(health.degraded ? 503 : 200, { ok: !health.degraded, service: SERVICE, version: VERSION, buildVersion: BUILD_VERSION, deployMode: deployConfig.deployMode, ...health }, frontendOrigin)
    }
    if (pathname === '/api/status') {
      const cloudStatus = await readCloudSnapshotStatus()
      const nextStatus = {
        ...state.snapshot().status,
        ...cloudStatus,
      }
      const health = buildServiceHealth(nextStatus)
      return jsonResponse(200, { ...nextStatus, version: VERSION, buildVersion: BUILD_VERSION, deployMode: deployConfig.deployMode, ...health, statusText: cloudStatus?.statusText ?? describeCaptureStatus(nextStatus) }, frontendOrigin)
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
        const usesDurableOutbox = typeof supabaseClient?.persistCaptureEnvelope === 'function'
        const validatedRoundKeys = validateIngestEnvelope(envelope, now(), {
          allowAgedFencedEnvelope: usesDurableOutbox && (requireFencedIngest || envelope.source != null),
        })
        let fencedSource = null
        if (requireFencedIngest || envelope.source != null) {
          try {
            fencedSource = normalizeSource(envelope.source, { exact: true })
            const snapshotSource = normalizeSource(envelope.snapshot?.source, { exact: true })
            if (JSON.stringify(snapshotSource) !== JSON.stringify(fencedSource)) throw new Error('snapshot_source_mismatch')
            ingestSourceFence.validateEvents(fencedSource, envelope.snapshot?.rounds ?? [])
            if (!usesDurableOutbox) ingestSourceFence.validateCurrent?.(fencedSource)
          } catch (error) {
            error.statusCode = 409
            throw error
          }
        }
        const sessionId = String(envelope.snapshot.sessionId ?? envelope.snapshot.session_id ?? 'cloud-browser')
        const ingestOperation = withIngestSessionLock(sessionId, async () => {
          if (!usesDurableOutbox) {
            const previous = legacyIngestSequences.get(sessionId)
            if (previous != null && envelope.sequence <= previous.sequence) {
              if (envelope.sequence === previous.sequence) {
                const accepted = new Set(previous.ack?.acceptedRoundKeys ?? [])
                if (!validatedRoundKeys.every((roundKey) => accepted.has(roundKey))) {
                  return jsonResponse(409, { ok: false, accepted: false, error: 'sequence_payload_conflict' }, frontendOrigin)
                }
                return jsonResponse(200, {
                  ...previous.ack, duplicate: true, sequence: envelope.sequence,
                  acceptedRoundKeys: validatedRoundKeys,
                }, frontendOrigin)
              }
              return jsonResponse(200, { ...previous.ack, duplicate: true, sequence: envelope.sequence }, frontendOrigin)
            }
          }
          const stableCapturedAt = new Date(Number(envelope.captureTimestamp ?? envelope.timestamp)).toISOString()
          const parsed = parseCloudCapturePayload(envelope.snapshot, stableCapturedAt)
          let captureResult = null
          let duplicateCapture = false
          try {
            assertDurableIngestWriter(supabaseClient, parsed.rounds.length)
            if (production && typeof supabaseClient?.persistCaptureEnvelope !== 'function') {
              throw new Error('durable capture outbox writer is required')
            }
            if (typeof supabaseClient?.persistCaptureEnvelope === 'function') {
              const rawOutboxStartedAt = Date.now()
              const rawAcknowledgement = await supabaseClient.persistCaptureEnvelope({
                sessionId,
                sequence: envelope.sequence,
                roundKeys: validatedRoundKeys,
                tables: parsed.tables,
                rounds: parsed.rounds,
                status: parsed.status,
                capturedAt: stableCapturedAt,
                ...(fencedSource ? { source: fencedSource } : {}),
              })
              const accepted = Array.isArray(rawAcknowledgement?.acceptedRoundKeys)
                ? rawAcknowledgement.acceptedRoundKeys.map(String)
                : []
              if (accepted.length !== validatedRoundKeys.length
                  || validatedRoundKeys.some((roundKey, index) => accepted[index] !== roundKey)) {
                throw new Error('durable capture outbox acknowledgement mismatch')
              }
              if (fencedSource) {
                try { await ingestSourceFence.observeCommitted?.(fencedSource) } catch {}
              }
              duplicateCapture = rawAcknowledgement?.duplicate === true
              if (!duplicateCapture) {
                state.setStatus({
                  ...parsed.status,
                  captureSequence: Number(envelope.sequence),
                  captureTimestamp: stableCapturedAt,
                })
                state.setTables(parsed.tables)
              }
              captureResult = { durableTimings: { rawOutboxMs: Math.max(0, Date.now() - rawOutboxStartedAt) } }
              if (!duplicateCapture) {
                void scheduleCaptureOutboxDrain(resolvedOutboxCoalesceMs).catch((error) => {
                  state.setStatus({ persistenceStatus: 'error', persistenceError: error?.message ?? String(error) })
                })
              }
            } else {
              captureResult = await applyCloudCapturePayload({ parsed, state, writer: supabaseClient, v100Formal })
              if (fencedSource) await ingestSourceFence.validateAndAdvance?.(fencedSource)
            }
          } catch (error) {
            if (/capture identity conflict|sequence_payload_conflict/i.test(error?.message ?? '')) {
              return jsonResponse(409, { ok: false, accepted: false, error: 'sequence_payload_conflict' }, frontendOrigin)
            }
            const sourceFenceError = classifySourceFenceError(error)
            if (sourceFenceError) {
              return jsonResponse(409, { ok: false, accepted: false, error: sourceFenceError }, frontendOrigin)
            }
            const durableError = new Error(error?.message ?? String(error))
            durableError.statusCode = 503
            durableError.durableFailure = true
            throw durableError
          }
          state.setStatus({ durableTimings: captureResult?.durableTimings ?? null })
          const ack = {
            ok: true,
            accepted: true,
            duplicate: duplicateCapture,
            sessionId,
            sequence: envelope.sequence,
            acceptedRoundKeys: validatedRoundKeys,
            ...(fencedSource ? { source: fencedSource } : {}),
          }
          if (!usesDurableOutbox) legacyIngestSequences.set(sessionId, { sequence: envelope.sequence, ack })
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
      if (!resolvedCaptureOutboxConsumerEnabled) return jsonResponse(409, { ok: false, error: 'capture_outbox_consumer_disabled' }, frontendOrigin)
      const parsed = await cloudCaptureClient.tick()
      return jsonResponse(200, { ok: Boolean(parsed), running: cloudCaptureClient.isRunning(), status: state.snapshot().status }, frontendOrigin)
    }
    if (method === 'POST' && pathname === '/api/cloud-capture/start') {
      const controlError = requireControlAccess(headers)
      if (controlError) return controlError
      if (!resolvedCaptureOutboxConsumerEnabled) return jsonResponse(409, { ok: false, error: 'capture_outbox_consumer_disabled' }, frontendOrigin)
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
        const session = await requireSuperAdminSession(payload, requestUrl, headers)
        const result = await onlineCoreClient.updateAppSetting?.({ ...payload, updatedBy: session.adminAccount })
        return jsonResponse(200, { ok: true, result }, frontendOrigin)
      } catch (error) {
        return jsonResponse(error?.statusCode ?? 400, { ok: false, error: error?.message ?? String(error) }, frontendOrigin)
      }
    }
    if (method === 'POST' && pathname === '/api/online-core/feature-flags') {
      try {
        const payload = parseJsonBody(rawBody)
        const session = await requireSuperAdminSession(payload, requestUrl, headers)
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
        const session = await requireAdminSession({}, requestUrl, headers)
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
    if (production && !adminSessionKey) {
      const error = new Error('admin session secret is not configured securely')
      error.statusCode = 503
      throw error
    }
    const adminAccount = resolveAdminAccount(loginResult, fallbackAccount)
    const expiresAtMs = now() + adminSessionTtlMs
    const expiresAt = new Date(expiresAtMs).toISOString()
    const session = { adminAccount, role: resolveAdminRole(loginResult), expiresAtMs }
    const token = adminSessionKey
      ? sealAdminSession(session, adminSessionKey)
      : crypto.randomBytes(32).toString('base64url')
    adminSessions.set(token, session)
    return { token, expiresAt }
  }

  function issueMemberSession(loginResult = {}) {
    const expiresAtMs = now() + resolvedMemberSessionTtlMs
    for (const [token, session] of memberSessions) {
      if (session.expiresAtMs <= now()) memberSessions.delete(token)
    }
    const session = {
      memberAccount: loginResult.memberAccount,
      licenseId: loginResult.license?.id ?? null,
      authorizationVersion: loginResult.license?.updated_at ?? loginResult.license?.updatedAt ?? null,
      expiresAtMs,
    }
    const memberSessionToken = memberSessionKey
      ? sealMemberSession(session, memberSessionKey)
      : crypto.randomBytes(32).toString('base64url')
    memberSessions.set(memberSessionToken, session)
    return { memberSessionToken, sessionExpiresAt: new Date(expiresAtMs).toISOString() }
  }

  function resolveMemberSession(token) {
    const normalizedToken = String(token ?? '')
    const rejectedUntilMs = memberSessionRejectedUntil.get(normalizedToken)
    if (rejectedUntilMs != null) {
      if (rejectedUntilMs > now()) return null
      memberSessionRejectedUntil.delete(normalizedToken)
    }
    let session = memberSessions.get(normalizedToken) ?? null
    if (!session && memberSessionKey) {
      session = openMemberSession(normalizedToken, memberSessionKey)
      if (session) memberSessions.set(normalizedToken, session)
    }
    return session
  }

  async function isMemberSessionAuthorized(headers = {}) {
    if (!memberAuthRequired) return true
    const token = extractBearerToken(headers.authorization)
    const session = token ? resolveMemberSession(token) : null
    if (!session || session.expiresAtMs <= now()) {
      if (token) {
        memberSessions.delete(String(token))
        memberSessionValidationCache.delete(String(token))
      }
      return false
    }
    const normalizedToken = String(token)
    const cached = memberSessionValidationCache.get(normalizedToken)
    if (cached && cached.validUntilMs > now()) return cached.ok === true
    if (cached) memberSessionValidationCache.delete(normalizedToken)

    let validationPromise = memberSessionValidationInFlight.get(normalizedToken)
    if (!validationPromise) {
      validationPromise = (async () => {
        try {
          if (typeof licenseAdminClient.validateMemberSession !== 'function') return false
          const validation = await licenseAdminClient.validateMemberSession({
            memberAccount: session.memberAccount,
            licenseId: session.licenseId,
            authorizationVersion: session.authorizationVersion,
          })
          return validation?.ok === true
        } catch {
          return false
        }
      })().then((ok) => {
        const authorized = ok && session.expiresAtMs > now()
        if (authorized && resolvedMemberSessionValidationTtlMs > 0) {
          memberSessionValidationCache.set(normalizedToken, {
            ok: true,
            validUntilMs: Math.min(session.expiresAtMs, now() + resolvedMemberSessionValidationTtlMs),
          })
        }
        if (!authorized) {
          memberSessions.delete(normalizedToken)
          memberSessionValidationCache.delete(normalizedToken)
          if (session.expiresAtMs > now()) memberSessionRejectedUntil.set(normalizedToken, session.expiresAtMs)
        }
        return authorized
      }).finally(() => {
        memberSessionValidationInFlight.delete(normalizedToken)
      })
      memberSessionValidationInFlight.set(normalizedToken, validationPromise)
    }
    return validationPromise
  }

  async function requireAdminSession(payload = {}, requestUrl, headers = {}) {
    const token = payload.adminSessionToken
      ?? headers['x-admin-session-token']
      ?? headers['authorization']?.replace(/^Bearer\s+/i, '')
    const normalizedToken = token ? String(token) : ''
    let session = normalizedToken ? adminSessions.get(normalizedToken) : null
    if (!session && normalizedToken && adminSessionKey) {
      session = openAdminSession(normalizedToken, adminSessionKey)
      if (session) adminSessions.set(normalizedToken, session)
    }
    if (!session || session.expiresAtMs <= now()) {
      if (normalizedToken) adminSessions.delete(normalizedToken)
      throwAdminSessionError('admin session is required', 401)
    }

    if (typeof licenseAdminClient?.validateAgentLogin !== 'function') throwAdminSessionError('admin authorization validation is unavailable', 503)
    let validation
    try {
      validation = await licenseAdminClient.validateAgentLogin({ agentAccount: session.adminAccount })
    } catch {
      throwAdminSessionError('admin authorization validation is temporarily unavailable', 503)
    }
    if (session.expiresAtMs <= now()) {
      adminSessions.delete(normalizedToken)
      throwAdminSessionError('admin session is required', 401)
    }
    const currentAccount = resolveAdminAccount(validation)
    const currentRole = resolveAdminRole(validation)
    const authorized = validation?.ok === true
      && String(currentAccount).toLowerCase() === String(session.adminAccount).toLowerCase()
      && String(currentRole).toLowerCase() === String(session.role).toLowerCase()
    if (!authorized) {
      adminSessions.delete(normalizedToken)
      throwAdminSessionError('admin session is required', 401)
    }
    return session
  }

  async function requireSuperAdminSession(payload = {}, requestUrl, headers = {}) {
    const session = await requireAdminSession(payload, requestUrl, headers)
    if (String(session.adminAccount).toLowerCase() === 'dv1788' || ['total','super'].includes(String(session.role ?? '').toLowerCase())) return session
    const error = new Error('super admin session is required')
    error.statusCode = 403
    throw error
  }

  function throwAdminSessionError(message, statusCode) {
    const error = new Error(message)
    error.statusCode = statusCode
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
    const ageMs = Date.now() - timestamp
    return ageMs >= -30000 && ageMs <= Math.max(1000, Number(maxAgeMs) || 120000)
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
    const localSnapshot = state.snapshot()
    const localTables = localSnapshot.tables
    const localTablesAreFresh = localTables.length > 0
      && tablesReceivedAtMs > 0
      && now() - tablesReceivedAtMs <= CLOUD_SNAPSHOT_MAX_AGE_MS
    if (localTablesAreFresh) {
      const actionable = now() - tablesReceivedAtMs <= actionablePredictionTtlMs
      return includePrediction ? Promise.all(localTables.map((table) => withLivePrediction(table, actionable))) : localTables
    }
    const cloudSnapshot = await readLatestCloudSnapshot({ requireFresh: true })
    if (localTables.length === 0 && tablesReceivedAtMs > 0) {
      const localSessionId = String(localSnapshot.status?.captureSessionId ?? '')
      const durableSessionId = String(cloudSnapshot?.session_id ?? '')
      const localSequence = Number(localSnapshot.status?.captureSequence)
      const durableSequence = Number(cloudSnapshot?.metadata?.sequence)
      const sameSequencedSession = localSessionId && durableSessionId === localSessionId
        && Number.isSafeInteger(localSequence) && Number.isSafeInteger(durableSequence)
      if (sameSequencedSession) {
        if (durableSequence <= localSequence) return []
      } else {
        const localSourceAtMs = Date.parse(localSnapshot.status?.captureTimestamp
          ?? localSnapshot.status?.lastMessageAt
          ?? new Date(tablesReceivedAtMs).toISOString())
        const durableSnapshotAtMs = Date.parse(cloudSnapshot?.snapshot_at ?? cloudSnapshot?.updated_at ?? cloudSnapshot?.created_at ?? '')
        if (!Number.isFinite(durableSnapshotAtMs) || durableSnapshotAtMs <= localSourceAtMs) return []
      }
    }
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

  function isLatestObservedPredictionTarget(prediction) {
    const tableId = canonicalProductionTableId(prediction?.targetTableId)
    const latest = latestObservedScreenByTable.get(tableId)
    if (!latest) return true
    const expectedVisibleRound = Number(prediction?.targetRound) - 1
    return latest.shoe === String(prediction?.targetShoe ?? '')
      && latest.visibleRound === expectedVisibleRound
  }

  function isLatestObservedTableScreen(table) {
    const tableId = canonicalProductionTableId(table?.tableId)
    const latest = latestObservedScreenByTable.get(tableId)
    if (!latest) return true
    return latest.shoe === String(table?.shoe ?? '')
      && latest.visibleRound === Number(table?.round)
  }

  async function reconcileLatestObservedPredictionScreen(prediction) {
    const tableId = canonicalProductionTableId(prediction?.targetTableId)
    const latest = latestObservedScreenByTable.get(tableId)
    if (!latest || typeof supabaseClient?.reconcilePredictionLifecycle !== 'function') return
    await supabaseClient.reconcilePredictionLifecycle({
      source: 'ofalive99',
      tableId,
      currentShoe: latest.shoe,
      currentVisibleRound: latest.visibleRound,
    })
  }

  async function reconcileThenSavePendingPrediction(table, { failOnReconciliationError = false } = {}) {
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
      const guard = lifecycleGuardsByTable.get(tableId)
      const exactDuplicate = guard?.latestShoe === shoe && guard?.latestRound === visibleRound
      const accepted = acceptLifecycleScreenIdentity(lifecycleGuardsByTable, { tableId, shoe, visibleRound })
      if (!accepted && !exactDuplicate) return
      if (accepted || (failOnReconciliationError && exactDuplicate)) {
        try {
          await supabaseClient.reconcilePredictionLifecycle({
            source: 'ofalive99',
            tableId,
            currentShoe: shoe,
            currentVisibleRound: visibleRound,
          })
        } catch (error) {
          if (failOnReconciliationError) {
            state.setStatus({ persistenceStatus: 'error', persistenceError: error?.message ?? String(error) })
            throw error
          }
          reconciliationError = error
        }
      }
    }
    if (canReconcile) {
      const latestObserved = latestObservedScreenByTable.get(tableId)
      if (latestObserved?.shoe !== shoe || latestObserved?.visibleRound !== visibleRound) return
    }
    const preparedPrediction = await savePendingPrediction(table)
    if (reconciliationError) {
      state.setStatus({ persistenceStatus: 'error', persistenceError: reconciliationError?.message ?? String(reconciliationError) })
      return preparedPrediction
    }
    if (canReconcile) requestDurablePredictionBroadcast(preparedPrediction)
    return preparedPrediction
  }

  async function reconcileThenResolveOutboxPrediction(table) {
    const prepared = await reconcileThenSavePendingPrediction(table, { failOnReconciliationError: true })
    if (prepared) return prepared
    const currentRound = Number(table?.round)
    if (!table?.tableId || table?.shoe == null || !Number.isSafeInteger(currentRound)) return null
    const targetRound = currentRound + 1
    const key = predictionTargetKey(table.tableId, table.shoe, targetRound)
    return startIssuedPredictionRead(table, targetRound, key, isDurablePredictionIssuanceRequired())
  }

  async function reconcileThenResolveLatestOutboxPrediction(table) {
    let candidateTable = table
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const tableId = canonicalProductionTableId(candidateTable?.tableId)
      const latestBefore = latestObservedScreenByTable.get(tableId)
      if (latestBefore
        && (latestBefore.shoe !== String(candidateTable?.shoe ?? '')
          || latestBefore.visibleRound !== Number(candidateTable?.round))) {
        const latestTable = state.snapshot().tables.find((item) => (
          canonicalProductionTableId(item?.tableId) === tableId
          && String(item?.shoe ?? '') === latestBefore.shoe
          && Number(item?.round) === latestBefore.visibleRound
        ))
        if (!latestTable) return null
        candidateTable = latestTable
      }
      const prediction = await reconcileThenResolveOutboxPrediction(candidateTable)
      if (prediction && isLatestObservedPredictionTarget(prediction)) return prediction
      const latest = latestObservedScreenByTable.get(tableId)
      if (!latest) return prediction
      const latestTable = state.snapshot().tables.find((item) => (
        canonicalProductionTableId(item?.tableId) === tableId
        && String(item?.shoe ?? '') === latest.shoe
        && Number(item?.round) === latest.visibleRound
      ))
      if (!latestTable) return null
      if (String(candidateTable?.shoe ?? '') === latest.shoe
        && Number(candidateTable?.round) === latest.visibleRound) return prediction
      candidateTable = latestTable
    }
    return null
  }


  function requestDurablePredictionBroadcast(prediction) {
    const predictionId = String(prediction?.predictionId ?? '')
    if (!predictionId || !prediction?.issuedAt || immediateBroadcastPredictionIds.has(predictionId)) return
    immediateBroadcastPredictionIds.add(predictionId)
    while (immediateBroadcastPredictionIds.size > 10000) {
      immediateBroadcastPredictionIds.delete(immediateBroadcastPredictionIds.values().next().value)
    }
    requestTablesBroadcast(true)
  }

  function savePendingPrediction(table) {
    const currentRound = Number(table?.round)
    if (!table?.tableId || table?.shoe == null || !Number.isSafeInteger(currentRound)) return Promise.resolve(null)
    const expectedKey = predictionTargetKey(table.tableId, table.shoe, currentRound + 1)
    const existing = pendingPredictions.get(expectedKey)
    if (existing && !isPendingPredictionExpired(existing)) return Promise.resolve(existing)
    if (Number(issuanceRetryAt.get(expectedKey) ?? 0) > now()) return Promise.resolve(null)
    issuanceRetryAt.delete(expectedKey)
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
    if (!isLatestObservedPredictionTarget(generated)) return null
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
      .then(async (issued) => {
        if (!isValidPendingPrediction(issued) || !issued.predictionId || !issued.issuedAt
          || predictionTargetKey(issued.targetTableId, issued.targetShoe, issued.targetRound) !== key
          || issued.strategyVersion !== generated.strategyVersion) {
          throw new Error('durable prediction issuance acknowledgement failed')
        }
        if (!isLatestObservedPredictionTarget(issued)) {
          await reconcileLatestObservedPredictionScreen(issued)
          return null
        }
        issuanceRetryAt.delete(key)
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
        issuanceRetryAt.delete(key)
        issuanceRetryAt.set(key, now() + resolvedPredictionIssuanceRetryMs)
        while (issuanceRetryAt.size > 1000) issuanceRetryAt.delete(issuanceRetryAt.keys().next().value)
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
    let readOperation
    try {
      readOperation = Promise.resolve(supabaseClient.readIssuedPrediction({
        tableId: table.tableId,
        shoe: table.shoe,
        round: targetRound,
        strategyVersion: ALL_MT_EQUAL_STRATEGY_VERSION,
      }))
    } catch (error) {
      readOperation = Promise.reject(error)
    }
    const read = readOperation
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

    if (resolvedCaptureOutboxConsumerEnabled) {
      await Promise.race([
        savePendingPrediction(table),
        new Promise((resolve) => setTimeout(() => resolve(null), 25)),
      ])
    }
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
      const issuedPredictionRead = startIssuedPredictionRead(table, targetRound, key, durableIssuanceRequired)
      exact = await Promise.race([
        issuedPredictionRead,
        new Promise((resolve) => setTimeout(() => resolve(null), 50)),
      ])
      if (!exact) {
        void issuedPredictionRead.then((readBack) => requestDurablePredictionBroadcast(readBack))
      }
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
    return now() - Number(prediction?.createdAtMs ?? 0) >= actionablePredictionTtlMs
  }

  function rememberExpiredPredictionKey(key) {
    expiredPredictionKeys.delete(key)
    expiredPredictionKeys.add(key)
    while (expiredPredictionKeys.size > expiredPredictionKeyLimit) {
      expiredPredictionKeys.delete(expiredPredictionKeys.values().next().value)
    }
  }

  function buildServiceHealth(statusOverride = null) {
    const runtimeStatus = typeof supabaseClient?.getRuntimeStatus === 'function' ? supabaseClient.getRuntimeStatus() : null
    const runtimeUnavailable = requireVerifiedStrategy && (
      supabaseClient?.configured !== true
      || runtimeStatus == null
      || runtimeStatus.ready !== true
      || runtimeStatus.degraded === true
    )
    const missingIngestKey = !ingestKey && (production || deployConfig.deployMode === 'cloud')
    const stateStatus = statusOverride ?? state.snapshot().status
    const stateDegraded = stateStatus.health === 'degraded'
    const captureProgressAtMs = Date.parse(stateStatus.lastRoundAt ?? '')
    const captureProgressExpected = deployConfig.deployMode === 'cloud'
      && stateStatus.connected === true
      && stateStatus.authenticated === true
      && Number(stateStatus.tableCount) === PRODUCTION_TABLE_IDS.length
    const captureUnavailable = deployConfig.deployMode === 'cloud' && !captureProgressExpected
    const captureProgressStale = captureProgressExpected
      && (!Number.isFinite(captureProgressAtMs) || now() - captureProgressAtMs > captureProgressMaxAgeMs)
    const degraded = missingIngestKey || runtimeUnavailable || stateDegraded || captureUnavailable || captureProgressStale
    return {
      health: degraded ? 'degraded' : 'ok',
      degraded,
      reason: missingIngestKey
        ? 'ingest_key_missing'
        : runtimeUnavailable
          ? (runtimeStatus.reason ?? 'active_strategy_not_ready')
          : stateDegraded
            ? stateStatus.reason
            : captureUnavailable
              ? 'capture_unavailable'
              : captureProgressStale ? 'capture_progress_stale' : null,
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
    const localSnapshot = state.snapshot()
    const localProgressAt = localSnapshot.status?.lastRoundAt
      ?? localSnapshot.status?.lastMessageAt
      ?? (tablesReceivedAtMs > 0 ? new Date(tablesReceivedAtMs).toISOString() : null)
      ?? localSnapshot.tables.map((table) => table?.sourceUpdatedAt).filter(Boolean).sort().at(-1)
    if (localSnapshot.tables.length > 0 && isFreshCloudTimestamp(localProgressAt)) return null
    if (!supabaseClient?.configured || typeof supabaseClient.getLatestCloudCaptureStatus !== 'function') return null
    try {
      const [status, snapshot] = await Promise.all([
        supabaseClient.getLatestCloudCaptureStatus(),
        readLatestCloudSnapshot({ requireFresh: true }),
      ])
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
      const snapshotIsFresh = Boolean(snapshot && isFreshCloudTimestamp(snapshot?.snapshot_at ?? snapshot?.updated_at ?? snapshot?.created_at))
      const snapshotTableCount = Array.isArray(snapshot?.tables) ? snapshot.tables.length : Number(snapshot?.table_count ?? 0)
      const preferSnapshot = snapshotTableCount > Number(statusIsFresh ? status?.table_count ?? 0 : 0)
      const source = preferSnapshot ? snapshot?.capture_source : (status?.capture_source ?? snapshot?.capture_source)
      const durableHealthy = preferSnapshot
        ? snapshotIsFresh && snapshotTableCount === PRODUCTION_TABLE_IDS.length
        : statusIsFresh
          && status?.connected === true
          && status?.authenticated === true
          && Number(status?.table_count) === PRODUCTION_TABLE_IDS.length
          && isFreshCloudTimestamp(status?.last_round_at)
      return {
        captureSource: source ?? captureSource,
        captureMode: source ?? captureSource,
        captureSessionId: status?.session_id ?? status?.captureSessionId ?? snapshot?.session_id ?? null,
        health: durableHealthy ? 'ok' : 'degraded',
        degraded: !durableHealthy,
        reason: durableHealthy ? null : 'capture_progress_stale',
        connected: Boolean(preferSnapshot ? snapshotTableCount : (statusIsFresh ? status?.connected ?? snapshotTableCount : false)),
        authenticated: Boolean(preferSnapshot ? snapshotTableCount : (statusIsFresh ? status?.authenticated ?? snapshotTableCount : false)),
        tableCount: Number(preferSnapshot ? snapshotTableCount : (statusIsFresh ? status?.table_count ?? snapshot?.table_count ?? snapshotTableCount ?? 0 : 0)),
        lastMessageAt: preferSnapshot ? snapshot?.snapshot_at ?? status?.last_message_at ?? null : statusIsFresh ? status?.last_message_at ?? snapshot?.snapshot_at ?? null : null,
        lastRoundAt: statusIsFresh ? status?.last_round_at ?? null : null,
        lastTablesAt: snapshot?.snapshot_at ?? null,
        statusText: snapshotTableCount ? `本機VPN抓牌已同步${snapshotTableCount}桌` : statusIsFresh ? status?.status_text ?? null : '雲端資料過期，等待Worker重新抓牌',
        errorMessage: preferSnapshot ? null : statusIsFresh ? status?.error_message ?? null : 'Cloud snapshot is stale',
      }
    } catch (error) {
      const message = error?.message ?? String(error)
      state.setStatus({ cloudReadStatus: 'error', cloudReadError: message })
      return {
        captureSource,
        captureMode: captureSource,
        health: 'degraded',
        degraded: true,
        reason: 'capture_status_unavailable',
        connected: false,
        authenticated: false,
        tableCount: 0,
        statusText: '無法讀取權威抓牌狀態',
        errorMessage: message,
      }
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
  let streamLastTableCount = 0
  let streamHeartbeatPromise = null
  let streamTablesVersion = 0
  let streamLastBroadcastVersion = 0
  let streamNextPredictionExpiryAtMs = Number.POSITIVE_INFINITY

  function writeSse(res, event, payload) {
    if (res.destroyed || res.writableEnded) return
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
  }

  async function authorizedStreamClients() {
    const authorizedClients = []
    for (const client of streamClients) {
      if (await isMemberSessionAuthorized(client.headers)) authorizedClients.push(client)
      else {
        writeSse(client.res, 'unauthorized', { status: 401, error: 'member session is required' })
        client.res.end()
        streamClients.delete(client)
      }
    }
    if (!authorizedClients.length) stopStreamTimerIfIdle()
    return authorizedClients
  }

  async function broadcastTables(force = false) {
    if (!streamClients.size) return
    try {
      const authorizedClients = await authorizedStreamClients()
      if (!authorizedClients.length) return
      const versionAtStart = streamTablesVersion
      const tables = await readBestTables()
      const signature = JSON.stringify(tables)
      const payload = { tables, updatedAt: new Date().toISOString(), tableCount: tables.length }
      streamLastTableCount = tables.length
      streamLastBroadcastVersion = versionAtStart
      const broadcastNowMs = now()
      streamNextPredictionExpiryAtMs = Number.POSITIVE_INFINITY
      for (const prediction of pendingPredictions.values()) {
        const expiryAtMs = Number(prediction?.createdAtMs) + actionablePredictionTtlMs
        if (Number.isFinite(expiryAtMs) && expiryAtMs > broadcastNowMs) {
          streamNextPredictionExpiryAtMs = Math.min(streamNextPredictionExpiryAtMs, expiryAtMs)
        }
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

  async function broadcastHeartbeat() {
    if (!streamClients.size) return
    try {
      const authorizedClients = await authorizedStreamClients()
      const heartbeat = { updatedAt: new Date().toISOString(), tableCount: streamLastTableCount }
      for (const client of authorizedClients) writeSse(client.res, 'heartbeat', heartbeat)
    } catch (error) {
      const payload = { message: error?.message ?? String(error), updatedAt: new Date().toISOString() }
      for (const client of streamClients) writeSse(client.res, 'error', payload)
    }
  }

  let tablesBroadcastPromise = null
  let tablesBroadcastPending = false
  let tablesBroadcastForcePending = false
  let tablesBroadcastStopping = false
  requestTablesRefresh = () => {
    streamTablesVersion += 1
  }
  requestTablesBroadcast = (force = false) => {
    if (tablesBroadcastStopping) return
    tablesBroadcastPending = true
    tablesBroadcastForcePending = tablesBroadcastForcePending || force === true
    if (tablesBroadcastPromise) return
    tablesBroadcastPromise = (async () => {
      while (tablesBroadcastPending && !tablesBroadcastStopping) {
        const forceNext = tablesBroadcastForcePending
        tablesBroadcastPending = false
        tablesBroadcastForcePending = false
        await broadcastTables(forceNext)
      }
    })().finally(() => {
      tablesBroadcastPromise = null
      if (tablesBroadcastPending && !tablesBroadcastStopping) requestTablesBroadcast(tablesBroadcastForcePending)
    })
  }

  function ensureStreamTimer() {
    if (streamTimer) return
    streamTimer = setInterval(() => {
      if (tablesBroadcastPromise || streamHeartbeatPromise) return
      if (streamTablesVersion !== streamLastBroadcastVersion || now() >= streamNextPredictionExpiryAtMs) {
        requestTablesBroadcast(false)
        return
      }
      streamHeartbeatPromise = broadcastHeartbeat().finally(() => {
        streamHeartbeatPromise = null
      })
    }, Math.max(10, Number(streamHeartbeatMs) || 3000))
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
    requestTablesBroadcast(true)
    res.on('close', () => { streamClients.delete(client); stopStreamTimerIfIdle() })
  }
  const listenHost = host ?? (deployConfig.deployMode === 'cloud' ? '0.0.0.0' : '127.0.0.1')

  return {
    state,
    server,
    async start() {
      tablesBroadcastStopping = false
      const listeningServer = await new Promise((resolve) => server.listen(port, listenHost, () => resolve(server)))
      if (requireVerifiedStrategy && supabaseClient?.configured === true) {
        try {
          if (resolvedCaptureOutboxConsumerEnabled && typeof supabaseClient.ensureInitialStrategy === 'function') {
            await supabaseClient.ensureInitialStrategy()
            await ensureRecentPerformanceReady()
          } else if (!resolvedCaptureOutboxConsumerEnabled && typeof supabaseClient.verifyActiveStrategyReadOnly === 'function') {
            await supabaseClient.verifyActiveStrategyReadOnly()
          }
        } catch (error) {
          recentPerformanceReady = false
          state.setStatus({ persistenceStatus: 'error', persistenceError: error?.message ?? String(error) })
        }
      }
      if (resolvedCaptureOutboxConsumerEnabled && v104Formal && typeof v104Formal.start === 'function') {
        try {
          await v104Formal.start()
        } catch (error) {
          state.setStatus({ persistenceStatus: 'error', persistenceError: error?.message ?? String(error) })
        }
      }
      if (resolvedCaptureOutboxConsumerEnabled && shouldAutoConnect) {
        if (captureSource === 'cloud_browser' && cloudBrowserUrl) cloudCaptureClient.start()
        else if (captureUrl) chromeClient.start()
        else mtClient.connect()
      }
      if (resolvedCaptureOutboxConsumerEnabled) {
        void drainCaptureOutbox().catch((error) => {
          state.setStatus({ persistenceStatus: 'error', persistenceError: error?.message ?? String(error) })
        })
      }
      return listeningServer
    },
    async stop() {
      tablesBroadcastStopping = true
      tablesBroadcastPending = false
      tablesBroadcastForcePending = false
      if (streamTimer) {
        clearInterval(streamTimer)
        streamTimer = null
      }
      outboxStopping = true
      if (outboxWakeTimer) {
        clearTimeout(outboxWakeTimer)
        outboxWakeTimer = null
        outboxWakeAtMs = null
        resolveOutboxWake?.()
        resolveOutboxWake = null
        outboxWakePromise = null
      }
      mtClient.stop()
      chromeClient.stop()
      cloudCaptureClient.stop()
      for (const client of streamClients) client.res.end()
      streamClients.clear()
      try {
        await withDeadline(
          Promise.all([
            tablesBroadcastPromise?.catch(() => {}) ?? Promise.resolve(),
            streamHeartbeatPromise?.catch(() => {}) ?? Promise.resolve(),
          ]),
          resolvedServiceShutdownDeadlineMs,
          'tables broadcast shutdown deadline exceeded',
        )
      } catch {}
      try {
        await withDeadline(
          outboxDrainPromise?.catch(() => {}) ?? Promise.resolve(),
          resolvedServiceShutdownDeadlineMs,
          'capture outbox shutdown deadline exceeded',
        )
      } catch {}
      await serviceWorkScheduler.closeAndWait()
      if (!server.listening) return
      await new Promise((resolve) => server.close(() => resolve()))
    },
    async inject({ method = 'GET', url = '/', body = '', headers = {} } = {}) {
      return handle(method, url, body, headers)
    },
    drainCaptureOutbox,
    waitForCaptureOutboxIdle,
    waitForServiceWorkIdle: async () => {
      await serviceWorkScheduler.waitForIdle()
    },
    cloudCaptureClient,
  }
}

function classifySourceFenceError(error) {
  const message = String(error?.message ?? error ?? '')
  for (const code of ['stale_source_epoch', 'source_epoch_fence_conflict', 'source_fence_invalid']) {
    if (message.includes(code)) return code
  }
  return null
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
    if (timer) clearTimeout(timer)
  }
}

export function resolveCaptureOutboxLeaseDeadlineMs(baseDeadlineMs, claimCount) {
  const normalizedBase = Math.max(1, Number(baseDeadlineMs) || 1)
  const normalizedClaimCount = Math.max(1, Number(claimCount) || 1)
  const batchUnits = Math.max(1, Math.ceil(normalizedClaimCount / 10))
  const bufferedBatchUnits = batchUnits > 1 ? batchUnits + 1 : batchUnits
  return Math.min(240_000, normalizedBase * bufferedBatchUnits)
}

function createLeaseDeadline(timeoutMs, message = 'outbox work deadline exceeded') {
  const controller = new AbortController()
  const expiresAtMs = Date.now() + Math.max(1, Number(timeoutMs) || 1)
  const deadlineError = new Error(message)
  const timer = setTimeout(() => controller.abort(deadlineError), Math.max(1, expiresAtMs - Date.now()))
  timer.unref?.()

  function assertActive() {
    if (!controller.signal.aborted && Date.now() >= expiresAtMs) controller.abort(deadlineError)
    if (controller.signal.aborted) throw controller.signal.reason ?? deadlineError
  }

  function race(operation) {
    assertActive()
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(controller.signal.reason ?? deadlineError)
      controller.signal.addEventListener('abort', onAbort, { once: true })
      Promise.resolve(operation).then(resolve, reject).finally(() => {
        controller.signal.removeEventListener('abort', onAbort)
      })
    })
  }

  return {
    signal: controller.signal,
    remainingMs: () => Math.max(1, expiresAtMs - Date.now()),
    assertActive,
    race,
    close: () => clearTimeout(timer),
  }
}

function validateIngestEnvelope(envelope, currentTime, { allowAgedFencedEnvelope = false } = {}) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error('invalid payload')
  if (envelope.protocolVersion !== WORKER_PROTOCOL_VERSION) {
    const error = new Error('version_mismatch')
    error.statusCode = 409
    error.versionMismatch = true
    error.receivedProtocolVersion = envelope.protocolVersion
    throw error
  }
  const timestamp = Number(envelope.timestamp)
  const timestampAgeMs = Number(currentTime) - timestamp
  if (!Number.isFinite(timestamp)
    || timestampAgeMs < -5 * 60 * 1000
    || (!allowAgedFencedEnvelope && timestampAgeMs > 5 * 60 * 1000)) {
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
