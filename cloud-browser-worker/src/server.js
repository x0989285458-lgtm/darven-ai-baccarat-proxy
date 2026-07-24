import http from 'node:http'
import { chromium } from 'playwright'
import { isWorkerAdminAuthorized } from './admin-auth.js'
import { annotateRoundPayload, extractSnapshotFromPayloads, isFinalRealCardRound, isRoundPayload, redactUrlSecrets } from './snapshot.js'
import { createSnapshotPusher } from './snapshot-pusher.js'
import { BUILD_VERSION, captureSessionId, publicBuildInfo, validateProductionConfig } from './runtime-config.js'
import { createFixedWindowRateLimiter } from './server-policy.js'
import {
  assertAllowedMtUrl,
  createPortalRefreshController,
  isFormalTenTableSnapshot,
  parseMtHostAllowlist,
  readPersistedSession,
  readPortalCredentials,
  recoverRedirectedInitialSession,
  refreshMtSession,
} from './portal-session.js'

const SERVICE = 'darven-cloud-browser-worker'
validateProductionConfig(process.env)
const PORT = Number(process.env.PORT ?? 8787)
const MT_LOGIN_URL = process.env.MT_LOGIN_URL ?? ''
const SNAPSHOT_PATH = process.env.SNAPSHOT_PATH ?? '/snapshot'
const PAGE_TIMEOUT_MS = Number(process.env.PAGE_TIMEOUT_MS ?? 45000)
const SNAPSHOT_TIMEOUT_MS = Number(process.env.SNAPSHOT_TIMEOUT_MS ?? PAGE_TIMEOUT_MS)
const MAX_CAPTURED_PAYLOADS = Number(process.env.MAX_CAPTURED_PAYLOADS ?? 250)
const MAX_CAPTURED_ROUND_PAYLOADS = Number(process.env.MAX_CAPTURED_ROUND_PAYLOADS ?? 500)
const BASE_SESSION_ID = process.env.SESSION_ID ?? 'darven-cloud-browser'
const PORTAL_CREDENTIALS_FILE = process.env.PORTAL_CREDENTIALS_FILE ?? ''
const MT_SESSION_PATH = process.env.MT_SESSION_PATH ?? './data/mt-session.json'
const MT_ALLOWED_HOSTS = parseMtHostAllowlist(process.env.MT_HOST_ALLOWLIST)
const BROWSER_CONTEXT_OPTIONS = {
  viewport: { width: 1440, height: 1000 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  locale: 'zh-TW',
}

const capturedPayloads = []
const capturedRoundPayloads = []
let browserPromise = null
let pagePromise = null
let pageContext = null
let activeMtUrl = MT_LOGIN_URL
let pageGeneration = 0
let capturedRoundSequence = 0
let lastSnapshot = null
let lastError = null
const snapshotRateLimiter = createFixedWindowRateLimiter({ limit: 12, windowMs: 60000 })
const portalRefreshController = createPortalRefreshController({
  enabled: Boolean(PORTAL_CREDENTIALS_FILE),
  maxAttempts: 2,
  baseBackoffMs: Number(process.env.PORTAL_REFRESH_BACKOFF_MS ?? 5000),
  refresh: refreshExpiredMtSession,
})

const snapshotPusher = createSnapshotPusher({
  targetUrl: process.env.PUSH_TARGET_URL,
  key: process.env.INGEST_KEY,
  getSnapshot,
  intervalMs: Number(process.env.PUSH_INTERVAL_MS ?? 5000),
  requestTimeoutMs: Number(process.env.PUSH_REQUEST_TIMEOUT_MS ?? 120000),
  queuePath: process.env.PUSH_QUEUE_PATH ?? './data/latest-snapshot.json',
  isRoundDeliverable: isFinalRealCardRound,
})

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, {
        ok: true,
        service: SERVICE,
        version: BUILD_VERSION,
        ...publicBuildInfo(),
        configured: Boolean(MT_LOGIN_URL),
        loginUrl: MT_LOGIN_URL ? redactUrlSecrets(MT_LOGIN_URL) : null,
        lastError,
      })
    }

    if (req.method === 'GET' && url.pathname === SNAPSHOT_PATH) {
      if (!isWorkerAdminAuthorized(req, process.env.WORKER_ADMIN_KEY, { allowQuery: false })) return sendJson(res, 401, { ok: false, error: 'unauthorized' })
      const rate = snapshotRateLimiter.check(req.socket?.remoteAddress)
      if (!rate.allowed) return sendJson(res, 429, { ok: false, error: 'rate_limited' }, { 'retry-after': String(rate.retryAfter) })
      const snapshot = await getSnapshot()
      return sendJson(res, 200, snapshot)
    }

    if (req.method === 'POST' && url.pathname === '/reload') {
      if (!isWorkerAdminAuthorized(req, process.env.WORKER_ADMIN_KEY, { allowQuery: false })) return sendJson(res, 401, { ok: false, error: 'unauthorized' })
      resetCapturedPayloads()
      await closePage()
      const snapshot = await getSnapshot()
      return sendJson(res, 200, { ok: true, snapshot })
    }

    return sendJson(res, 404, { ok: false, error: 'not_found', paths: ['/health', SNAPSHOT_PATH, '/reload'] })
  } catch (error) {
    lastError = redactUrlSecrets(error?.message ?? String(error))
    resetCapturedPayloads()
    await closePage()
    lastSnapshot = null
    return sendJson(res, 500, buildErrorSnapshot(lastError))
  }
})

