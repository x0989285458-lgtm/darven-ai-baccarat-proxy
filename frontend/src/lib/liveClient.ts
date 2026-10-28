import { dravenApiBaseUrl } from './apiBase'
import { frontendBuildMetadata } from './buildVersion'

export type LiveTable = {
  id: string | number
  table_id?: string | number
  name?: string
  table_name?: string
  table_type: string
  trend: {
    bead_plate2: string
    big2: string
    big_eye2?: string
    small2?: string
    cockroach2?: string
    current_round?: number
    current_shoe?: string | number
    total_round_banker?: number
    total_round_player?: number
    total_round_tie?: number
    total_round_banker_pair?: number
    total_round_player_pair?: number
    next_banker2?: unknown
    next_player2?: unknown
  }
  dealerName?: string | null
  totalPlayers?: number
  roomId?: string | number | null
  state?: string | number | null
  orderState?: string | number | null
  sourceUpdatedAt?: string | null
  buildVersion?: string | null
  prediction?: BackendPrediction
  publication?: unknown
  screenUnavailable?: boolean
}

export type SidePredictionKey = 'tie' | 'superSix' | 'bankerPair' | 'playerPair' | 'bankerDragon' | 'playerDragon'
export type BackendSidePredictions = Record<SidePredictionKey, number>
export type BackendSideActions = Record<SidePredictionKey, boolean>
export type MainPredictionReasonKey =
  | 'shoe_banker_player_bias'
  | 'ask_road_signals'
  | 'roadmap_trend_signals'
  | 'v8AskRoad'
  | 'v7RoadCycle'
  | 'shoeBankerPlayerBias'
  | 'uncommonRoadStructure'
  | 'recentPracticalCalibration'
export type MainPredictionSourceScores = { banker?: number; player?: number }
export type BackendPredictionReason = { key: MainPredictionReasonKey; text: string; weight: number }
export type BackendRoadCycleMain = { detected?: boolean; direction?: 'banker' | 'player'; reasonText?: string | null }
export type BackendPredictionDiagnostics = { roadCycles?: { main?: BackendRoadCycleMain } }
export type BackendPrediction = { source?: string; predictionId?: string; issuedAt?: string; strategyVersion: string; buildVersion?: string; targetTableId?: string | number; targetShoe?: string | number; targetRound?: number; predictedResult: 'banker' | 'player'; recommendation?: string; confidence: number; probabilities?: { banker?: number; player?: number; tie?: number }; scoreTotals?: { banker?: number; player?: number }; featureWeights?: Partial<Record<MainPredictionReasonKey | 'neutral_reserve', number>>; scoreSources?: Partial<Record<MainPredictionReasonKey | 'neutral_reserve' | 'recent_practical_calibration', MainPredictionSourceScores>>; diagnostics?: BackendPredictionDiagnostics; sidePredictions?: BackendSidePredictions; sideActions?: BackendSideActions }
export type SettledPrediction = { round: number; mainPredictedResult?: 'banker' | 'player'; predictedResult: 'banker' | 'player' | 'tie'; actualResult: 'banker' | 'player' | 'tie'; isHit: boolean; result?: 'hit' | 'miss' | 'uncalculated' }
export type RealCardRound = { round: number; result: 'banker' | 'player' | 'tie'; bankerPoint: number; playerPoint: number }
export type TableUiHistory = {
  ok: true
  buildVersion: string
  tableId: string
  shoe: string | number
  settledPredictions: SettledPrediction[]
  realCardRounds: RealCardRound[]
  realCardHistoryCompleteThroughRound: number
}

export class TableUiHistoryError extends Error {
  constructor(public readonly status: number) {
    super(`table ui-history ${status}`)
  }
}

type Status = { state: 'connecting' | 'connected' | 'error' | 'disconnected'; message: string }

class UnauthorizedStatusError extends Error {}
type LiveClientOptions = { memberSessionToken?: string; onTables: (tables: LiveTable[]) => void; onStatus: (status: Status) => void; onUnauthorized?: () => void }

type ProxyTable = {
  tableId?: string
  displayName?: string
  tableType?: string
  shoe?: number | null
  round?: number | null
  bankerCount?: number
  playerCount?: number
  tieCount?: number
  bankerPairCount?: number
  playerPairCount?: number
  nextBankerRaw?: unknown
  nextPlayerRaw?: unknown
  beadPlateRaw?: string
  bigRoadRaw?: string
  bigEyeRaw?: string
  smallRoadRaw?: string
  cockroachRaw?: string
  dealerName?: string | null
  totalPlayers?: number
  roomId?: string | number | null
  state?: string | number | null
  orderState?: string | number | null
  sourceUpdatedAt?: string | null
  buildVersion?: string | null
  prediction?: BackendPrediction
  publication?: unknown
  screenUnavailable?: boolean
}

const proxyApiUrl = dravenApiBaseUrl
const pollIntervalMs = Number(import.meta.env.VITE_DRAVEN_PROXY_POLL_MS ?? 5000)
const streamStaleMs = Number(import.meta.env.VITE_DRAVEN_STREAM_STALE_MS ?? 15000)
const liveTableMaxAgeMs = Number(import.meta.env.VITE_DRAVEN_TABLE_MAX_AGE_MS ?? 120000)
const liveReadTimeoutMs = 5000
const missingPredictionRefreshMs = 750
const missingPredictionRefreshLimit = 20
const CURRENT_STRATEGY_VERSION = frontendBuildMetadata.strategyVersion
const CURRENT_BUILD_VERSION = frontendBuildMetadata.buildVersion
const sidePredictionKeys: SidePredictionKey[] = ['tie', 'superSix', 'bankerPair', 'playerPair', 'bankerDragon', 'playerDragon']

