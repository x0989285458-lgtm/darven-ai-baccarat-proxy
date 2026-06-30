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
}

type Status = { state: 'connecting' | 'connected' | 'error' | 'disconnected'; message: string }
type LiveClientOptions = { token: string; onTables: (tables: LiveTable[]) => void; onStatus: (status: Status) => void }

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
}

const proxyApiUrl = dravenApiBaseUrl
const pollIntervalMs = Number(import.meta.env.VITE_DRAVEN_PROXY_POLL_MS ?? 2000)

export class LiveRoadClient {
  private timer?: number
  private stopped = true

  constructor(private readonly options: LiveClientOptions) {}

  connect() {
    this.disconnect(false)
    this.stopped = false
    this.options.onStatus({ state: 'connecting', message: '正在讀取本機代理資料…' })
    void this.poll()
    this.timer = window.setInterval(() => void this.poll(), pollIntervalMs)
  }

  disconnect(notify = true) {
    this.stopped = true
    if (this.timer) window.clearInterval(this.timer)
    this.timer = undefined
    if (notify) this.options.onStatus({ state: 'disconnected', message: '已停止讀取本機代理' })
  }

  private async poll() {
    if (this.stopped) return
    try {
      const response = await fetch(`${proxyApiUrl}/api/tables`, { cache: 'no-store' })
      if (!response.ok) throw new Error(`proxy ${response.status}`)
      const payload = await response.json()
      const tables = normalizeProxyTables(Array.isArray(payload) ? payload : [])
      if (tables.length) {
        this.options.onTables(tables)
        this.options.onStatus({ state: 'connected', message: `本機代理已連線（${tables.length}桌）` })
      } else {
        const status = await readProxyStatus()
        this.options.onStatus(status)
      }
    } catch {
      this.options.onStatus({ state: 'error', message: '本機代理未啟動或無法讀取資料' })
    }
  }
}

async function readProxyStatus(): Promise<Status> {
  try {
    const response = await fetch(`${proxyApiUrl}/api/status`, { cache: 'no-store' })
    if (!response.ok) return { state: 'error', message: `proxy狀態讀取失敗 (${response.status})` }
    const status = await response.json()
    if (typeof status.statusText === 'string' && status.statusText) {
      return { state: status.connected ? 'connected' : 'connecting', message: status.statusText }
    }
    const tableCount = Array.isArray(status.tables) ? status.tables.length : 0
    if (status.connected && status.authenticated && tableCount === 0) return { state: 'connecting', message: 'MT已驗證，等待桌況資料…' }
    if (status.connected && status.authenticated && tableCount > 0) return { state: 'connected', message: `已抓到${tableCount}桌` }
    if (status.connected && !status.authenticated) return { state: 'connecting', message: 'MT已連線，Token驗證中…' }
    if (status.connected === false) return { state: 'error', message: 'proxy已啟動，MT未連線，請確認 Token 是否過期' }
    return { state: 'connecting', message: 'proxy已啟動，等待 MT 桌況…' }
  } catch {
    return { state: 'error', message: '本機代理未啟動或無法讀取狀態' }
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
    }
  })
}
