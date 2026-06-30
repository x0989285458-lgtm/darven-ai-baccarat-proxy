import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'ws'
import { normalizeMtTables } from './normalize-table.js'

const DEFAULT_CHROME_PORT = 9226
const DEFAULT_CHROME_PATH = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const DEFAULT_USER_DATA_DIR = 'C:/Users/童威仁/AppData/Local/hermes/chrome-profiles/draven-mt-v004'

export function createChromeCaptureClient({
  url,
  state,
  chromePath = process.env.CHROME_PATH ?? DEFAULT_CHROME_PATH,
  port = Number(process.env.CHROME_CDP_PORT ?? DEFAULT_CHROME_PORT),
  userDataDir = process.env.CHROME_USER_DATA_DIR ?? DEFAULT_USER_DATA_DIR,
  headless = process.env.CHROME_HEADLESS === 'true',
} = {}) {
  let chrome = null
  let cdp = null
  let stopped = false
  let msgId = 0

  async function start() {
    if (!url) {
      state?.recordError('CHROME_CAPTURE_URL is missing')
      return null
    }
    stopped = false
    state?.setStatus({ captureSource: 'local_chrome', captureMode: 'local_chrome', cloudReady: true, captureUrlMasked: maskUrlToken(url), connected: false, authenticated: false })
    try {
      rmSync(userDataDir, { recursive: true, force: true })
      mkdirSync(userDataDir, { recursive: true })
      chrome = spawn(chromePath, buildChromeLaunchArgs({ url, userDataDir, port, headless }), {
        detached: false,
        stdio: 'ignore',
      })
      await waitForCdp(port)
      const page = await pickPage(port)
      cdp = new WebSocket(page.webSocketDebuggerUrl)
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('CDP connect timeout')), 10000)
        cdp.once('open', () => { clearTimeout(timer); resolve() })
        cdp.once('error', reject)
      })
      cdp.on('message', (raw) => handleCdpMessage(raw.toString()))
      cdp.on('error', (error) => state?.recordError(`Chrome CDP error: ${error.message}`))
      cdp.on('close', () => {
        if (!stopped) state?.setStatus({ connected: false, authenticated: false, errorMessage: 'Chrome CDP closed' })
      })
      await send('Network.enable')
      await send('Page.enable')
      await send('Page.navigate', { url })
      state?.setStatus({ chromeStarted: true, chromePort: port, errorMessage: null })
      return chrome
    } catch (error) {
      state?.recordError(`Chrome capture start failed: ${error.message}`)
      stop()
      return null
    }
  }

  function handleCdpMessage(raw) {
    let event
    try { event = JSON.parse(raw) } catch { return }
    if (event.method === 'Network.webSocketCreated') {
      state?.setStatus({ wsUrl: event.params?.url, connected: true, errorMessage: null })
    }
    if (event.method === 'Network.webSocketFrameReceived') {
      const payload = event.params?.response?.payloadData ?? ''
      state?.setStatus({ lastMessageAt: new Date().toISOString(), connected: true })
      const auth = parseJson(payload)
      if (auth?.action === '/api/v1/authenticate' && auth?.err === 0) {
        state?.setStatus({ authenticated: true, errorMessage: null })
      }
      const tables = extractTablesFromCdpFrame(payload)
      if (tables.length > 0) {
        state?.setStatus({ authenticated: true, connected: true, lastTablesAt: new Date().toISOString(), errorMessage: null })
        state?.setTables(normalizeMtTables(tables))
      }
      const roundEvent = extractRoundEventFromCdpFrame(payload)
      if (roundEvent) {
        state?.setStatus({ authenticated: true, connected: true, lastRoundAt: new Date().toISOString(), errorMessage: null })
        state?.upsertRoundEvent(roundEvent)
      }
    }
    if (event.method === 'Network.webSocketClosed') {
      state?.setStatus({ connected: false, authenticated: false })
    }
  }

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!cdp || cdp.readyState !== WebSocket.OPEN) return reject(new Error('CDP is not open'))
      const id = ++msgId
      const onMessage = (raw) => {
        let msg
        try { msg = JSON.parse(raw.toString()) } catch { return }
        if (msg.id === id) {
          cdp.off('message', onMessage)
          if (msg.error) reject(new Error(msg.error.message ?? 'CDP error'))
          else resolve(msg.result)
        }
      }
      cdp.on('message', onMessage)
      cdp.send(JSON.stringify({ id, method, params }))
    })
  }

  function stop() {
    stopped = true
    try { cdp?.close() } catch {}
    try { chrome?.kill() } catch {}
    state?.setStatus({ connected: false, authenticated: false, chromeStarted: false })
  }

  return { start, stop }
}

export function extractTablesFromCdpFrame(payloadText) {
  const payload = parseJson(payloadText)
  if (!payload) return []
  const candidates = [payload?.msg?.tables, payload?.body?.tables, payload?.data?.tables, payload?.tables]
  return candidates.find(Array.isArray) ?? []
}

export function extractRoundEventFromCdpFrame(payloadText) {
  const payload = parseJson(payloadText)
  if (!payload) return null
  const action = String(payload?.action ?? payload?.action?.name ?? '')
  if (!/(show_poker|summary|show_win)/.test(action)) return null
  const body = payload.body ?? payload.msg ?? payload.data ?? {}
  const tableId = body.table_id ?? payload.table_id
  if (!tableId) return null
  const rawResult = Array.isArray(body.result) ? body.result : null
  return {
    tableId: String(tableId),
    shoe: toFiniteNumberOrNull(body.shoe),
    round: toFiniteNumberOrNull(body.round),
    playerPoint: rawResult && rawResult.length > 8 ? toFiniteNumberOrNull(rawResult[8]) : null,
    bankerPoint: rawResult && rawResult.length > 9 ? toFiniteNumberOrNull(rawResult[9]) : null,
    winner: toFiniteNumberOrNull(body.winner),
    rawResult,
    sourceAction: action,
  }
}

export function isTablesPayload(payload) {
  return String(payload?.action ?? '').includes('/tables') && Array.isArray(payload?.msg?.tables)
}

export function buildChromeLaunchArgs({ url, userDataDir, port, headless = false }) {
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-popup-blocking',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--autoplay-policy=no-user-gesture-required',
  ]
  if (headless) args.push('--headless=new')
  args.push(url)
  return args
}

async function waitForCdp(port, attempts = 50) {
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) return response.json()
    } catch {}
    await delay(200)
  }
  throw new Error(`Chrome CDP port ${port} not ready`)
}

async function pickPage(port) {
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  const page = tabs.find((tab) => tab.type === 'page' && tab.webSocketDebuggerUrl)
  if (!page) throw new Error('No Chrome page target found')
  return page
}

function parseJson(text) {
  try { return JSON.parse(text) } catch { return null }
}

function toFiniteNumberOrNull(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function maskUrlToken(url) {
  return String(url).replace(/token=([^&]+)/i, (_, token) => `token=${String(token).slice(0,4)}…${String(token).slice(-4)}`)
}