export async function fetchTableUiHistory(tableId: string, memberSessionToken: string, signal?: AbortSignal): Promise<TableUiHistory> {
  const response = await fetch(`${proxyApiUrl}/api/tables/${encodeURIComponent(tableId)}/ui-history`, {
    cache: 'no-store',
    headers: { Authorization: `Bearer ${memberSessionToken}` },
    signal,
  })
  if (!response.ok) throw new TableUiHistoryError(response.status)
  const payload = await response.json()
  if (!payload?.ok || !Array.isArray(payload.settledPredictions) || !Array.isArray(payload.realCardRounds)) {
    throw new TableUiHistoryError(503)
  }
  return payload as TableUiHistory
}

export class LiveRoadClient {
  private timer?: number
  private streamAbort?: AbortController
  private reconnectTimer?: number
  private streamWatchdog?: number
  private pollPromise?: Promise<void>
  private pollAbort?: AbortController
  private predictionPollPromise?: Promise<void>
  private predictionPollAbort?: AbortController
  private tablesReadPromise?: Promise<LiveTable[]>
  private tablesReadAbort?: AbortController
  private connectionGeneration = 0
  private lastTablesAt = 0
  private lastStreamAt = 0
  private lastRecoveryAt = -Infinity
  private readonly recoverConnection = () => {
    if (this.stopped || this.authorizationLost || Date.now() - this.lastRecoveryAt < 1000) return
    this.lastRecoveryAt = Date.now()
    void this.connectStream()
    void this.poll()
  }
  private readonly recoverVisibleConnection = () => {
    if (document.visibilityState === 'visible') this.recoverConnection()
  }
  private stopped = true
  private authorizationLost = false
  private tablesSuppressed = false
  private readonly sourceUpdatedAtByTable = new Map<string, number>()
  private readonly acceptedTableById = new Map<string, LiveTable>()
  private readonly publicationFenceByTable = new Map<string, { revision: number; capturedAt: number; revoked: boolean; observation: PublicationObservation | null; sticky: boolean; prediction?: string }>()
  private readonly observationByTable = new Map<string, PublicationObservation>()
  private readonly invalidObservationDomain = new Set<string>()
  private readonly missingPredictionRefreshAttempts = new Map<string, number>()

  constructor(private readonly options: LiveClientOptions) {}

  connect() {
    this.disconnect(false)
    this.stopped = false
    this.authorizationLost = false
    this.lastTablesAt = Date.now()
    window.addEventListener('online', this.recoverConnection)
    window.addEventListener('pageshow', this.recoverConnection)
    document.addEventListener('visibilitychange', this.recoverVisibleConnection)
    this.options.onStatus({ state: 'connecting', message: '正在建立即時同步…' })
    void this.connectStream()
    this.streamWatchdog = window.setInterval(() => {
      if (this.stopped) return
      if (Date.now() - this.lastStreamAt >= streamStaleMs) void this.connectStream()
      if (!this.lastTablesAt || Date.now() - this.lastTablesAt >= streamStaleMs) void this.poll()
    }, pollIntervalMs)
  }

