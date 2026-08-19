import { normalizeMtTables } from './normalize-table.js'
import { buildOperationalEvent, toStatusEvent } from './event-layer.js'

const DEFAULT_POLL_MS = 5000
const DEFAULT_REQUEST_TIMEOUT_MS = 15000
const DEFAULT_REQUEST_RETRIES = 2

export const PRODUCTION_TABLE_IDS = Object.freeze(['BAG01', 'BAG02', 'BAG03', 'BAG03A', 'BAG05', 'BAG06', 'BAG07', 'BAG08', 'BAG09', 'BAG10'])
const PRODUCTION_TABLE_ORDER = new Map(PRODUCTION_TABLE_IDS.map((tableId, index) => [tableId, index]))
const settlementTailsByState = new WeakMap()

function withFormalSettlementTail(state, task) {
  if (!state || (typeof state !== 'object' && typeof state !== 'function')) return Promise.resolve().then(task)
  const previous = settlementTailsByState.get(state) ?? Promise.resolve()
  const current = previous.catch(() => {}).then(task)
  settlementTailsByState.set(state, current)
  return current.finally(() => {
    if (settlementTailsByState.get(state) === current) settlementTailsByState.delete(state)
  })
}

export function parseCloudCapturePayload(payload = {}, receivedAt = new Date().toISOString()) {
  const tables = selectProductionTables(normalizeCloudTables(payload.tables ?? payload.snapshot?.tables ?? []))
    .map((table) => ({ ...table, sourceUpdatedAt: table.sourceUpdatedAt ?? receivedAt }))
  const rawRounds = Array.isArray(payload.rounds) ? payload.rounds : payload.round ? [payload.round] : []
  const rounds = selectProductionRounds(rawRounds)
  const sessionId = payload.sessionId ?? payload.session_id ?? null
  return {
    sessionId,
    tables,
    rounds,
    snapshotAt: receivedAt,
    status: {
      captureSource: 'cloud_browser',
      captureMode: 'cloud_browser',
      captureSessionId: sessionId,
      connected: Boolean(payload.connected ?? payload.status?.connected ?? tables.length > 0),
      authenticated: Boolean(payload.authenticated ?? payload.status?.authenticated ?? tables.length > 0),
      tableCount: tables.length,
      lastMessageAt: receivedAt,
      ...(rounds.length > 0 ? { lastRoundAt: receivedAt } : {}),
      errorMessage: payload.errorMessage ?? payload.error_message ?? null,
      cloudReady: true,
    },
  }
}