server.listen(PORT, () => {
  console.log(`${SERVICE} ${BUILD_VERSION} listening on :${PORT}`)
  snapshotPusher.start()
})

async function getSnapshot() {
  if (!MT_LOGIN_URL) {
    return buildErrorSnapshot('MT_LOGIN_URL is required')
  }

  try {
    const page = await withTimeout(ensurePage(), SNAPSHOT_TIMEOUT_MS, 'MT page startup timed out')
    activeMtUrl = assertAllowedMtUrl(page.url(), MT_LOGIN_URL, MT_ALLOWED_HOSTS)
    const browserPayload = await withTimeout(collectBrowserPayload(page), SNAPSHOT_TIMEOUT_MS, 'MT page snapshot timed out')
    const payloads = [...capturedPayloads, ...capturedRoundPayloads, browserPayload]
    const snapshot = extractSnapshotFromPayloads(payloads, {
      sessionId: captureSessionId(BASE_SESSION_ID, pageGeneration),
      now: new Date().toISOString(),
      url: activeMtUrl,
    })

    if (snapshot.tables.length === 0 && snapshot.rounds.length === 0) {
      snapshot.authenticated = false
      snapshot.errorMessage = 'MT page is open, but no table payload was detected yet. Keep worker running or inspect selector/websocket payloads.'
    }

    const refreshStatus = await portalRefreshController.observe(snapshot, pageGeneration)
    if (refreshStatus.errorCategory) snapshot.errorMessage = refreshStatus.errorCategory

    lastSnapshot = snapshot
    lastError = refreshStatus.errorCategory ?? null
    return snapshot
  } catch (error) {
    lastError = redactUrlSecrets(error?.message ?? String(error))
    resetCapturedPayloads()
    await closePage()
    lastSnapshot = null
    return buildErrorSnapshot(lastError)
  }
}

