import { normalizeMtTables } from './normalize-table.js'
import { buildOperationalEvent, toStatusEvent } from './event-layer.js'

const DEFAULT_POLL_MS = 5000
const DEFAULT_REQUEST_TIMEOUT_MS = 15000
const DEFAULT_REQUEST_RETRIES = 2

export function parseCloudCapturePayload(payload = {}) {
  const tables = normalizeCloudTables(payload.tables ?? payload.snapshot?.tables ?? [])
  const rounds = Array.isArray(payload.rounds) ? payload.rounds : payload.round ? [payload.round] : []
  const sessionId = payload.sessionId ?? payload.session_id ?? null
  return {
    sessionId,
    tables,
    rounds,
    snapshotAt: payload.snapshotAt ?? payload.snapshot_at ?? new Date().toISOString(),
    status: {
      captureSource: 'cloud_browser',
      captureMode: 'cloud_browser',
      captureSessionId: sessionId,
      connected: Boolean(payload.connected ?? payload.status?.connected ?? tables.length > 0),
      authenticated: Boolean(payload.authenticated ?? payload.status?.authenticated ?? tables.length > 0),
      tableCount: tables.length,
      lastMessageAt: payload.lastMessageAt ?? payload.last_message_at ?? new Date().toISOString(),
      errorMessage: payload.errorMessage ?? payload.error_message ?? null,
      cloudReady: true,
    },
  }
}

export function createCloudCaptureClient({ url, state, writer = null, fetchImpl = globalThis.fetch, pollMs = DEFAULT_POLL_MS, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, requestRetries = DEFAULT_REQUEST_RETRIES, retryDelayMs = 250, adminKey = process.env.WORKER_ADMIN_KEY } = {}) {
  let timer = null
  let stopped = true

  async function tick() {
    if (!url) {
      state?.recordError?.('CLOUD_BROWSER_URL is missing')
      state?.setStatus?.({ captureSource: 'cloud_browser', captureMode: 'cloud_browser', connected: false, authenticated: false })
      return null
    }
    try {
      const response = await fetchWorkerSnapshot({ url, fetchImpl, timeoutMs, requestRetries, retryDelayMs, adminKey })
      if (!response?.ok) {
        const text = typeof response?.text === 'function' ? await response.text().catch(() => '') : ''
        throw new Error(`Cloud capture worker failed: ${response?.status ?? 'unknown'} ${text}`)
      }
      const body = await response.json()
      if (body?.buildVersion !== '098') throw new Error('version_mismatch: worker buildVersion must be 098')
      const parsed = parseCloudCapturePayload(body)
      try {
        await applyCloudCapturePayload({ parsed, state, writer })
      } catch (error) {
        const event = buildOperationalEvent({ component: 'supabase_writer', kind: 'persist_capture', message: error?.message ?? String(error) })
        state?.setStatus?.({ ...toStatusEvent(event), persistenceStatus: 'error', persistenceError: event.eventMessage })
        await writer?.writeOperationalEvent?.(event).catch(() => {})
      }
      return parsed
    } catch (error) {
      const event = buildOperationalEvent({ component: 'cloud_capture', kind: 'worker_snapshot', message: error?.message ?? String(error) })
      state?.recordError?.(event.eventMessage)
      state?.setStatus?.({ captureSource: 'cloud_browser', captureMode: 'cloud_browser', connected: false, authenticated: false, cloudReady: true, health: 'degraded', reason: event.eventMessage, ...toStatusEvent(event) })
      await writer?.writeOperationalEvent?.(event).catch(() => {})
      return null
    }
  }

  function start() {
    stopped = false
    state?.setStatus?.({ captureSource: 'cloud_browser', captureMode: 'cloud_browser', cloudReady: true, connected: false, authenticated: false })
    void tick()
    timer = setInterval(() => {
      if (!stopped) void tick()
    }, Math.max(500, Number(pollMs) || DEFAULT_POLL_MS))
    if (typeof timer?.unref === 'function') timer.unref()
  }

  function stop() {
    stopped = true
    if (timer) clearInterval(timer)
    timer = null
  }

  function isRunning() {
    return !stopped
  }

  return { start, stop, tick, isRunning }
}


