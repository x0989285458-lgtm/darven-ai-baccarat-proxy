import { WebSocket } from 'ws'
import { buildAuthenticatePacket, buildMemberMePacket, buildPingPacket, buildTablesRequestPacket } from './mt-protocol.js'
import { normalizeMtTables } from './normalize-table.js'

const DEFAULT_MT_WS_URL = 'wss://a1.ofalive99.net/game/ws'
const DEFAULT_MT_ORIGIN = 'https://gsa.ofalive99.net'
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'
const DEFAULT_PING_INTERVAL_MS = 5000

export function createMtClient({
  token,
  state,
  wsUrl = DEFAULT_MT_WS_URL,
  origin = process.env.MT_ORIGIN ?? DEFAULT_MT_ORIGIN,
  reconnectDelayMs = 3000,
  pingIntervalMs = Number(process.env.MT_PING_INTERVAL_MS ?? DEFAULT_PING_INTERVAL_MS),
} = {}) {
  let ws = null
  let stopped = false
  let reconnectTimer = null
  let pingTimer = null

  function connect() {
    if (!token) {
      state?.recordError('MT_TOKEN is missing; proxy stays in test/offline mode')
      state?.setStatus({ captureSource: 'offline', captureMode: 'offline' })
      return null
    }

    stopped = false
    clearInterval(pingTimer)
    ws = new WebSocket(wsUrl, {
      headers: buildBrowserLikeHeaders({ origin }),
    })

    ws.on('open', () => {
      state?.setStatus({ captureSource: 'node_ws', captureMode: 'node_ws', connected: true, authenticated: false, errorMessage: null, wsUrl })
      sendJson(ws, buildAuthenticatePacket(token))
    })

    ws.on('message', (data) => {
      const text = data.toString()
      state?.setStatus({ lastMessageAt: new Date().toISOString() })

      if (shouldRequestTablesAfterAuth(text)) {
        state?.setStatus({ authenticated: true, errorMessage: null })
        sendJson(ws, buildMemberMePacket())
        sendJson(ws, buildTablesRequestPacket())
        startPing()
        return
      }

      const authError = getAuthenticateError(text)
      if (authError) {
        state?.recordError(authError)
        return
      }

      const tables = extractTables(text)
      if (tables.length > 0) {
        state?.setTables(normalizeMtTables(tables))
      }
    })

    ws.on('error', (error) => {
      state?.recordError(error.message)
    })

    ws.on('close', () => {
      clearInterval(pingTimer)
      state?.setStatus({ connected: false, authenticated: false })
      if (!stopped) scheduleReconnect()
    })

    return ws
  }

  function startPing() {
    clearInterval(pingTimer)
    if (!Number.isFinite(pingIntervalMs) || pingIntervalMs <= 0) return
    pingTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) sendJson(ws, buildPingPacket())
    }, pingIntervalMs)
  }

  function scheduleReconnect() {
    state?.setStatus({ reconnectCount: (state.snapshot().status.reconnectCount ?? 0) + 1 })
    clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(connect, reconnectDelayMs)
  }

  function stop() {
    stopped = true
    clearTimeout(reconnectTimer)
    clearInterval(pingTimer)
    if (ws) ws.close()
  }

  return { connect, stop }
}

export function buildBrowserLikeHeaders({ origin = DEFAULT_MT_ORIGIN, userAgent = DEFAULT_USER_AGENT } = {}) {
  return {
    Origin: origin,
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'User-Agent': userAgent,
    'Sec-WebSocket-Extensions': 'permessage-deflate; client_max_window_bits',
  }
}

export function shouldRequestTablesAfterAuth(payloadText) {
  try {
    const payload = JSON.parse(payloadText)
    return payload?.action === '/api/v1/authenticate' && payload?.err === 0
  } catch {
    return false
  }
}

export function extractTables(payloadText) {
  try {
    const payload = JSON.parse(payloadText)
    const candidates = [
      payload?.msg?.tables,
      payload?.body?.tables,
      payload?.body?.data?.tables,
      payload?.body?.data,
      payload?.data?.tables,
      payload?.data,
      payload?.tables,
    ]
    return candidates.find(Array.isArray) ?? []
  } catch {
    return []
  }
}

function getAuthenticateError(payloadText) {
  try {
    const payload = JSON.parse(payloadText)
    if (payload?.action === '/api/v1/authenticate' && payload?.err !== 0) {
      return `MT authenticate failed err=${payload.err}`
    }
    return null
  } catch {
    return null
  }
}

function sendJson(ws, packet) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(packet))
}