export function createCloudCaptureClient({ url, state, writer = null, v100Formal = null, fetchImpl = globalThis.fetch, pollMs = DEFAULT_POLL_MS, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, requestRetries = DEFAULT_REQUEST_RETRIES, retryDelayMs = 250, adminKey = process.env.WORKER_ADMIN_KEY } = {}) {
  let timer = null
  let stopped = true
  let tickInFlight = null

  async function runTick() {
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
      if (body?.buildVersion !== '105') throw new Error('version_mismatch: worker buildVersion must be 105')
      const parsed = parseCloudCapturePayload(body)
      try {
        await applyCloudCapturePayload({ parsed, state, writer, v100Formal })
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

  function tick() {
    if (tickInFlight) return tickInFlight
    tickInFlight = runTick().finally(() => {
      tickInFlight = null
    })
    return tickInFlight
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

async function runDurableStage(stage, operation) {
  try {
    return await operation()
  } catch (error) {
    throw new Error(`${stage}: ${String(error?.message ?? error)}`, { cause: error })
  }
}

export async function applyCloudCapturePayload({ parsed, state, writer, v100Formal = null, persistAncillary = true }) {
  parsed = canonicalizeFormalRoundSources(parsed)
  const durableTimings = {}
  const rankEligibleRounds = []
  const preflights = await Promise.all(parsed.rounds.map((round) => state?.preflightRoundEvent?.(round)))
  for (let index = 0; index < parsed.rounds.length; index += 1) {
    const preflight = preflights[index]
    if (preflight?.ok === false) throw preflight.error ?? new Error('formal settlement preflight failed before ingest acknowledgement')
    if (preflight?.value?.formalRankEligible !== false) rankEligibleRounds.push(parsed.rounds[index])
  }
  const preflightDecisions = new Map(parsed.rounds.map((round, index) => [round, preflights[index]?.value]))
  let v100Result = null
  if (v100Formal?.enabled === true && rankEligibleRounds.length > 0) {
    const startedAt = Date.now()
    try {
      v100Result = await runDurableStage('durable_rank_ledger', () => v100Formal.processSnapshot({ tables: parsed.tables, rounds: rankEligibleRounds }))
    } catch (error) {
      state?.setStatus?.({ v104RuntimeStatus: 'error', v104RuntimeError: String(error?.message ?? error) })
      throw error
    } finally {
      durableTimings.rankLedgerMs = Date.now() - startedAt
    }
  }
  const formalTables = Array.isArray(v100Result?.tables) ? v100Result.tables : parsed.tables
  state?.setStatus?.(parsed.status)
  state?.setTables?.(formalTables, { notify: false })
  const roundsByTable = new Map()
  for (const round of parsed.rounds) {
    const tableId = String(round?.tableId ?? '')
    if (!roundsByTable.has(tableId)) roundsByTable.set(tableId, [])
    roundsByTable.get(tableId).push(round)
  }
  const settlementStartedAt = Date.now()
  await runDurableStage('durable_formal_settlement', () => withFormalSettlementTail(state, async () => {
    for (const [, tableRounds] of roundsByTable.entries()) {
      const shoeOrder = new Map()
      for (const round of tableRounds) {
        const shoe = String(round?.shoe ?? '')
        if (!shoeOrder.has(shoe)) shoeOrder.set(shoe, shoeOrder.size)
      }
      tableRounds.sort((left, right) => {
        const shoeDelta = shoeOrder.get(String(left?.shoe ?? '')) - shoeOrder.get(String(right?.shoe ?? ''))
        return shoeDelta || Number(left?.round) - Number(right?.round)
      })
      for (const round of tableRounds) {
        const settlement = await state?.upsertRoundEvent?.(round, { preflight: preflightDecisions.get(round) })
        if (settlement?.ok === false) throw settlement.error ?? new Error('formal settlement failed before ingest acknowledgement')
      }
      await new Promise((resolve) => setImmediate(resolve))
    }
  }))
  durableTimings.formalSettlementMs = Date.now() - settlementStartedAt
  state?.notifyTablesUpdated?.()

  if (!writer?.configured || !persistAncillary) return {
    v100Formal: v100Result,
    tables: structuredClone(formalTables),
    rounds: structuredClone(parsed.rounds),
    durableTimings,
  }
  const sessionId = parsed.sessionId ?? 'cloud-browser'
  const ancillaryStartedAt = Date.now()
  const ancillaryWrites = [
    runDurableStage('durable_capture_status', () => writer.writeCloudCaptureStatus?.({ sessionId, captureSource: 'cloud_browser', status: parsed.status })),
    runDurableStage('durable_table_snapshot', () => writer.writeCloudTableSnapshot?.({ sessionId, tables: formalTables, status: parsed.status })),
  ]
  for (let offset = 0; offset < parsed.rounds.length; offset += 5) {
    const batch = parsed.rounds.slice(offset, offset + 5)
    const payloads = batch.map((round) => ({
      sessionId,
      round,
      table: formalTables.find((item) => String(item.tableId) === String(round.tableId)) ?? { tableId: round.tableId },
    }))
    await runDurableStage('durable_round_events', () => writer.writeCloudRoundEvents
      ? writer.writeCloudRoundEvents(payloads)
      : Promise.all(payloads.map((payload) => writer.writeCloudRoundEvent?.(payload))))
  }
  await Promise.all(ancillaryWrites)
  durableTimings.ancillaryMs = Date.now() - ancillaryStartedAt
  durableTimings.totalMs = Number(durableTimings.rankLedgerMs ?? 0) + Number(durableTimings.formalSettlementMs ?? 0) + Number(durableTimings.ancillaryMs ?? 0)
  return {
    v100Formal: v100Result,
    tables: structuredClone(formalTables),
    rounds: structuredClone(parsed.rounds),
    durableTimings,
  }
}

function canonicalizeFormalRoundSources(parsed = {}) {
  return {
    ...parsed,
    rounds: Array.isArray(parsed.rounds)
      ? parsed.rounds.map((round) => ({ ...structuredClone(round), source: 'ofalive99' }))
      : [],
  }
}

export function canonicalProductionTableId(value) {
  const id = String(value ?? '').trim().toUpperCase()
  const match = id.match(/^BAG(\d{1,2})(A?)$/)
  if (!match) return id
  return `BAG${match[1].padStart(2, '0')}${match[2]}`
}

function isProductionTable(value) {
  return PRODUCTION_TABLE_ORDER.has(canonicalProductionTableId(value))
}

function selectProductionTables(tables = []) {
  const byId = new Map()
  for (const table of tables) {
    const tableId = canonicalProductionTableId(table?.tableId)
    if (isProductionTable(tableId) && !byId.has(tableId)) byId.set(tableId, { ...table, tableId })
  }
  return PRODUCTION_TABLE_IDS.flatMap((tableId) => byId.has(tableId) ? [byId.get(tableId)] : [])
}

function selectProductionRounds(rounds = []) {
  const selected = []
  const seen = new Set()
  for (const round of rounds) {
    const tableId = canonicalProductionTableId(round?.tableId ?? round?.table_id)
    if (!isProductionTable(tableId)) continue
    const normalized = { ...round, tableId }
    const hasIdentity = round?.shoe != null && round?.shoe !== '' && round?.round != null && round?.round !== ''
    const key = hasIdentity ? `${tableId}:${round.shoe}:${round.round}` : null
    if (key && seen.has(key)) continue
    if (key) seen.add(key)
    selected.push(normalized)
  }
  return selected
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