  disconnect(notify = true) {
    this.stopped = true
    window.removeEventListener('online', this.recoverConnection)
    window.removeEventListener('pageshow', this.recoverConnection)
    document.removeEventListener('visibilitychange', this.recoverVisibleConnection)
    this.lastRecoveryAt = -Infinity
    this.connectionGeneration += 1
    this.pollPromise = undefined
    this.pollAbort?.abort()
    this.pollAbort = undefined
    this.predictionPollPromise = undefined
    this.predictionPollAbort?.abort()
    this.predictionPollAbort = undefined
    this.tablesReadPromise = undefined
    this.tablesReadAbort?.abort()
    this.tablesReadAbort = undefined
    if (this.timer) window.clearTimeout(this.timer)
    if (this.streamWatchdog) window.clearInterval(this.streamWatchdog)
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer)
    this.streamAbort?.abort()
    this.timer = undefined
    this.streamWatchdog = undefined
    this.reconnectTimer = undefined
    this.streamAbort = undefined
    this.lastTablesAt = 0
    this.missingPredictionRefreshAttempts.clear()
    if (notify) this.options.onStatus({ state: 'disconnected', message: '已停止讀取雲端資料' })
  }

  private async connectStream() {
    if (this.stopped || this.authorizationLost) return
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.streamAbort?.abort()
    const controller = new AbortController()
    this.streamAbort = controller
    this.lastStreamAt = Date.now()
    const generation = this.connectionGeneration
    const isCurrent = () => !this.stopped && !controller.signal.aborted
      && generation === this.connectionGeneration && this.streamAbort === controller
    try {
      const headers = this.options.memberSessionToken ? { Authorization: `Bearer ${this.options.memberSessionToken}` } : undefined
      const response = await fetch(`${proxyApiUrl}/api/tables/stream`, { cache: 'no-store', headers, signal: controller.signal })
      if (!isCurrent()) {
        void response.body?.cancel().catch(() => {})
        return
      }
      if (response.status === 401) {
        this.handleUnauthorized()
        return
      }
      if (!response.ok || !response.body) throw new Error(`stream ${response.status}`)
      await consumeSseStream(response.body, (event, data) => {
        if (!isCurrent()) return
        this.lastStreamAt = Date.now()
        if (event === 'unauthorized') {
          this.handleUnauthorized()
          this.streamAbort?.abort()
          return
        }
        if (event === 'heartbeat') {
          void this.poll()
          return
        }
        if (event === 'error') {
          this.suppressAcceptedTables()
          this.options.onStatus({ state: 'error', message: '桌況同步中' })
          return
        }
        if (event !== 'tables') return
        this.lastTablesAt = Date.now()
        const payload = JSON.parse(data)
        const tables = normalizeProxyTables(Array.isArray(payload?.tables) ? payload.tables : [])
        this.publishTables(tables, `SSE ${tables.length}`)
      })
      if (isCurrent()) this.scheduleStreamReconnect()
    } catch {
      if (!isCurrent()) return
      await this.poll()
      if (isCurrent()) this.scheduleStreamReconnect()
    }
  }

  private scheduleStreamReconnect() {
    if (this.stopped || this.reconnectTimer) return
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined
      if (!this.stopped) void this.connectStream()
    }, 2000)
  }

  private poll(tablesOnly = false) {
    if (this.stopped) return Promise.resolve()
    const key = tablesOnly ? 'predictionPollPromise' : 'pollPromise'
    if (this[key]) return this[key]
    const generation = this.connectionGeneration
    const active = this.pollOnce(generation, tablesOnly)
    this[key] = active
    void active.finally(() => {
      if (this[key] === active) this[key] = undefined
    })
    return active
  }

  private readTables() {
    if (this.tablesReadPromise) return this.tablesReadPromise
    const controller = new AbortController()
    this.tablesReadAbort = controller
    const active = withLiveReadDeadline(controller, async () => {
      const headers = this.options.memberSessionToken ? { Authorization: `Bearer ${this.options.memberSessionToken}` } : undefined
      const response = await fetch(`${proxyApiUrl}/api/tables`, { cache: 'no-store', headers, signal: controller.signal })
      if (response.status === 401) throw new UnauthorizedStatusError()
      if (!response.ok) throw new Error(`proxy ${response.status}`)
      const payload = await response.json()
      return normalizeProxyTables(Array.isArray(payload) ? payload : [])
    })
    this.tablesReadPromise = active
    const release = () => {
      if (this.tablesReadPromise === active) this.tablesReadPromise = undefined
      if (this.tablesReadAbort === controller) this.tablesReadAbort = undefined
    }
    void active.then(release, release)
    return active
  }

  private async pollOnce(generation: number, tablesOnly: boolean) {
    if (this.stopped) return
    const controller = new AbortController()
    const abortKey = tablesOnly ? 'predictionPollAbort' : 'pollAbort'
    this[abortKey] = controller
    try {
      await withLiveReadDeadline(controller, async () => {
        const statusPromise = !tablesOnly && this.options.memberSessionToken
          ? readProxyStatus(this.options.memberSessionToken, controller.signal) : Promise.resolve<Status | null>(null)
        const [tables, proxyStatus] = await Promise.all([this.readTables(), statusPromise])
        if (this.stopped || generation !== this.connectionGeneration || controller.signal.aborted) return
        this.lastTablesAt = Date.now()
        if (proxyStatus && /stale|過期|建置版本不符/i.test(proxyStatus.message)) {
          this.suppressAcceptedTables()
          this.options.onStatus(proxyStatus)
          return
        }
        if (this.publishTables(tables, `雲端資料已連線（${tables.length}桌）`) || tablesOnly) return
        const fallbackStatus = proxyStatus ?? await readProxyStatus(undefined, controller.signal)
        if (this.stopped || generation !== this.connectionGeneration || controller.signal.aborted) return
        this.options.onStatus(fallbackStatus)
      })
    } catch (error) {
      if (this.stopped || generation !== this.connectionGeneration) return
      if (error instanceof UnauthorizedStatusError) {
        this.handleUnauthorized()
        return
      }
      this.suppressAcceptedTables()
      this.options.onStatus({ state: 'error', message: '雲端代理暫時無法讀取資料' })
    } finally {
      if (this[abortKey] === controller) this[abortKey] = undefined
    }
  }

  private suppressAcceptedTables() {
    this.tablesSuppressed = true
    this.options.onTables([])
  }

  private clearAcceptedTables() {
    this.acceptedTableById.clear()
    this.publicationFenceByTable.clear()
    this.observationByTable.clear()
    this.invalidObservationDomain.clear()
    this.sourceUpdatedAtByTable.clear()
    this.tablesSuppressed = false
    this.options.onTables([])
  }

  private publishTables(tables: LiveTable[], liveMessage: string) {
    // Compare visibility sets from the *active* SQL snapshot, not statement
    // start order. Wall time breaks ties only for equal snapshot visibility.
    tables = tables.filter(table => {
      const id = String(table.table_id ?? table.id ?? '')
      const observation = publicationObservation(table.publication)
      const previous = this.observationByTable.get(id)
      const order = observation && previous ? compareObservations(observation, previous) : undefined
      if (order === null) this.invalidObservationDomain.add(id)
      if (!this.invalidObservationDomain.has(id)) {
        if (order === -1 || (order === 0 && observation!.micros < previous!.micros)) return false
        if (observation != null) this.observationByTable.set(id, observation)
      }
      return true
    })
    const incomingTableIds = new Set(tables.map((table) => String(table.table_id ?? table.id ?? '')).filter(Boolean))
    let acceptedAny = false
    for (const [tableId, accepted] of this.acceptedTableById) {
      if (incomingTableIds.has(tableId) || !isLiveTableStale(accepted)) continue
      this.acceptedTableById.delete(tableId)
      acceptedAny = true
    }
    const freshTables = tables.filter((table) => !isLiveTableStale(table))
    for (const stale of tables.filter((table) => isLiveTableStale(table))) {
      const tableId = String(stale.table_id ?? stale.id ?? '')
      const revision = (stale.publication as TablePublication | null)?.revision
      const fence = this.publicationFenceByTable.get(tableId)
      if (fence && typeof revision === 'number' && Number.isSafeInteger(revision) && revision < fence.revision && !this.invalidObservationDomain.has(tableId)) continue
      if (fence || Object.hasOwn(stale, 'publication')) {
        const capturedAt = Date.parse(String((stale.publication as TablePublication | null)?.sourceCapturedAt ?? ''))
        this.publicationFenceByTable.set(tableId, {
          revision: Math.max(fence?.revision ?? -1, typeof revision === 'number' && Number.isSafeInteger(revision) ? revision : -1),
          capturedAt: Math.max(fence?.capturedAt ?? -Infinity, Number.isFinite(capturedAt) ? capturedAt : -Infinity),
          revoked: true,
          observation: publicationObservation(stale.publication),
          sticky: fence?.sticky === true || publicationObservation(stale.publication) == null,
          prediction: fence?.prediction,
        })
      }
      if (!tableId) continue
      if (stale.screenUnavailable) {
        this.acceptedTableById.set(tableId, unavailableTable(stale))
        acceptedAny = true
      } else if (this.acceptedTableById.delete(tableId)) acceptedAny = true
    }
    if (!freshTables.length) {
      if (acceptedAny || !this.acceptedTableById.size) this.options.onTables([...this.acceptedTableById.values()])
      this.options.onStatus({ state: 'error', message: '桌況時間無效或資料過期，已停止出手' })
      return false
    }
    for (const incoming of freshTables) {
      const tableId = String(incoming.table_id ?? incoming.id ?? '')
      if (!tableId) continue
      const timestamp = Date.parse(String(incoming.sourceUpdatedAt ?? ''))
      const previousTimestamp = this.sourceUpdatedAtByTable.get(tableId)
      const accepted = this.acceptedTableById.get(tableId)
      // Publication snapshots are atomic, including same-screen revocation.
      const fence = this.publicationFenceByTable.get(tableId)
      if (Object.hasOwn(incoming, 'publication') || fence) {
        const publication = incoming.publication as TablePublication | null | undefined
        const revision = typeof publication?.revision === 'number' && Number.isSafeInteger(publication.revision)
          && publication.revision >= 0 ? publication.revision : null
        if (fence && revision != null && revision < fence.revision && !this.invalidObservationDomain.has(tableId)) continue
        const capturedAt = typeof publication?.sourceCapturedAt === 'string' ? Date.parse(publication.sourceCapturedAt) : NaN
        const regressed = !!fence && (!Number.isFinite(capturedAt) || capturedAt < fence.capturedAt)
        const observation = publicationObservation(publication)
        const sameRevision = !!fence && (revision == null || revision === fence.revision)
        const prediction = JSON.stringify(incoming.prediction)
        const immutableConflict = sameRevision && !!fence?.prediction && incoming.prediction != null
          && prediction !== fence.prediction
        const identityConflict = sameRevision && !!accepted && !isSameTableIdentity(accepted, incoming)
        const sticky = (sameRevision && fence?.sticky === true) || observation == null || immutableConflict || identityConflict
        const observationOrder = observation && fence?.observation ? compareObservations(observation, fence.observation) : null
        // With identical visibility, only TTL evaluation can change readiness;
        // a strictly later DB statement time may clear a future-source gate.
        const observedRecovery = observation != null && fence?.observation != null
          && (observationOrder === 1 || (observationOrder === 0 && observation.micros > fence.observation.micros))
          && !sticky && !!accepted && isSameTableIdentity(accepted, incoming)
        const revoked = getBackendPredictionIssue(incoming) !== null || !Object.hasOwn(incoming, 'publication')
          || immutableConflict || this.invalidObservationDomain.has(tableId)
          || (observation == null && this.observationByTable.has(tableId))
          || regressed || !!(fence?.revoked && (revision == null || revision === fence.revision) && !observedRecovery)
        let next: LiveTable = { ...incoming, publication: incoming.publication, sourceUpdatedAt: previousTimestamp != null && timestamp < previousTimestamp
          ? new Date(previousTimestamp).toISOString() : incoming.sourceUpdatedAt }
        // A regressed capture cannot refresh a ready screen. Keep the prior
        // capture only as a revoked display, never as new freshness evidence.
        if (regressed && accepted) next = { ...accepted, publication: { ...(accepted.publication as TablePublication), state: 'unavailable', revision } }
        else if (revoked && getBackendPredictionIssue(next) === null) next = { ...next, publication: { ...publication, state: 'unavailable' } }
        if (revoked) next = unavailableTable(next)
        this.publicationFenceByTable.set(tableId, {
          revision: Math.max(fence?.revision ?? -1, revision ?? -1),
          capturedAt: Math.max(fence?.capturedAt ?? -Infinity, Number.isFinite(capturedAt) ? capturedAt : -Infinity),
          revoked,
          observation,
          sticky,
          prediction: sameRevision ? fence?.prediction ?? (!revoked ? prediction : undefined) : !revoked ? prediction : undefined,
        })
        this.sourceUpdatedAtByTable.set(tableId, Math.max(previousTimestamp ?? timestamp, timestamp))
        this.acceptedTableById.set(tableId, next)
        acceptedAny = true
        continue
      }
      if (previousTimestamp != null && timestamp < previousTimestamp) {
        const monotonicScreenAdvance = accepted && hasMonotonicAdvancedTableIdentity(accepted, incoming)
        if (monotonicScreenAdvance) {
          const advanced = { ...incoming, sourceUpdatedAt: accepted.sourceUpdatedAt }
          this.acceptedTableById.set(tableId, advanced)
          acceptedAny = true
          continue
        }
        const exactDurableEnrichment = accepted
          && getBackendPredictionIssue(accepted) !== null
          && isSameTableIdentity(accepted, incoming)
          && getBackendPredictionIssue(incoming) === null
        if (!exactDurableEnrichment) continue
        const enriched = { ...accepted, buildVersion: incoming.buildVersion, prediction: incoming.prediction }
        if (JSON.stringify(accepted) !== JSON.stringify(enriched)) {
          this.acceptedTableById.set(tableId, enriched)
          acceptedAny = true
        }
        continue
      }
      let next = incoming
      if (accepted && isSameTableIdentity(accepted, incoming)
        && incoming.prediction == null && incoming.buildVersion === accepted.buildVersion
        && getBackendPredictionIssue(accepted) === null) {
        next = { ...incoming, prediction: accepted.prediction }
      }
      if (accepted && previousTimestamp === timestamp && !hasAdvancedTableIdentity(accepted, incoming)) {
        const exactDurableEnrichment = getBackendPredictionIssue(accepted) !== null
          && isSameTableIdentity(accepted, incoming)
          && getBackendPredictionIssue(incoming) === null
        next = exactDurableEnrichment
          ? { ...accepted, buildVersion: incoming.buildVersion, prediction: incoming.prediction }
          : accepted
      }
      if (accepted && JSON.stringify(accepted) === JSON.stringify(next)) continue
      this.sourceUpdatedAtByTable.set(tableId, timestamp)
      this.acceptedTableById.set(tableId, next)
      acceptedAny = true
    }
    if (acceptedAny || this.tablesSuppressed) {
      const visibleTables = [...this.acceptedTableById.values()]
      this.options.onTables(visibleTables)
      if (visibleTables.length) this.tablesSuppressed = false
    }
    this.scheduleMissingPredictionRefresh()
    this.options.onStatus({ state: 'connected', message: liveMessage })
    return true
  }

  private scheduleMissingPredictionRefresh() {
    const missing = [...this.acceptedTableById.values()].filter((table) => (
      Number(table.trend.current_round) > 1 && getBackendPredictionIssue(table) !== null
    ))
    const missingKeys = new Set(missing.map(predictionRefreshIdentity))
    for (const key of this.missingPredictionRefreshAttempts.keys()) {
      if (!missingKeys.has(key)) this.missingPredictionRefreshAttempts.delete(key)
    }
    if (!missing.length) {
      if (this.timer) window.clearTimeout(this.timer)
      this.timer = undefined
      return
    }
    if (this.stopped || this.timer) return
    const retryable = missing.filter((table) => (
      (this.missingPredictionRefreshAttempts.get(predictionRefreshIdentity(table)) ?? 0) < missingPredictionRefreshLimit
    ))
    if (!retryable.length) return
    this.timer = window.setTimeout(() => {
      this.timer = undefined
      for (const table of retryable) {
        const key = predictionRefreshIdentity(table)
        this.missingPredictionRefreshAttempts.set(key, (this.missingPredictionRefreshAttempts.get(key) ?? 0) + 1)
      }
      void this.poll(true)
    }, retryable.some((table) => !this.missingPredictionRefreshAttempts.has(predictionRefreshIdentity(table)))
      ? 0 : missingPredictionRefreshMs)
  }

  private handleUnauthorized() {
    if (this.authorizationLost) return
    this.authorizationLost = true
    this.disconnect(false)
    this.clearAcceptedTables()
    this.options.onStatus({ state: 'error', message: '會員 Session 已失效，請重新登入' })
    this.options.onUnauthorized?.()
  }
}

