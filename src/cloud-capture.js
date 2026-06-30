import { normalizeMtTables } from './normalize-table.js'

const DEFAULT_POLL_MS = 2000

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

export function createCloudCaptureClient({ url, state, writer = null, fetchImpl = globalThis.fetch, pollMs = DEFAULT_POLL_MS } = {}) {
  let timer = null
  let stopped = true

  async function tick() {
    if (!url) {
      state?.recordError?.('CLOUD_BROWSER_URL is missing')
      state?.setStatus?.({ captureSource: 'cloud_browser', captureMode: 'cloud_browser', connected: false, authenticated: false })
      return null
    }
    try {
      const response = await fetchImpl(url, { cache: 'no-store' })
      if (!response?.ok) {
        const text = typeof response?.text === 'function' ? await response.text().catch(() => '') : ''
        throw new Error(`Cloud capture worker failed: ${response?.status ?? 'unknown'} ${text}`)
      }
      const body = await response.json()
      const parsed = parseCloudCapturePayload(body)
      state?.setStatus?.(parsed.status)
      state?.setTables?.(parsed.tables)
      for (const round of parsed.rounds) state?.upsertRoundEvent?.(round)
      await persistParsedCapture({ parsed, writer })
      return parsed
    } catch (error) {
      state?.recordError?.(redactSecrets(error?.message ?? String(error)))
      state?.setStatus?.({ captureSource: 'cloud_browser', captureMode: 'cloud_browser', connected: false, authenticated: false, cloudReady: true })
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

async function persistParsedCapture({ parsed, writer }) {
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
    beadPlateRaw: table.beadPlateRaw ?? table.bead_plate2 ?? '',
    bigRoadRaw: table.bigRoadRaw ?? table.big2 ?? '',
  }))
}

function redactSecrets(message = '') {
  return String(message)
    .replace(/token=([^\s&]+)/gi, 'token=[redacted]')
    .replace(/secret=([^\s&]+)/gi, 'secret=[redacted]')
    .replace(/(sb_secret_[A-Za-z0-9._-]+)/g, '[redacted]')
}