async function fetchWorkerSnapshot({ url, fetchImpl, timeoutMs, requestRetries, retryDelayMs, adminKey }) {
  let lastError = null
  const attempts = Math.max(1, Number(requestRetries) || 1)
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timeout = controller ? setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS)) : null
    try {
      return await fetchImpl(url, { cache: 'no-store', redirect: 'error', signal: controller?.signal, headers: adminKey ? { 'x-worker-admin-key': adminKey } : undefined })
    } catch (error) {
      lastError = error
      if (attempt >= attempts || !isTransientWorkerError(error)) throw error
      await delay(Math.max(0, Number(retryDelayMs) || 0) * attempt)
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }
  throw lastError
}

function isTransientWorkerError(error) {
  return /timeout|abort|socket|reset|network|fetch failed|temporar/i.test(String(error?.message ?? error))
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function applyCloudCapturePayload({ parsed, state, writer }) {
  state?.setStatus?.(parsed.status)
  state?.setTables?.(parsed.tables)
  for (const round of parsed.rounds) state?.upsertRoundEvent?.(round)
  if (!writer?.configured) return
  const sessionId = parsed.sessionId ?? 'cloud-browser'
  await writer.writeCloudCaptureStatus?.({ sessionId, captureSource: 'cloud_browser', status: parsed.status })
  await writer.writeCloudTableSnapshot?.({ sessionId, tables: parsed.tables, status: parsed.status })
  for (const round of parsed.rounds) {
    const table = parsed.tables.find((item) => String(item.tableId) === String(round.tableId)) ?? { tableId: round.tableId }
    await writer.writeCloudRoundEvent?.({ sessionId, round, table })
  }
}

function normalizeCloudTables(tables) {
  const normalized = normalizeMtTables(tables)
  if (normalized.length || !Array.isArray(tables)) return normalized
  return tables.map((table, index) => ({
    tableId: table.tableId ?? table.table_id ?? String(index + 1),
    displayName: table.displayName ?? table.name ?? table.table_name ?? `MT百家樂第${index + 1}桌`,
    tableType: table.tableType ?? table.table_type ?? 'BAC',
    shoe: table.shoe ?? table.current_shoe ?? null,
    round: table.round ?? table.current_round ?? null,
    bankerCount: table.bankerCount ?? table.total_round_banker ?? 0,
    playerCount: table.playerCount ?? table.total_round_player ?? 0,
    tieCount: table.tieCount ?? table.total_round_tie ?? 0,
    bankerPairCount: table.bankerPairCount ?? table.total_round_banker_pair ?? 0,
    playerPairCount: table.playerPairCount ?? table.total_round_player_pair ?? 0,
    beadPlateRaw: table.beadPlateRaw ?? table.bead_plate2 ?? '',
    bigRoadRaw: table.bigRoadRaw ?? table.big2 ?? '',
    bigEyeRaw: table.bigEyeRaw ?? table.big_eye2 ?? '',
    smallRoadRaw: table.smallRoadRaw ?? table.small2 ?? '',
    cockroachRaw: table.cockroachRaw ?? table.cockroach2 ?? '',
    nextBankerRaw: table.nextBankerRaw ?? table.next_banker2 ?? null,
    nextPlayerRaw: table.nextPlayerRaw ?? table.next_player2 ?? null,
    dealerName: table.dealerName ?? table.dealer?.username ?? null,
    totalPlayers: table.totalPlayers ?? table.totalplayers ?? 0,
    roomId: table.roomId ?? table.room_id ?? null,
    state: table.state ?? null,
    orderState: table.orderState ?? table.order_state ?? null,
    sourceUpdatedAt: table.sourceUpdatedAt ?? table.updated_at ?? table.updatedAt ?? null,
  }))
}