function predictionRefreshIdentity(table: LiveTable) {
  return `${String(table.table_id ?? table.id ?? '')}:${String(table.trend.current_shoe ?? '')}:${Number(table.trend.current_round)}`
}

function hasMonotonicAdvancedTableIdentity(previous: LiveTable, incoming: LiveTable) {
  const previousShoeText = String(previous.trend.current_shoe ?? '')
  const incomingShoeText = String(incoming.trend.current_shoe ?? '')
  if (incomingShoeText === previousShoeText) {
    return Number(incoming.trend.current_round) > Number(previous.trend.current_round)
  }
  const previousShoe = Number(previousShoeText)
  const incomingShoe = Number(incomingShoeText)
  return Number.isSafeInteger(previousShoe)
    && Number.isSafeInteger(incomingShoe)
    && incomingShoe > previousShoe
}

// Revocation metadata is comparison authority only, never a visible screen.
function comparisonIdentity(table: LiveTable): PublicationIdentity | null {
  if (!table.screenUnavailable) return {
    tableId: table.table_id ?? table.id, shoe: table.trend.current_shoe ?? '', round: Number(table.trend.current_round),
  }
  const p = table.publication as TablePublication | null
  const raw = p?.rawIdentity
  if (!p || publicationObservation(p) == null || table.buildVersion !== CURRENT_BUILD_VERSION
    || typeof p.sourceCapturedAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(p.sourceCapturedAt)
    || !Number.isFinite(Date.parse(p.sourceCapturedAt))
    || !raw || !['string', 'number'].includes(typeof raw.tableId)
    || String(raw.tableId) !== String(table.table_id ?? table.id)
    || !['string', 'number'].includes(typeof raw.shoe) || !String(raw.shoe).trim()
    || (typeof raw.shoe === 'number' && !Number.isFinite(raw.shoe))
    || !Number.isSafeInteger(raw.round) || raw.round < 1) return null
  return raw
}

