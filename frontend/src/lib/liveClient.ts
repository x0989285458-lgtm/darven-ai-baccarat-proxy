import { dravenApiBaseUrl } from './apiBase'

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
  prediction?: BackendPrediction
}

export type SidePredictionKey = 'tie' | 'superSix' | 'bankerPair' | 'playerPair' | 'bankerDragon' | 'playerDragon'
export type BackendSidePredictions = Record<SidePredictionKey, number>
export type BackendSideActions = Record<SidePredictionKey, boolean>
export type BackendPrediction = { source?: string; strategyVersion: string; predictedResult: 'banker' | 'player'; recommendation?: string; confidence: number; probabilities?: { banker?: number; player?: number; tie?: number }; scoreTotals?: { banker?: number; player?: number }; sidePredictions?: BackendSidePredictions; sideActions?: BackendSideActions }

type Status = { state: 'connecting' | 'connected' | 'error' | 'disconnected'; message: string }
type LiveClientOptions = { memberSessionToken?: string; onTables: (tables: LiveTable[]) => void; onStatus: (status: Status) => void }

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
  prediction?: BackendPrediction
}

const proxyApiUrl = dravenApiBaseUrl
const pollIntervalMs = Number(import.meta.env.VITE_DRAVEN_PROXY_POLL_MS ?? 5000)
const streamStaleMs = Number(import.meta.env.VITE_DRAVEN_STREAM_STALE_MS ?? 15000)
const liveTableMaxAgeMs = Number(import.meta.env.VITE_DRAVEN_TABLE_MAX_AGE_MS ?? 120000)

export class LiveRoadClient {
  private timer?: number
  private stream?: EventSource
  private streamWatchdog?: number
  private lastStreamAt = 0
  private stopped = true

  constructor(private readonly options: LiveClientOptions) {}

  connect() {
    this.disconnect(false)
    this.stopped = false
    this.options.onStatus({ state: 'connecting', message: '正在建立即時同步…' })
    if (this.options.memberSessionToken) {
      void this.poll()
      this.timer = window.setInterval(() => void this.poll(), pollIntervalMs)
      return
    }
    this.connectStream()
    this.streamWatchdog = window.setInterval(() => {
      if (this.stopped) return
      if (!this.lastStreamAt || Date.now() - this.lastStreamAt > streamStaleMs) void this.poll()
    }, pollIntervalMs)
  }

  disconnect(notify = true) {
    this.stopped = true
    if (this.timer) window.clearInterval(this.timer)
    if (this.streamWatchdog) window.clearInterval(this.streamWatchdog)
    this.stream?.close()
    this.timer = undefined
    this.streamWatchdog = undefined
    this.stream = undefined
    if (notify) this.options.onStatus({ state: 'disconnected', message: '已停止讀取雲端資料' })
  }

  private connectStream() {
    try {
      this.stream?.close()
      this.stream = new EventSource(`${proxyApiUrl}/api/tables/stream?ts=${Date.now()}`)
      this.stream.onopen = () => {
        this.lastStreamAt = Date.now()
        this.options.onStatus({ state: 'connecting', message: '即時同步已連線，等待最新桌況…' })
      }
      this.stream.addEventListener('tables', (event) => {
        if (this.stopped) return
        this.lastStreamAt = Date.now()
        const payload = JSON.parse((event as MessageEvent).data)
        const tables = normalizeProxyTables(Array.isArray(payload?.tables) ? payload.tables : [])
        this.publishTables(tables, `即時同步中（${tables.length}桌）`)
      })
      this.stream.addEventListener('heartbeat', () => { this.lastStreamAt = Date.now() })
      this.stream.onerror = () => {
        if (this.stopped) return
        this.options.onStatus({ state: 'connecting', message: '即時同步重連中，暫用輪詢備援…' })
        window.setTimeout(() => { if (!this.stopped) this.connectStream() }, 2000)
      }
    } catch {
      void this.poll()
    }
  }

  private async poll() {
    if (this.stopped) return
    try {
      const headers = this.options.memberSessionToken ? { Authorization: `Bearer ${this.options.memberSessionToken}` } : undefined
      const statusPromise = this.options.memberSessionToken ? readProxyStatus(this.options.memberSessionToken) : Promise.resolve<Status | null>(null)
      const [response, proxyStatus] = await Promise.all([
        fetch(`${proxyApiUrl}/api/tables`, { cache: 'no-store', headers }),
        statusPromise,
      ])
      if (!response.ok) throw new Error(`proxy ${response.status}`)
      const payload = await response.json()
      const tables = normalizeProxyTables(Array.isArray(payload) ? payload : [])
      if (proxyStatus && /stale|過期/i.test(proxyStatus.message)) {
        this.options.onTables([])
        this.options.onStatus(proxyStatus)
        return
      }
      if (this.publishTables(tables, `雲端資料已連線（${tables.length}桌）`)) return
      this.options.onStatus(proxyStatus ?? await readProxyStatus())
    } catch {
      this.options.onTables([])
      this.options.onStatus({ state: 'error', message: '雲端代理暫時無法讀取資料' })
    }
  }

  private publishTables(tables: LiveTable[], liveMessage: string) {
    const freshTables = tables.filter((table) => !isLiveTableStale(table))
    if (freshTables.length !== tables.length || !freshTables.length) {
      this.options.onTables([])
      this.options.onStatus({ state: 'error', message: '桌況時間無效或資料過期，已停止出手' })
      return false
    }
    this.options.onTables(freshTables)
    this.options.onStatus({ state: 'connected', message: liveMessage })
    return true
  }
}

async function readProxyStatus(memberSessionToken?: string): Promise<Status> {
  try {
    const headers = memberSessionToken ? { Authorization: `Bearer ${memberSessionToken}` } : undefined
    const response = await fetch(`${proxyApiUrl}/api/status`, { cache: 'no-store', headers })
    if (!response.ok) return { state: 'error', message: `proxy狀態讀取失敗 (${response.status})` }
    const status = await response.json()
    if (typeof status.statusText === 'string' && status.statusText) {
      return { state: status.connected ? 'connected' : 'connecting', message: status.statusText }
    }
    const tableCount = Number(status.tableCount ?? (Array.isArray(status.tables) ? status.tables.length : 0))
    if (status.connected && status.authenticated && tableCount === 0) return { state: 'connecting', message: 'MT已驗證，等待桌況資料…' }
    if (status.connected && status.authenticated && tableCount > 0) return { state: 'connected', message: `已抓到${tableCount}桌` }
    if (status.connected && !status.authenticated) return { state: 'connecting', message: 'MT已連線，Token驗證中…' }
    if (status.connected === false) return { state: 'error', message: 'proxy已啟動，MT未連線，請確認 Token 是否過期' }
    return { state: 'connecting', message: 'proxy已啟動，等待 MT 桌況…' }
  } catch {
    return { state: 'error', message: '雲端代理未啟動或無法讀取狀態' }
  }
}

export function isLiveTableStale(table: Pick<LiveTable, 'sourceUpdatedAt'> | { sourceUpdatedAt?: string | null }, now = Date.now(), maxAgeMs = liveTableMaxAgeMs) {
  if (!table.sourceUpdatedAt) return true
  const timestamp = Date.parse(table.sourceUpdatedAt)
  if (!Number.isFinite(timestamp)) return true
  return now - timestamp > Math.max(1000, Number(maxAgeMs) || 120000)
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
      prediction: table.prediction,
    }
  })
}