async function ensurePage() {
  if (pagePromise) return pagePromise
  pagePromise = (async () => {
    const browser = await ensureBrowser()
    const persisted = PORTAL_CREDENTIALS_FILE
      ? await readPersistedSession(MT_SESSION_PATH, MT_LOGIN_URL, MT_ALLOWED_HOSTS)
      : null
    const targetUrl = persisted?.url ?? MT_LOGIN_URL
    const context = await browser.newContext({
      ...BROWSER_CONTEXT_OPTIONS,
      ...(persisted?.storageState ? { storageState: persisted.storageState } : {}),
    })
    pageContext = context
    const page = await context.newPage()
    pageGeneration += 1
    attachCaptureHooks(page)
    const navigationResponse = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS })
    const refreshedPage = await recoverRedirectedInitialSession({
      navigationResponse,
      refreshEnabled: Boolean(PORTAL_CREDENTIALS_FILE),
      closeExpired: async () => {
        pagePromise = null
        if (pageContext === context) pageContext = null
        resetCapturedPayloads()
        await context.close().catch(() => {})
      },
      refresh: async () => {
        await refreshExpiredMtSession()
        return pagePromise ? await pagePromise : null
      },
    })
    if (refreshedPage) return refreshedPage
    activeMtUrl = assertAllowedMtUrl(page.url(), MT_LOGIN_URL, MT_ALLOWED_HOSTS)
    await page.waitForTimeout(Number(process.env.INITIAL_SETTLE_MS ?? 5000))
    activeMtUrl = assertAllowedMtUrl(page.url(), MT_LOGIN_URL, MT_ALLOWED_HOSTS)
    return page
  })()
  return pagePromise
}

async function ensureBrowser() {
  if (browserPromise) return browserPromise
  browserPromise = chromium.launch({
    headless: process.env.HEADLESS !== 'false',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  })
  return browserPromise
}

function attachCaptureHooks(page, remember = rememberPayload, onPageError = (error) => {
  lastError = redactUrlSecrets(error?.message ?? String(error))
}) {
  page.on('response', async (response) => {
    const contentType = response.headers()['content-type'] ?? ''
    if (!contentType.includes('json')) return
    const text = await response.text().catch(() => null)
    if (text) remember(text)
  })

  page.on('websocket', (ws) => {
    ws.on('framereceived', (frame) => remember(frame.payload))
    ws.on('framesent', (frame) => remember(frame.payload))
  })

  page.on('pageerror', (error) => {
    onPageError(error)
  })
}

async function refreshExpiredMtSession() {
  const credentials = await readPortalCredentials(PORTAL_CREDENTIALS_FILE)
  const browser = await ensureBrowser()
  await refreshMtSession({
    browser,
    credentials,
    configuredMtUrl: MT_LOGIN_URL,
    allowedHosts: MT_ALLOWED_HOSTS,
    sessionPath: MT_SESSION_PATH,
    contextOptions: BROWSER_CONTEXT_OPTIONS,
    timeoutMs: Number(process.env.PORTAL_LOGIN_TIMEOUT_MS ?? PAGE_TIMEOUT_MS),
    prepareContext: prepareCandidateCapture,
    validate: validateCandidatePage,
    activate: activateCandidatePage,
  })
}

function prepareCandidateCapture(context) {
  const capture = { payloads: [] }
  context.on('page', (page) => {
    attachCaptureHooks(page, (payload) => rememberCandidatePayload(capture, payload), () => {})
  })
  return capture
}

function rememberCandidatePayload(capture, payload) {
  if (payload == null) return
  const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload)
  if (!text.trim()) return
  capture.payloads.push(text)
  while (capture.payloads.length > MAX_CAPTURED_ROUND_PAYLOADS) capture.payloads.shift()
}

async function validateCandidatePage(page, capture) {
  const deadline = Date.now() + Number(process.env.PORTAL_CANDIDATE_TIMEOUT_MS ?? PAGE_TIMEOUT_MS)
  do {
    const browserPayload = await collectBrowserPayload(page)
    const snapshot = extractSnapshotFromPayloads([...(capture?.payloads ?? []), browserPayload], {
      sessionId: captureSessionId(BASE_SESSION_ID, pageGeneration + 1),
      now: new Date().toISOString(),
      url: page.url(),
    })
    if (isFormalTenTableSnapshot(snapshot)) return snapshot
    await page.waitForTimeout(1000)
  } while (Date.now() < deadline)
  return { connected: true, authenticated: false, tables: [] }
}