function isSameTableIdentity(previous: LiveTable, incoming: LiveTable) {
  const a = comparisonIdentity(previous), b = comparisonIdentity(incoming)
  return a != null && b != null && String(a.tableId) === String(b.tableId)
    && String(a.shoe) === String(b.shoe) && a.round === b.round
}

function unavailableTable(table: LiveTable): LiveTable {
  return {
    id: table.id, table_id: table.table_id, name: table.name, table_name: table.table_name,
    table_type: table.table_type, buildVersion: table.buildVersion, sourceUpdatedAt: table.sourceUpdatedAt,
    screenUnavailable: true, trend: { bead_plate2: '', big2: '' },
    ...(Object.hasOwn(table, 'publication') ? { publication: table.publication } : {}),
  }
}

function hasAdvancedTableIdentity(previous: LiveTable, incoming: LiveTable) {
  const previousShoe = String(previous.trend.current_shoe ?? '')
  const incomingShoe = String(incoming.trend.current_shoe ?? '')
  if (incomingShoe !== previousShoe) return true
  return Number(incoming.trend.current_round) > Number(previous.trend.current_round)
}

async function withLiveReadDeadline<T>(controller: AbortController, read: () => Promise<T>): Promise<T> {
  let abort!: () => void
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(new Error('live read aborted'))
    controller.signal.addEventListener('abort', abort, { once: true })
  })
  const timer = window.setTimeout(() => controller.abort(), liveReadTimeoutMs)
  try {
    return await Promise.race([read(), cancelled])
  } finally {
    window.clearTimeout(timer)
    controller.signal.removeEventListener('abort', abort)
    controller.abort()
  }
}

