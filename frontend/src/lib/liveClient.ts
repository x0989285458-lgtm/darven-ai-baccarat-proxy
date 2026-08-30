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
}

const proxyApiUrl = dravenApiBaseUrl
const pollIntervalMs = Number(import.meta.env.VITE_DRAVEN_PROXY_POLL_MS ?? 5000)
const streamStaleMs = Number(import.meta.env.VITE_DRAVEN_STREAM_STALE_MS ?? 15000)
const liveTableMaxAgeMs = Number(import.meta.env.VITE_DRAVEN_TABLE_MAX_AGE_MS ?? 120000)
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
  private connectionGeneration = 0
  private lastTablesAt = 0
  private stopped = true
  private authorizationLost = false
  private tablesSuppressed = false
  private readonly sourceUpdatedAtByTable = new Map<string, number>()
  private readonly acceptedTableById = new Map<string, LiveTable>()
  private readonly missingPredictionRefreshAttempts = new Map<string, number>()

  constructor(private readonly options: LiveClientOptions) {}

  connect() {
    this.disconnect(false)
    this.stopped = false
    this.authorizationLost = false
    this.lastTablesAt = Date.now()
    this.options.onStatus({ state: 'connecting', message: '正在建立即時同步…' })
    void this.connectStream()
    this.streamWatchdog = window.setInterval(() => {
      if (this.stopped) return
      if (!this.lastTablesAt || Date.now() - this.lastTablesAt >= streamStaleMs) void this.poll()
    }, pollIntervalMs)
  }

  disconnect(notify = true) {
    this.stopped = true
    this.connectionGeneration += 1
    this.pollPromise = undefined
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
    this.streamAbort?.abort()
    const controller = new AbortController()
    this.streamAbort = controller
    try {
      const headers = this.options.memberSessionToken ? { Authorization: `Bearer ${this.options.memberSessionToken}` } : undefined
      const response = await fetch(`${proxyApiUrl}/api/tables/stream`, { cache: 'no-store', headers, signal: controller.signal })
      if (response.status === 401) {
        this.handleUnauthorized()
        return
      }
      if (!response.ok || !response.body) throw new Error(`stream ${response.status}`)
      await consumeSseStream(response.body, (event, data) => {
        if (this.stopped) return
        if (event === 'unauthorized') {
          this.handleUnauthorized()
          this.streamAbort?.abort()
          return
        }
        if (event === 'heartbeat') {
          void this.poll()
          return
        }
        if (event !== 'tables') return
        this.lastTablesAt = Date.now()
        const payload = JSON.parse(data)
        const tables = normalizeProxyTables(Array.isArray(payload?.tables) ? payload.tables : [])
        this.publishTables(tables, `SSE ${tables.length}`)
      })
      if (!this.stopped) this.scheduleStreamReconnect()
    } catch {
      if (this.stopped || controller.signal.aborted) return
      await this.poll()
      this.scheduleStreamReconnect()
    }
  }

  private scheduleStreamReconnect() {
    if (this.stopped || this.reconnectTimer) return
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined
      if (!this.stopped) void this.connectStream()
    }, 2000)
  }

  private poll() {
    if (this.stopped) return Promise.resolve()
    if (this.pollPromise) return this.pollPromise
    const generation = this.connectionGeneration
    const active = this.pollOnce(generation)
    this.pollPromise = active
    void active.finally(() => {
      if (this.pollPromise === active) this.pollPromise = undefined
    })
    return active
  }

  private async pollOnce(generation: number) {
    if (this.stopped) return
    try {
      const headers = this.options.memberSessionToken ? { Authorization: `Bearer ${this.options.memberSessionToken}` } : undefined
      const statusPromise = this.options.memberSessionToken ? readProxyStatus(this.options.memberSessionToken) : Promise.resolve<Status | null>(null)
      const [response, proxyStatus] = await Promise.all([
        fetch(`${proxyApiUrl}/api/tables`, { cache: 'no-store', headers }),
        statusPromise,
      ])
      if (this.stopped || generation !== this.connectionGeneration) return
      if (response.status === 401) {
        this.handleUnauthorized()
        return
      }
      if (!response.ok) throw new Error(`proxy ${response.status}`)
      const payload = await response.json()
      if (this.stopped || generation !== this.connectionGeneration) return
      const tables = normalizeProxyTables(Array.isArray(payload) ? payload : [])
      this.lastTablesAt = Date.now()
      if (proxyStatus && /stale|過期|建置版本不符/i.test(proxyStatus.message)) {
        this.suppressAcceptedTables()
        this.options.onStatus(proxyStatus)
        return
      }
      if (this.publishTables(tables, `雲端資料已連線（${tables.length}桌）`)) return
      const fallbackStatus = proxyStatus ?? await readProxyStatus()
      if (this.stopped || generation !== this.connectionGeneration) return
      this.options.onStatus(fallbackStatus)
    } catch (error) {
      if (this.stopped || generation !== this.connectionGeneration) return
      if (error instanceof UnauthorizedStatusError) {
        this.handleUnauthorized()
        return
      }
      this.suppressAcceptedTables()
      this.options.onStatus({ state: 'error', message: '雲端代理暫時無法讀取資料' })
    }
  }

  private suppressAcceptedTables() {
    this.tablesSuppressed = true
    this.options.onTables([])
  }

  private clearAcceptedTables() {
    this.acceptedTableById.clear()
    this.sourceUpdatedAtByTable.clear()
    this.tablesSuppressed = false
    this.options.onTables([])
  }

  private publishTables(tables: LiveTable[], liveMessage: string) {
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
      if (!tableId || !this.acceptedTableById.delete(tableId)) continue
      acceptedAny = true
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
      if (previousTimestamp != null && timestamp < previousTimestamp) {
        const monotonicScreenAdvance = accepted && hasMonotonicAdvancedTableIdentity(accepted, incoming)
        if (monotonicScreenAdvance) {
          const advanced = { ...incoming, sourceUpdatedAt: accepted.sourceUpdatedAt }
          this.acceptedTableById.set(tableId, advanced)
          acceptedAny = true
          continue
        }
        const exactDurableEnrichment = accepted
          && !accepted.prediction
          && Boolean(incoming.prediction)
          && isSameTableIdentity(accepted, incoming)
          && getBackendPredictionIssue(incoming) === null
        if (!exactDurableEnrichment) continue
        const enriched = { ...accepted, prediction: incoming.prediction }
        if (JSON.stringify(accepted) !== JSON.stringify(enriched)) {
          this.acceptedTableById.set(tableId, enriched)
          acceptedAny = true
        }
        continue
      }
      let next = incoming
      if (accepted && previousTimestamp === timestamp && !hasAdvancedTableIdentity(accepted, incoming)) {
        next = !accepted.prediction && incoming.prediction
          ? { ...accepted, prediction: incoming.prediction }
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
      void this.poll()
    }, missingPredictionRefreshMs)
  }

  private handleUnauthorized() {
    this.clearAcceptedTables()
    this.options.onStatus({ state: 'error', message: '會員 Session 已失效，請重新登入' })
    if (this.authorizationLost) return
    this.authorizationLost = true
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

function isSameTableIdentity(previous: LiveTable, incoming: LiveTable) {
  return String(incoming.table_id ?? incoming.id ?? '') === String(previous.table_id ?? previous.id ?? '')
    && String(incoming.trend.current_shoe ?? '') === String(previous.trend.current_shoe ?? '')
    && Number(incoming.trend.current_round) === Number(previous.trend.current_round)
}

function hasAdvancedTableIdentity(previous: LiveTable, incoming: LiveTable) {
  const previousShoe = String(previous.trend.current_shoe ?? '')
  const incomingShoe = String(incoming.trend.current_shoe ?? '')
  if (incomingShoe !== previousShoe) return true
  return Number(incoming.trend.current_round) > Number(previous.trend.current_round)
}

async function readProxyStatus(memberSessionToken?: string): Promise<Status> {
  try {
    const headers = memberSessionToken ? { Authorization: `Bearer ${memberSessionToken}` } : undefined
    const response = await fetch(`${proxyApiUrl}/api/status`, { cache: 'no-store', headers })
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
    return {
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
    }
  })
}
