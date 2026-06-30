import http from 'node:http'
import { chromium } from 'playwright'
import { extractSnapshotFromPayloads, redactUrlSecrets } from './snapshot.js'

const SERVICE = 'darven-cloud-browser-worker'
const VERSION = '0.47.0'
const PORT = Number(process.env.PORT ?? 8787)
const MT_LOGIN_URL = process.env.MT_LOGIN_URL ?? ''
const SNAPSHOT_PATH = process.env.SNAPSHOT_PATH ?? '/snapshot'
const PAGE_TIMEOUT_MS = Number(process.env.PAGE_TIMEOUT_MS ?? 45000)
const MAX_CAPTURED_PAYLOADS = Number(process.env.MAX_CAPTURED_PAYLOADS ?? 250)

const capturedPayloads = []
let browserPromise = null
let pagePromise = null
let lastSnapshot = null
let lastError = null

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, {
        ok: true,
        service: SERVICE,
        version: VERSION,
        configured: Boolean(MT_LOGIN_URL),
        loginUrl: MT_LOGIN_URL ? redactUrlSecrets(MT_LOGIN_URL) : null,
        lastError,
      })
    }

    if (req.method === 'GET' && url.pathname === SNAPSHOT_PATH) {
      const snapshot = await getSnapshot()
      return sendJson(res, 200, snapshot)
    }

    if (req.method === 'POST' && url.pathname === '/reload') {
      await closePage()
      const snapshot = await getSnapshot()
      return sendJson(res, 200, { ok: true, snapshot })
    }

    return sendJson(res, 404, { ok: false, error: 'not_found', paths: ['/health', SNAPSHOT_PATH, '/reload'] })
  } catch (error) {
    lastError = redactUrlSecrets(error?.message ?? String(error))
    return sendJson(res, 500, buildErrorSnapshot(lastError))
  }
})

server.listen(PORT, () => {
  console.log(`${SERVICE} v${VERSION} listening on :${PORT}`)
})

async function getSnapshot() {
  if (!MT_LOGIN_URL) {
    return buildErrorSnapshot('MT_LOGIN_URL is required')
  }

  const page = await ensurePage()
  const browserPayload = await collectBrowserPayload(page)
  const payloads = [...capturedPayloads, browserPayload]
  const snapshot = extractSnapshotFromPayloads(payloads, {
    sessionId: process.env.SESSION_ID ?? 'darven-cloud-browser',
    now: new Date().toISOString(),
    url: MT_LOGIN_URL,
  })

  if (snapshot.tables.length === 0 && snapshot.rounds.length === 0) {
    snapshot.authenticated = false
    snapshot.errorMessage = 'MT page is open, but no table payload was detected yet. Keep worker running or inspect selector/websocket payloads.'
  }

  lastSnapshot = snapshot
  lastError = null
  return snapshot
}

async function ensurePage() {
  if (pagePromise) return pagePromise
  pagePromise = (async () => {
    const browser = await ensureBrowser()
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    attachCaptureHooks(page)
    await page.goto(MT_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS })
    await page.waitForTimeout(Number(process.env.INITIAL_SETTLE_MS ?? 5000))
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

function attachCaptureHooks(page) {
  page.on('response', async (response) => {
    const contentType = response.headers()['content-type'] ?? ''
    if (!contentType.includes('json')) return
    const text = await response.text().catch(() => null)
    if (text) rememberPayload(text)
  })

  page.on('websocket', (ws) => {
    ws.on('framereceived', (frame) => rememberPayload(frame.payload))
    ws.on('framesent', (frame) => rememberPayload(frame.payload))
  })

  page.on('pageerror', (error) => {
    lastError = redactUrlSecrets(error?.message ?? String(error))
  })
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
}

async function closePage() {
  const page = pagePromise ? await pagePromise.catch(() => null) : null
  pagePromise = null
  if (page) await page.close().catch(() => {})
}

function buildErrorSnapshot(errorMessage) {
  return {
    connected: false,
    authenticated: false,
    sessionId: process.env.SESSION_ID ?? 'darven-cloud-browser',
    snapshotAt: new Date().toISOString(),
    tables: lastSnapshot?.tables ?? [],
    rounds: [],
    errorMessage: redactUrlSecrets(errorMessage),
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  })
  res.end(JSON.stringify(body))
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

async function shutdown() {
  const browser = browserPromise ? await browserPromise.catch(() => null) : null
  if (browser) await browser.close().catch(() => {})
  server.close(() => process.exit(0))
}