async function readProxyStatus(memberSessionToken?: string, signal?: AbortSignal): Promise<Status> {
  try {
    const headers = memberSessionToken ? { Authorization: `Bearer ${memberSessionToken}` } : undefined
    const response = await fetch(`${proxyApiUrl}/api/status`, { cache: 'no-store', headers, signal })
    if (response.status === 401 && memberSessionToken) throw new UnauthorizedStatusError()
    if (!response.ok) return { state: 'error', message: `proxy狀態讀取失敗 (${response.status})` }
    const status = await response.json()
    if (String(status.buildVersion ?? '') !== CURRENT_BUILD_VERSION) {
      return { state: 'error', message: '建置版本不符，預測暫不可用' }
    }
    if (typeof status.statusText === 'string' && status.statusText) {
      return { state: status.connected ? 'connected' : 'connecting', message: status.statusText }
    }
    const tableCount = Number(status.tableCount ?? (Array.isArray(status.tables) ? status.tables.length : 0))
    if (status.connected && status.authenticated && tableCount === 0) return { state: 'connecting', message: 'MT已驗證，等待桌況資料…' }
    if (status.connected && status.authenticated && tableCount > 0) return { state: 'connected', message: `已抓到${tableCount}桌` }
    if (status.connected && !status.authenticated) return { state: 'connecting', message: 'MT已連線，Token驗證中…' }
    if (status.connected === false) return { state: 'error', message: 'proxy已啟動，MT未連線，請確認 Token 是否過期' }
    return { state: 'connecting', message: 'proxy已啟動，等待 MT 桌況…' }
  } catch (error) {
    if (error instanceof UnauthorizedStatusError) throw error
    return { state: 'error', message: '雲端代理未啟動或無法讀取狀態' }
  }
}

export function isLiveTableStale(table: Pick<LiveTable, 'sourceUpdatedAt'> | { sourceUpdatedAt?: string | null }, now = Date.now(), maxAgeMs = liveTableMaxAgeMs) {
  if (!table.sourceUpdatedAt) return true
  const timestamp = Date.parse(table.sourceUpdatedAt)
  if (!Number.isFinite(timestamp)) return true
  return now - timestamp > Math.max(1000, Number(maxAgeMs) || 120000)
}