async function activateCandidatePage({ page, context, prepared }) {
  const previousPage = pagePromise ? await pagePromise.catch(() => null) : null
  const previousContext = pageContext
  resetCapturedPayloads()
  pageGeneration += 1
  for (const payload of prepared?.payloads ?? []) rememberPayload(payload)
  activeMtUrl = assertAllowedMtUrl(page.url(), MT_LOGIN_URL, MT_ALLOWED_HOSTS)
  pageContext = context
  pagePromise = Promise.resolve(page)
  if (previousContext && previousContext !== context) await previousContext.close().catch(() => {})
  else if (previousPage && previousPage !== page) await previousPage.close().catch(() => {})
}

async function collectBrowserPayload(page) {
  return page.evaluate(() => {
    const payloads = []
    const push = (value) => {
      if (value == null) return
      try {
        payloads.push(typeof value === 'string' ? value : JSON.stringify(value))
      } catch {}
    }

    push(window.__DRAVEN_CLOUD_SNAPSHOT__)
    push(window.__INITIAL_STATE__)
    push(window.__NUXT__)
    push(window.__NEXT_DATA__)

    for (const storage of [window.localStorage, window.sessionStorage]) {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index)
        const value = key ? storage.getItem(key) : null
        if (value && /table|road|baccarat|bac|game|round|shoe|靴|桌/i.test(`${key} ${value.slice(0, 300)}`)) {
          push(value)
        }
      }
    }

    const text = document.body?.innerText ?? ''
    push({ pageTitle: document.title, bodyProbe: text.slice(0, 5000) })
    return { payloads, href: location.href, title: document.title }
  })
}

function rememberPayload(payload) {
  if (payload == null) return
  const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload)
  if (!text.trim()) return
  capturedPayloads.push(text)
  while (capturedPayloads.length > MAX_CAPTURED_PAYLOADS) capturedPayloads.shift()
  if (isRoundPayload(text)) {
    capturedRoundSequence += 1
    const sourceEventId = `${captureSessionId(BASE_SESSION_ID, pageGeneration)}:${capturedRoundSequence}`
    capturedRoundPayloads.push(annotateRoundPayload(text, sourceEventId))
    while (capturedRoundPayloads.length > MAX_CAPTURED_ROUND_PAYLOADS) capturedRoundPayloads.shift()
  }
}

function resetCapturedPayloads() {
  capturedPayloads.length = 0
  capturedRoundPayloads.length = 0
}

async function closePage() {
  const page = pagePromise ? await withTimeout(pagePromise, 5000, 'MT page close wait timed out').catch(() => null) : null
  const context = pageContext
  pagePromise = null
  pageContext = null
  if (context) await context.close().catch(() => {})
  else if (page) await page.close().catch(() => {})
}

function buildErrorSnapshot(errorMessage) {
  return {
    connected: false,
    buildVersion: BUILD_VERSION,
    authenticated: false,
    sessionId: captureSessionId(BASE_SESSION_ID, pageGeneration),
    snapshotAt: new Date().toISOString(),
    tables: [],
    rounds: [],
    errorMessage: redactUrlSecrets(errorMessage),
    staleStateCleared: true,
  }
}

function withTimeout(promise, timeoutMs, message) {
  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), Math.max(1, Number(timeoutMs) || PAGE_TIMEOUT_MS))
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function sendJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    ...extraHeaders,
  })
  res.end(JSON.stringify(body))
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

async function shutdown() {
  snapshotPusher.stop()
  const browser = browserPromise ? await browserPromise.catch(() => null) : null
  if (browser) await browser.close().catch(() => {})
  server.close(() => process.exit(0))
}