export function backendPredictionReasonsFromTable(table?: Pick<LiveTable, 'prediction'> | null): BackendPredictionReason[] {
  const prediction = table?.prediction
  if (!prediction || !['banker', 'player'].includes(prediction.predictedResult)) return []

  const direction = prediction.predictedResult
  const opposite = direction === 'banker' ? 'player' : 'banker'
  const directionLabel = direction === 'banker' ? '莊' : '閒'
  const configs: Array<{ key: MainPredictionReasonKey; label: string }> = [
    { key: 'shoe_banker_player_bias', label: '靴內莊閒偏態' },
    { key: 'ask_road_signals', label: '問路訊號' },
    { key: 'roadmap_trend_signals', label: '路單趨勢' },
    { key: 'v8AskRoad', label: '問路訊號' },
    { key: 'v7RoadCycle', label: '路單週期' },
    { key: 'shoeBankerPlayerBias', label: '靴內莊閒偏態' },
    { key: 'uncommonRoadStructure', label: '大路非常見結構' },
    { key: 'recentPracticalCalibration', label: '近期實戰校準' },
  ]

  return configs.flatMap(({ key, label }) => {
    const weight = Number(prediction.featureWeights?.[key])
    const scores = prediction.scoreSources?.[key]
    const supporting = Number(scores?.[direction])
    const opposing = Number(scores?.[opposite])
    if (!Number.isFinite(weight) || weight <= 0 || !Number.isFinite(supporting) || !Number.isFinite(opposing) || supporting <= opposing) return []
    const formalCycleReason = key === 'roadmap_trend_signals'
      && prediction.diagnostics?.roadCycles?.main?.detected
      && prediction.diagnostics.roadCycles.main.direction === direction
      ? prediction.diagnostics.roadCycles.main.reasonText
      : null
    return [{ key, text: formalCycleReason || `${label}支持${directionLabel}`, weight, influence: (supporting - opposing) * weight }]
  })
    .sort((left, right) => right.influence - left.influence)
    .slice(0, 3)
    .map(({ influence: _influence, ...reason }) => reason)
}

export function getBackendPredictionIssue(table?: LiveTable | null, now = Date.now()): string | null {
  if (table?.screenUnavailable) return '後端預測暫不可用'
  if (table && Object.hasOwn(table, 'publication') && !isReadyPublication(table, now)) return '後端預測暫不可用'
  const prediction = table?.prediction
  if (!prediction || prediction.source !== 'backend') return '後端預測暫不可用'
  if (prediction.strategyVersion !== CURRENT_STRATEGY_VERSION) return '策略版本不符'
  if (String(table?.buildVersion ?? '') !== CURRENT_BUILD_VERSION
    || String(prediction.buildVersion ?? '') !== CURRENT_BUILD_VERSION) return '建置版本不符'
  if (isLiveTableStale(table ?? {}, now)) return '資料過期'
  if (String(prediction.targetTableId ?? '') !== String(table?.table_id ?? table?.id ?? '')
    || String(prediction.targetShoe ?? '') !== String(table?.trend.current_shoe ?? '')
    || Number(prediction.targetRound) !== Number(table?.trend.current_round)) return '預測目標不符'
  if (!String(prediction.predictionId ?? '').trim() || !String(prediction.issuedAt ?? '').trim()) return '預測識別不完整'
  if (!['banker', 'player'].includes(prediction.predictedResult)
    || !Number.isFinite(Number(prediction.confidence))
    || !['banker', 'player', 'tie'].every((key) => Number.isFinite(Number(prediction.probabilities?.[key as 'banker' | 'player' | 'tie'])))) return '主預測資料不完整'
  if (!hasExactKeys(prediction.sidePredictions, sidePredictionKeys) || !sidePredictionKeys.every((key) => Number.isFinite(Number(prediction.sidePredictions?.[key])))) return '副預測六項不完整'
  if (!hasExactKeys(prediction.sideActions, sidePredictionKeys) || !sidePredictionKeys.every((key) => typeof prediction.sideActions?.[key] === 'boolean')) return '副預測六項 action 不完整'
  return null
}

type PublicationIdentity = { tableId: string | number; shoe: string | number; round: number }
export type TablePublication = {
  observedAtMicros?: string
  observation?: { epoch: string; snapshot: string } | null
  state: 'ready' | 'pending' | 'unavailable'
  revision: number | null
  publishedAt: string | null
  sourceCapturedAt: string
  rawIdentity: PublicationIdentity
  readyIdentity: (PublicationIdentity & { predictionId: string }) | null
}

type PublicationObservation = { epoch: string; xmax: bigint; xip: Set<bigint>; micros: bigint }
function publicationObservation(publication: unknown): PublicationObservation | null {
  const p = publication as TablePublication | null
  const stamp = p?.observedAtMicros, value = p?.observation
  if (typeof stamp !== 'string' || !/^[1-9][0-9]{0,19}$/.test(stamp)
    || !value || typeof value.epoch !== 'string' || !/^[a-f0-9]{64}$/.test(value.epoch)
    || typeof value.snapshot !== 'string' || value.snapshot.length > 65536) return null
  const parts = value.snapshot.split(':')
  if (parts.length !== 3) return null
  const entries = parts[2] === '' ? [] : parts[2].split(',')
  if (entries.length > 2048) return null
  const uint64 = (s: string) => /^[1-9][0-9]{0,19}$/.test(s) && BigInt(s) <= 18446744073709551615n
  if (![parts[0], parts[1], ...entries].every(uint64)) return null
  const xmin = BigInt(parts[0]), xmax = BigInt(parts[1]), xip = entries.map(BigInt)
  if (xmin < 3n || xmax < xmin || xip.some((x,i) => x < xmin || x >= xmax || (i > 0 && x <= xip[i-1]))) return null
  return { epoch:value.epoch, xmax, xip:new Set(xip), micros:BigInt(stamp) }
}

// V(s) = {x | x < xmax and x not in xip}. Inclusion is a causal
// partial order, not xid allocation order; a larger xmax alone is insufficient.
function compareObservations(a: PublicationObservation, b: PublicationObservation): -1 | 0 | 1 | null {
  if (a.epoch !== b.epoch) return null
  const includes = (later: PublicationObservation, earlier: PublicationObservation) => {
    // A smaller xmax can still describe the same visible set if the entire
    // additional interval in the other snapshot consists of in-progress XIDs.
    const coveredTail = later.xmax >= earlier.xmax || BigInt([...earlier.xip].filter(x => x >= later.xmax).length) === earlier.xmax - later.xmax
    return coveredTail && [...later.xip].every(x => x >= earlier.xmax || earlier.xip.has(x))
  }
  const ab = includes(a,b), ba = includes(b,a)
  return ab && ba ? 0 : ab ? 1 : ba ? -1 : null
}

function isReadyPublication(table: LiveTable, now: number) {
  const p = table.publication as TablePublication | null
  const iso = (value: unknown) => typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value))
  if (!p || p.state !== 'ready' || !Number.isSafeInteger(p.revision) || Number(p.revision) < 0
    || ((Object.hasOwn(p, 'observedAtMicros') || Object.hasOwn(p, 'observation')) && publicationObservation(p) == null)
    || !iso(p.publishedAt) || !iso(p.sourceCapturedAt)
    || isLiveTableStale({ sourceUpdatedAt: p.sourceCapturedAt }, now)) return false
  const matches = (identity: PublicationIdentity | null) => identity != null
    && ['string', 'number'].includes(typeof identity.tableId)
    && ['string', 'number'].includes(typeof identity.shoe)
    && String(identity.tableId).trim().length > 0 && String(identity.shoe).trim().length > 0
    && (typeof identity.tableId !== 'number' || Number.isFinite(identity.tableId))
    && (typeof identity.shoe !== 'number' || Number.isFinite(identity.shoe))
    && String(identity.tableId) === String(table.table_id ?? table.id)
    && String(identity.shoe) === String(table.trend.current_shoe)
    && Number.isSafeInteger(identity.round) && identity.round === table.trend.current_round
  return matches(p.rawIdentity) && matches(p.readyIdentity)
    && typeof p.readyIdentity?.predictionId === 'string' && !!p.readyIdentity.predictionId.trim()
    && p.readyIdentity.predictionId === table.prediction?.predictionId
}

function hasExactKeys(value: unknown, keys: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const expected = [...keys].sort()
  const actual = Object.keys(value as Record<string, unknown>).sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

async function consumeSseStream(stream: ReadableStream<Uint8Array>, onEvent: (event: string, data: string) => void) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n')
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const lines = block.split('\n')
        const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() ?? 'message'
        const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
        if (data) onEvent(event, data)
        boundary = buffer.indexOf('\n\n')
      }
      if (done) break
    }
  } finally {
    reader.releaseLock()
  }
}

function normalizeProxyTables(tables: ProxyTable[]): LiveTable[] {
  return tables.map((table, index) => {
    const tableName = table.displayName?.match(/第(.+?)桌/)?.[1] ?? String(index + 1)
    const normalized: LiveTable = {
      id: table.tableId ?? tableName ?? index + 1,
      table_id: table.tableId ?? tableName ?? index + 1,
      table_name: tableName,
      name: table.displayName ?? `MT百家樂第${tableName}桌`,
      table_type: table.tableType ?? 'BAC',
      trend: {
        bead_plate2: table.beadPlateRaw ?? '',
        big2: table.bigRoadRaw ?? '',
        big_eye2: table.bigEyeRaw ?? '',
        small2: table.smallRoadRaw ?? '',
        cockroach2: table.cockroachRaw ?? '',
        current_round: table.round ?? 0,
        current_shoe: table.shoe ?? 0,
        total_round_banker: table.bankerCount ?? 0,
        total_round_player: table.playerCount ?? 0,
        total_round_tie: table.tieCount ?? 0,
        total_round_banker_pair: table.bankerPairCount ?? 0,
        total_round_player_pair: table.playerPairCount ?? 0,
        next_banker2: table.nextBankerRaw ?? null,
        next_player2: table.nextPlayerRaw ?? null,
      },
      dealerName: table.dealerName ?? null,
      totalPlayers: table.totalPlayers ?? 0,
      roomId: table.roomId ?? null,
      state: table.state ?? null,
      orderState: table.orderState ?? null,
      sourceUpdatedAt: table.sourceUpdatedAt ?? null,
      buildVersion: table.buildVersion ?? null,
      prediction: table.prediction,
      ...(Object.hasOwn(table, 'publication') ? { publication: table.publication } : {}),
    }
    return table.screenUnavailable === true ? unavailableTable(normalized) : normalized
  })
}
