import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchTableUiHistory, getBackendPredictionIssue, LiveRoadClient, isLiveTableStale, TableUiHistoryError, type BackendSideActions, type BackendSidePredictions, type LiveTable, type SidePredictionKey, type TableUiHistory } from './lib/liveClient'
import { type MainOutcome, type Prediction } from './lib/roadParser'
import { buildDisplayedBigRoad } from './lib/realCardRoad'
import { checkSupabaseConnection, isSupabaseConfigured, supabaseConfig } from './lib/supabaseClient'
import { checkOnlineCoreStatus, getOnlineMemoryCenter, getOnlineStrategyAnalysis, updateOnlineAppSetting, type OnlineCoreStatus, type OnlineMemoryCenter, type OnlineStrategyAnalysis } from './lib/onlineCoreClient'
import { agentLogin, createOnlineAgent, createOnlineLicense, deleteOnlineAgents, deleteOnlineLicense, extendOnlineLicense, getCloudDataStatus, getOnlineLicenseStatus, memberLogin, setOnlineLicenseStatus, validateMemberSession, type OnlineLicenseStatus } from './lib/onlineLicenseClient'

const SUPER_ADMIN = 'dv1788'
const MEMBER_SESSION_TOKEN_KEY = 'darven-member-session-token'
const MEMBER_SESSION_EXPIRES_KEY = 'darven-member-session-expires-at'
const tableDisplayOrder = ['1', '2', '3', '4', '5', '6', '7', '8', '9']
const MEMBER_TABLE_IDS = ['BAG01', 'BAG02', 'BAG03', 'BAG03A', 'BAG05', 'BAG06', 'BAG07', 'BAG08', 'BAG09', 'BAG10'] as const
const memberTableLabels: ReadonlyMap<string, string> = new Map(MEMBER_TABLE_IDS.map((tableId, index) => [tableId, ['1', '2', '3', '3A', '5', '6', '7', '8', '9', '10'][index]]))
const HISTORY_RETRY_DELAYS_MS = [150, 400] as const
type BackendScoreTotals = NonNullable<NonNullable<LiveTable['prediction']>['scoreTotals']>
const sidePredictionKeys: SidePredictionKey[] = ['tie', 'superSix', 'bankerPair', 'playerPair', 'bankerDragon', 'playerDragon']

function canonicalMemberTableId(table: LiveTable) {
  const id = String(table.id ?? table.name ?? '').trim().toUpperCase()
  const match = id.match(/^BAG(\d{1,2})(A?)$/)
  if (!match) return id
  return `BAG${match[1].padStart(2, '0')}${match[2]}`
}

function orderedMemberTables(tables: LiveTable[]) {
  const byId = new Map<string, LiveTable>()
  for (const table of tables) {
    const tableId = canonicalMemberTableId(table)
    if (!byId.has(tableId)) byId.set(tableId, table)
  }
  return MEMBER_TABLE_IDS.flatMap((tableId) => byId.has(tableId) ? [byId.get(tableId)!] : [])
}

export function selectMemberTable(tables: LiveTable[], selectedTableId: string) {
  const visibleTables = orderedMemberTables(tables)
  return visibleTables.find((table) => canonicalMemberTableId(table) === selectedTableId) ?? visibleTables[0]
}

function tableNumber(table: LiveTable, index: number) {
  return memberTableLabels.get(canonicalMemberTableId(table)) ?? tableDisplayOrder[index] ?? String(index + 1)
}

function backendPredictionFromTable(table?: LiveTable | null): Prediction | null {
  const livePrediction = table?.prediction
  const recommendation = normalizeBackendRecommendation(livePrediction?.recommendation ?? livePrediction?.predictedResult)
  const confidence = Number(livePrediction?.confidence)
  if (!recommendation || !Number.isFinite(confidence)) return null
  return {
    recommendation,
    confidence,
    risk: 'Medium',
    reason: '後端已計算該局方向與信心值，前端僅顯示。',
    scoreTotals: normalizeBackendScoreTotals(livePrediction?.scoreTotals),
  }
}

function normalizeBackendScoreTotals(value?: BackendScoreTotals) {
  const banker = Number(value?.banker)
  const player = Number(value?.player)
  if (!Number.isFinite(banker) || !Number.isFinite(player)) return undefined
  return { banker, player }
}

function normalizeBackendRecommendation(value: unknown): MainOutcome | null {
  const text = String(value ?? '').toLowerCase()
  if (text === 'banker' || text === '莊' || text === '2') return 'Banker'
  if (text === 'player' || text === '閒' || text === '1') return 'Player'
  return null
}

function backendSidePredictionsFromTable(table?: LiveTable | null): BackendSidePredictions | null {
  const value = table?.prediction?.sidePredictions
  if (!value || !sidePredictionKeys.every((key) => Number.isFinite(Number(value[key])))) return null
  return Object.fromEntries(sidePredictionKeys.map((key) => [key, Number(value[key])])) as BackendSidePredictions
}

function backendSideActionsFromTable(table?: LiveTable | null): BackendSideActions | null {
  const value = table?.prediction?.sideActions
  if (!value || !sidePredictionKeys.every((key) => typeof value[key] === 'boolean')) return null
  return Object.fromEntries(sidePredictionKeys.map((key) => [key, value[key]])) as BackendSideActions
}

function backendOutcomeProbabilitiesFromTable(table?: LiveTable | null) {
  const value = table?.prediction?.probabilities
  const banker = Number(value?.banker)
  const player = Number(value?.player)
  const tie = Number(value?.tie)
  if (![banker, player, tie].every(Number.isFinite)) return null
  return { banker, player, tie }
}

function clearMemberSession() {
  window.sessionStorage.removeItem(MEMBER_SESSION_TOKEN_KEY)
  window.sessionStorage.removeItem(MEMBER_SESSION_EXPIRES_KEY)
  window.sessionStorage.removeItem('darven-member-login')
}

export default function App() {
  const path = window.location.pathname
  const memberSessionToken = window.sessionStorage.getItem(MEMBER_SESSION_TOKEN_KEY) ?? ''
  const [memberSessionState, setMemberSessionState] = useState<'checking' | 'valid' | 'invalid'>(() => (path === '/' || path === '') && memberSessionToken ? 'checking' : 'invalid')
  const memberLoggedIn = memberSessionState === 'valid'
  const adminLoggedIn = Boolean(window.sessionStorage.getItem('darven-admin-account') && window.sessionStorage.getItem('darven-admin-session-token'))
  const [tables, setTables] = useState<LiveTable[]>([])
  const [selectedTableId, setSelectedTableId] = useState<string>(MEMBER_TABLE_IDS[0])
  const [status, setStatus] = useState({ state: 'disconnected', message: '等待雲端資料來源' })
  const [tableUiHistory, setTableUiHistory] = useState<TableUiHistory | null>(null)
  const [supabaseStatus, setSupabaseStatus] = useState({ state: isSupabaseConfigured ? 'connecting' : 'error', message: isSupabaseConfigured ? 'Supabase 檢查中' : 'Supabase 未設定' })
  const [onlineCoreStatus, setOnlineCoreStatus] = useState<OnlineCoreStatus>({ state: 'connecting', message: '記憶中心檢查中' })
  const client = useRef<LiveRoadClient | null>(null)
  const historyRequestId = useRef(0)
  const visibleTables = useMemo(() => orderedMemberTables(tables), [tables])
  const selected = useMemo(() => selectMemberTable(tables, selectedTableId), [tables, selectedTableId])
  const selectedCanonicalId = selected ? canonicalMemberTableId(selected) : ''
  const displaySelected = selected
  const selectedShoe = displaySelected?.trend.current_shoe
  const selectedRound = Number(displaySelected?.trend.current_round ?? 0)
  const staleNotice = useMemo(() => {
    const staleTables = visibleTables.filter((table) => isLiveTableStale(table)).length
    if (staleTables > 0) return `資料過期：${staleTables}桌桌況資料可能不是即時`
    if (/過期|stale/i.test(status.message)) return status.message
    return ''
  }, [visibleTables, status.message])
  const bigRoad = useMemo(() => buildDisplayedBigRoad(
    displaySelected?.trend.big2 ?? '',
    { tableId: selectedCanonicalId, shoe: selectedShoe ?? '', currentRound: Number(displaySelected?.trend.current_round ?? 0) },
    tableUiHistory,
  ), [displaySelected?.trend.big2, displaySelected?.trend.current_round, selectedCanonicalId, selectedShoe, tableUiHistory])
  const prediction = useMemo(() => backendPredictionFromTable(displaySelected), [displaySelected])
  const bonusPredictions = useMemo(() => backendSidePredictionsFromTable(displaySelected), [displaySelected])
  const sideActions = useMemo(() => backendSideActionsFromTable(displaySelected), [displaySelected])
  const outcomePredictions = useMemo(() => backendOutcomeProbabilitiesFromTable(displaySelected), [displaySelected])
  const predictionIssue = useMemo(() => getBackendPredictionIssue(displaySelected), [displaySelected])
  const predictionsActionable = !predictionIssue && !staleNotice

  useEffect(() => () => client.current?.disconnect(false), [])
  useEffect(() => {
    if (path !== '/' && path !== '') return
    if (!memberSessionToken) { setMemberSessionState('invalid'); return }
    let active = true
    const verify = async () => {
      const expiresAt = window.sessionStorage.getItem(MEMBER_SESSION_EXPIRES_KEY)
      if (expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now())) {
        clearMemberSession()
        if (active) setMemberSessionState('invalid')
        return
      }
      const result = await validateMemberSession(memberSessionToken)
      if (!active) return
      if (!result.ok) {
        clearMemberSession()
        setMemberSessionState('invalid')
        client.current?.disconnect(false)
        return
      }
      if (result.sessionExpiresAt) window.sessionStorage.setItem(MEMBER_SESSION_EXPIRES_KEY, result.sessionExpiresAt)
      setMemberSessionState('valid')
    }
    void verify()
    const timer = window.setInterval(verify, 60000)
    return () => { active = false; window.clearInterval(timer) }
  }, [path, memberSessionToken])
  useEffect(() => {
    if (path === '/login' || path === '/admin-login' || path === '/後台登入') return
    if ((path === '/' || path === '') && !memberLoggedIn) return
    if (path === '/admin' && !adminLoggedIn) return
    let active = true
    const adminSessionToken = path === '/admin' ? window.sessionStorage.getItem('darven-admin-session-token') ?? undefined : undefined
    checkSupabaseConnection(adminSessionToken).then((result) => {
      if (!active) return
      setSupabaseStatus({ state: result.ok ? 'connected' : 'error', message: result.message })
    })
    const loadCoreStatus = () => checkOnlineCoreStatus().then((result) => {
      if (!active) return
      setOnlineCoreStatus(result)
      enforceMaintenanceLogout(result, path, client.current)
    })
    loadCoreStatus()
    const timer = window.setInterval(loadCoreStatus, 15000)
    return () => { active = false; window.clearInterval(timer) }
  }, [path, memberLoggedIn, adminLoggedIn])

  const start = () => {
    client.current?.disconnect(false)
    client.current = new LiveRoadClient({
      memberSessionToken,
      onTables: (next) => {
        setTables(next)
      },
      onStatus: setStatus,
      onUnauthorized: () => {
        clearMemberSession()
        setMemberSessionState('invalid')
      },
    })
    client.current.connect()
  }

  useEffect(() => {
    if ((path === '/' || path === '') && memberLoggedIn) start()
    return () => client.current?.disconnect(false)
  }, [path, memberLoggedIn])

  useEffect(() => {
    const requestId = ++historyRequestId.current
    setTableUiHistory((current) => (
      current?.tableId === selectedCanonicalId && String(current.shoe) === String(selectedShoe)
        ? current
        : null
    ))
    if (!memberLoggedIn || !selectedCanonicalId || selectedShoe == null || selectedShoe === '') return
    const controller = new AbortController()
    let retryTimer: number | undefined
    const hasDuplicateRounds = (history: TableUiHistory) => {
      const predictionRounds = history.settledPredictions.map((item) => item.round)
      const cardRounds = history.realCardRounds.map((item) => item.round)
      return new Set(predictionRounds).size !== predictionRounds.length || new Set(cardRounds).size !== cardRounds.length
    }
    const load = async (attempt: number) => {
      try {
        const history = await fetchTableUiHistory(selectedCanonicalId, memberSessionToken, controller.signal)
        if (controller.signal.aborted || requestId !== historyRequestId.current) return
        if (history.tableId !== selectedCanonicalId || String(history.shoe) !== String(selectedShoe) || hasDuplicateRounds(history)) return
        setTableUiHistory(history)
        const latestSettledRound = history.settledPredictions.reduce((latest, item) => Math.max(latest, item.round), 0)
        const historyIsBehind = history.realCardHistoryCompleteThroughRound < selectedRound
          || latestSettledRound < selectedRound
        if (historyIsBehind && attempt < HISTORY_RETRY_DELAYS_MS.length) {
          retryTimer = window.setTimeout(() => void load(attempt + 1), HISTORY_RETRY_DELAYS_MS[attempt])
        }
      } catch (error) {
        if (controller.signal.aborted || requestId !== historyRequestId.current) return
        if (error instanceof TableUiHistoryError && error.status === 401) {
          clearMemberSession()
          client.current?.disconnect(false)
          setMemberSessionState('invalid')
        }
      }
    }
    void load(0)
    return () => {
      controller.abort()
      if (retryTimer) window.clearTimeout(retryTimer)
    }
  }, [memberLoggedIn, memberSessionToken, selectedCanonicalId, selectedShoe, selectedRound])

  useInactivityLogout(path === '/admin' && adminLoggedIn ? 'admin' : (path === '/' || path === '') && memberLoggedIn ? 'member' : null)

  if (path === '/login') {
    return <LoginApp />
  }

  if (path === '/admin-login' || path === '/後台登入') {
    return <AdminLoginApp />
  }

  if (path === '/admin') {
    if (!adminLoggedIn) return <AdminLoginApp />
    return <AdminApp tables={visibleTables} supabaseStatus={supabaseStatus} onlineCoreStatus={onlineCoreStatus} />
  }

  if ((path === '/' || path === '') && memberSessionState === 'checking') return <SessionChecking />
  if ((path === '/' || path === '') && !memberLoggedIn) return <LoginApp />

  if (!displaySelected) return <WaitingForCloudData status={status} supabaseStatus={supabaseStatus} />

  return <main className="app-shell">
    <header className="topbar">
      <div className="brand" aria-label="主標題">
        <h1>AI百家預測軟體</h1>
      </div>
      <div className="header-meta"><span className={`status ${supabaseStatus.state}`} title={supabaseConfig.projectRef}>{supabaseStatus.message}</span>{staleNotice ? <span className="status stale" title={staleNotice} aria-label={staleNotice}>資料過期</span> : null}</div>
    </header>
    <div className="workspace">
      <aside className="sidebar balanced-sidebar-line" aria-label="桌號與資料選擇">
        <nav className="table-list" aria-label="桌號選擇">
          {visibleTables.map((table, index) => {
            const tableId = canonicalMemberTableId(table)
            return <button className={`table-item ${tableId === selectedCanonicalId ? 'active' : ''}`} key={tableId} onClick={() => { setTableUiHistory(null); setSelectedTableId(tableId) }}>
              MT百家樂第{tableNumber(table, index)}桌 第{table.trend.current_round ?? 0}局
            </button>
          })}
        </nav>
      </aside>
      <section className="content">
        <div className="stats-grid" aria-label="統計資訊">
          <Stat title="閒" value={String(displaySelected.trend.total_round_player ?? 0)} tone="Player" />
          <Stat title="和" value={String(displaySelected.trend.total_round_tie ?? 0)} tone="Tie" />
          <Stat title="莊" value={String(displaySelected.trend.total_round_banker ?? 0)} tone="Banker" />
        </div>
        <section className="prediction-card" aria-label="AI預測結果">
          <div className="prediction-row side-prediction-row" aria-label="副項目預測機率">
            <PredictionMetric title="閒龍寶" value={bonusPredictions?.playerDragon ?? null} tone="Player" active={predictionsActionable && (sideActions?.playerDragon ?? false)} />
            <PredictionMetric title="閒對" value={bonusPredictions?.playerPair ?? null} tone="Player" active={predictionsActionable && (sideActions?.playerPair ?? false)} />
            <PredictionMetric title="超六" value={bonusPredictions?.superSix ?? null} tone="Tie" active={predictionsActionable && (sideActions?.superSix ?? false)} />
            <PredictionMetric title="莊對" value={bonusPredictions?.bankerPair ?? null} tone="Banker" active={predictionsActionable && (sideActions?.bankerPair ?? false)} />
            <PredictionMetric title="莊龍寶" value={bonusPredictions?.bankerDragon ?? null} tone="Banker" active={predictionsActionable && (sideActions?.bankerDragon ?? false)} />
          </div>
          {predictionIssue ? <strong className="status stale">{predictionIssue}，預測暫不可用，已停止出手</strong> : null}
          {prediction ?
            <div className="prediction-row main-probability-row" aria-label="莊閒預測機率">
              <PredictionMetric title="閒" value={outcomePredictions?.player ?? null} tone="Player" active={predictionsActionable && prediction.recommendation === 'Player'} />
              <PredictionMetric title="和" value={outcomePredictions?.tie ?? null} tone="Tie" active={false} />
              <PredictionMetric title="莊" value={outcomePredictions?.banker ?? null} tone="Banker" active={predictionsActionable && prediction.recommendation === 'Banker'} />
            </div>
          : null}
          <PredictionHistoryTable history={tableUiHistory} />
        </section>
        <div className="roads-grid single-road">
          <RoadCard title="大路" subtitle={<div className="road-counts" aria-label="大路莊閒局數"><span className="Banker">莊局數：{displaySelected.trend.total_round_banker ?? 0}</span><span className="Player">閒局數：{displaySelected.trend.total_round_player ?? 0}</span></div>}>
            <div className="big-road classic-road" aria-label="傳統大路">
              {bigRoad.map((cell) => <div style={{ gridColumn: cell.column + 1, gridRow: cell.row + 1 }} title={`${cell.outcome === 'banker' ? '莊' : '閒'} ${cell.point}點`} className={`big-cell ${cell.outcome === 'banker' ? 'Banker' : 'Player'} ${cell.hasTie ? 'tie-mark' : ''}`} key={`${selectedShoe}:${cell.column}:${cell.row}:${cell.code}`}><span>{cell.point}</span></div>)}
            </div>
          </RoadCard>
        </div>
      </section>
    </div>
  </main>
}


function enforceMaintenanceLogout(status: OnlineCoreStatus, path: string, liveClient: LiveRoadClient | null) {
  if (!status.maintenanceMode) return
  if (path === '/' || path === '') {
    clearMemberSession()
    liveClient?.disconnect(false)
    if (window.location.pathname !== '/login') window.location.assign('/login')
    return
  }
  if (path === '/admin') {
    const account = window.sessionStorage.getItem('darven-admin-account')?.trim().toLowerCase()
    const role = normalizeRole(window.sessionStorage.getItem('darven-admin-role'))
    if (account !== SUPER_ADMIN && role !== 'super') {
      window.sessionStorage.removeItem('darven-admin-account')
      window.sessionStorage.removeItem('darven-admin-role')
      window.sessionStorage.removeItem('darven-admin-session-token')
      window.sessionStorage.removeItem('darven-admin-session-expires-at')
      window.sessionStorage.removeItem('darven_admin_login')
      if (window.location.pathname !== '/admin-login') window.location.assign('/admin-login')
    }
  }
}

function SessionChecking() {
  return <main className="login-shell"><section className="login-card" aria-label="會員Session驗證中"><h1>瑞文AI百家預測</h1><strong>會員 Session 驗證中</strong></section></main>
}

function WaitingForCloudData({ status, supabaseStatus }: { status: { state: string; message: string }; supabaseStatus: { state: string; message: string } }) {
  return <main className="app-shell waiting-shell">
    <header className="topbar">
      <div className="brand" aria-label="主標題"><h1>AI百家預測軟體</h1></div>
      <div className="header-meta"><span className={`status ${supabaseStatus.state}`} title={supabaseConfig.projectRef}>{supabaseStatus.message}</span></div>
    </header>
    <section className="waiting-card" aria-label="等待雲端資料">
      <h2>等待雲端資料</h2>
      <p>目前沒有 MT 桌況資料，MT 自動登入未啟用；請等待後端 Worker 或手動資料來源寫入。</p>
      <strong>{status.message || '等待雲端資料來源'}</strong>
    </section>
  </main>
}

function LoginApp() {
  const [coreStatus, setCoreStatus] = useState<OnlineCoreStatus>({ state: 'connecting', message: '系統狀態檢查中' })
  useEffect(() => { checkOnlineCoreStatus().then(setCoreStatus) }, [])
  const [memberAccount, setMemberAccount] = useState('')
  const [verificationPassword, setVerificationPassword] = useState('')
  const [loginMessage, setLoginMessage] = useState('')
  const submitLogin = async () => {
    if (coreStatus.maintenanceMode) { setLoginMessage('系統維護中，暫停登入'); return }
    setLoginMessage('登入驗證中')
    try {
      const result = await memberLogin({ memberAccount, verificationPassword })
      if (!result.ok) {
        setLoginMessage(result.error || '登入失敗，請確認會員帳號與驗證密碼')
        return
      }
      if (!result.memberSessionToken || !result.sessionExpiresAt) {
        setLoginMessage('登入失敗：後端未提供會員 Session')
        return
      }
      window.sessionStorage.setItem(MEMBER_SESSION_TOKEN_KEY, result.memberSessionToken)
      window.sessionStorage.setItem(MEMBER_SESSION_EXPIRES_KEY, result.sessionExpiresAt)
      window.sessionStorage.removeItem('darven-member-login')
      setLoginMessage('登入成功，正在進入前台')
      window.location.assign('/')
    } catch {
      setLoginMessage('登入失敗，請重新整理後再試')
    }
  }
  return <main className="login-shell">
    <section className="login-card" aria-label="前台登入驗證">
      <h1>瑞文AI百家預測</h1>
      <div className="login-chip">前台登入驗證</div>
      <input aria-label="會員帳號" placeholder="請輸入會員帳號" value={memberAccount} onChange={(event) => setMemberAccount(event.target.value)} />
      <input aria-label="驗證密碼" placeholder="請輸入驗證密碼" type="password" value={verificationPassword} onChange={(event) => setVerificationPassword(event.target.value)} />
      <button onClick={submitLogin}>會員登入</button>
      <em className={coreStatus.maintenanceMode ? 'system-status maintenance' : 'system-status normal'}>{loginMessage || (coreStatus.maintenanceMode ? '系統維護中' : '系統正常')}</em>
    </section>
  </main>
}

function AdminLoginApp() {
  const [coreStatus, setCoreStatus] = useState<OnlineCoreStatus>({ state: 'connecting', message: '系統狀態檢查中' })
  useEffect(() => { checkOnlineCoreStatus().then(setCoreStatus) }, [])
  const [agentAccount, setAgentAccount] = useState('')
  const [loginMessage, setLoginMessage] = useState('')
  const submitLogin = async () => {
    if (coreStatus.maintenanceMode && agentAccount.trim().toLowerCase() !== SUPER_ADMIN) { setLoginMessage('系統維護中，僅超級管理員可登入'); return }
    setLoginMessage('後台登入驗證中')
    try {
      const result = await agentLogin({ agentAccount })
      if (!result.ok && !result.skipped) {
        setLoginMessage('登入失敗，請確認管理員或代理帳號')
        return
      }
      window.sessionStorage.setItem('darven-admin-account', agentAccount.trim())
      window.sessionStorage.setItem('darven-admin-role', normalizeRole(result.account?.role ?? result.agent?.role ?? (agentAccount.trim().toLowerCase() === SUPER_ADMIN ? 'super' : 'viewer')))
      if (result.adminSessionToken) window.sessionStorage.setItem('darven-admin-session-token', result.adminSessionToken)
      if (result.sessionExpiresAt) window.sessionStorage.setItem('darven-admin-session-expires-at', result.sessionExpiresAt)
      setLoginMessage('登入成功，正在進入後台')
      window.location.assign('/admin')
    } catch {
      setLoginMessage('登入失敗，請確認後端 API 是否上線')
    }
  }
  return <main className="login-shell">
    <section className="login-card" aria-label="管理後台登入">
      <h1 className="admin-login-title">瑞文AI百家管理後台</h1>
      <strong>瑞文AI後台管理</strong>
      <input aria-label="帳號" placeholder="請輸入帳號" value={agentAccount} onChange={(event) => setAgentAccount(event.target.value)} />
      <button onClick={submitLogin}>登入</button>
      {loginMessage ? <em>{loginMessage}</em> : null}
    </section>
  </main>
}

type AgentRow = { account: string; level: string; permission: string; parent?: string; depth?: number }
type CodeRow = { member: string; code: string; status: string; remain: string; agentCode?: string; expiresOn?: string; suspendedAt?: string }

const initialAgents: AgentRow[] = [
  { account: 'dv1788', level: '超級管理員', permission: '最高權限 / 可看全部', depth: 0 },
  { account: 'Admin001', level: '管理員', permission: '可開代理 / 可建碼', parent: 'dv1788', depth: 1 },
  { account: 'Agent001', level: '代理', permission: '可開觀察者 / 可建碼', parent: 'Admin001', depth: 2 },
  { account: 'Agent002', level: '代理', permission: '可建碼', parent: 'Admin001', depth: 2 },
  { account: 'View001', level: '觀察者', permission: '僅可登入確認', parent: 'Agent001', depth: 3 },
  { account: 'DV1688', level: '管理員', permission: '可開代理 / 可建碼', parent: 'dv1788', depth: 1 },
  { account: 'A1024', level: '代理', permission: '可建碼', parent: 'DV1688', depth: 2 },
  { account: 'B7788', level: '觀察者', permission: '僅可登入確認', parent: 'A1024', depth: 3 },
  { account: 'M8888', level: '管理員', permission: '可開代理 / 可建碼', parent: 'dv1788', depth: 1 },
  { account: 'Test009', level: '代理', permission: '可建碼', parent: 'M8888', depth: 2 },
  { account: 'C2026', level: '觀察者', permission: '僅可登入確認', parent: 'Test009', depth: 3 },
  { account: 'Agent010', level: '代理', permission: '可建碼', parent: 'M8888', depth: 2 },
]

const initialCodes: CodeRow[] = [
  { member: 'User001', code: 'Agent001_001', status: '啟用中', remain: '30天' },
  { member: 'User002', code: 'Agent001_002', status: '啟用中', remain: '28天' },
  { member: 'User003', code: 'Agent002_001', status: '暫停中', remain: '12天' },
  { member: 'User004', code: 'DV1688_008', status: '啟用中', remain: '10天' },
  { member: 'User005', code: 'A1024_003', status: '啟用中', remain: '9天' },
  { member: 'User006', code: 'Test009_001', status: '啟用中', remain: '7天' },
  { member: 'User007', code: 'B7788_004', status: '暫停中', remain: '6天' },
  { member: 'User008', code: 'M8888_010', status: '啟用中', remain: '5天' },
  { member: 'User009', code: 'C2026_002', status: '啟用中', remain: '3天' },
  { member: 'User010', code: 'Agent010_001', status: '啟用中', remain: '1天' },
]

function AdminApp({ tables, supabaseStatus, onlineCoreStatus }: { tables: LiveTable[]; supabaseStatus: { state: string; message: string }; onlineCoreStatus: OnlineCoreStatus }) {
  const totalRounds = tables.reduce((sum, table) => sum + Number(table.trend.current_round ?? 0), 0)
  const loginAgent = window.sessionStorage.getItem('darven-admin-account')?.trim() || SUPER_ADMIN
  const adminSessionToken = window.sessionStorage.getItem('darven-admin-session-token') ?? undefined
  const loginRoleName = normalizeRole(window.sessionStorage.getItem('darven-admin-role') || (loginAgent.toLowerCase() === SUPER_ADMIN ? 'super' : 'viewer'))
  const isSuper = loginRoleName === 'super' || loginAgent.toLowerCase() === SUPER_ADMIN
  const [memberAccount, setMemberAccount] = useState('')
  const [planDays, setPlanDays] = useState('30')
  const [latestMember, setLatestMember] = useState('User001')
  const [latestCode, setLatestCode] = useState('DV1788_001')
  const [codes, setCodes] = useState<CodeRow[]>(() => pruneExpiredCodes(initialCodes))
  const [selectedCodeMembers, setSelectedCodeMembers] = useState<string[]>([])
  const [selectedAgents, setSelectedAgents] = useState<string[]>([])
  const [agentSearch, setAgentSearch] = useState('')
  const [collapsedAgents, setCollapsedAgents] = useState<string[]>([])
  const [codeSearch, setCodeSearch] = useState('')
  const [newAgentCode, setNewAgentCode] = useState('')
  const [newAgentRole, setNewAgentRole] = useState<'viewer' | 'agent' | 'manager'>('agent')
  const [newAgentParent, setNewAgentParent] = useState('')
  const [agentActionBusy, setAgentActionBusy] = useState(false)
  const [codeActionBusy, setCodeActionBusy] = useState(false)
  const [toast, setToast] = useState('')
  const [memoryCenter, setMemoryCenter] = useState<OnlineMemoryCenter>({ state: 'connecting', items: [], reports: [], strategies: [] })
  const [strategyAnalysis, setStrategyAnalysis] = useState<OnlineStrategyAnalysis>({ state: 'connecting', strategyRows: [], weakTables: [], strongTables: [], watchTables: [], suggestions: [] })
  const [licenseStatus, setLicenseStatus] = useState<OnlineLicenseStatus>({ managers: [], agents: [], plans: [], licenses: [], agentRows: [], licenseRows: [] })
  const [cloudDataStatus, setCloudDataStatus] = useState<{ mtAutoLoginEnabled?: boolean; message?: string; tableCount?: number; todayRoundCount?: number; tableStats?: Array<{ tableId: string; mainHitRate: string; sideHitRate: string }>; dailyReports?: Array<Record<string, any>> }>({ mtAutoLoginEnabled: false, message: '資料抓取待確認', todayRoundCount: 0, tableStats: [], dailyReports: [] })
  useEffect(() => {
    let cloudLoaded = false
    const loadReports = () => {
      getOnlineMemoryCenter().then(setMemoryCenter)
      getOnlineStrategyAnalysis().then(setStrategyAnalysis)
      getCloudDataStatus().then((status) => {
        setCloudDataStatus((previous) => status.todayRoundCount != null ? status : previous)
        if (status.todayRoundCount != null) cloudLoaded = true
      })
    }
    loadReports()
    const slowTimer = window.setInterval(loadReports, 300000)
    const fastTimer = window.setInterval(() => {
      if (cloudLoaded) { window.clearInterval(fastTimer); return }
      loadReports()
    }, 5000)
    return () => { window.clearInterval(slowTimer); window.clearInterval(fastTimer) }
  }, [])
  useEffect(() => {
    if (onlineCoreStatus.maintenanceMode && !isSuper) logoutAdmin()
  }, [onlineCoreStatus.maintenanceMode, isSuper])
  useEffect(() => { getOnlineLicenseStatus({ adminAccount: displayManager, adminSessionToken }).then((status) => {
    setLicenseStatus(status)
    if (status.licenseRows.length) {
      const rows = pruneExpiredCodes(status.licenseRows as CodeRow[])
      setCodes(rows)
      if (rows.length) {
        setLatestCode(rows[0].code)
        setLatestMember(rows[0].member)
      }
    } else if (status.configured === false) {
      setCodes(pruneExpiredCodes(initialCodes))
    } else {
      setCodes([])
      setLatestCode('')
      setLatestMember('')
    }
  }) }, [])
  const startDate = '2026/06/25'
  const displayManager = loginAgent
  const displayManagerLabel = isSuper ? '超級管理員帳號' : displayManager
  const displayMember = memberAccount.trim() || 'User001'
  const serialNo = useMemo(() => findLowestAvailableSerial(codes, displayManager), [codes, displayManager])
  const clampedPlanDays = clampPlanDays(planDays)
  const expiryDate = useMemo(() => {
    const date = new Date('2026-06-25T00:00:00')
    date.setDate(date.getDate() + clampedPlanDays)
    return date.toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' })
  }, [clampedPlanDays])
  const createAuthorization = async () => {
    if (!canManageCodes) return notify('此角色不能建立驗證碼')
    const nextCode = buildLicenseCode(displayManager, displayMember, serialNo)
    const result = await createOnlineLicense({ memberAccount: displayMember, code: nextCode, agentCode: displayManager, durationDays: clampedPlanDays, adminSessionToken })
    setLatestMember(displayMember)
    setLatestCode(result.row?.code ?? nextCode)
    const nextRows = await getOnlineLicenseStatus({ adminAccount: displayManager, adminSessionToken })
    setLicenseStatus(nextRows)
    if (nextRows.licenseRows.length) setCodes(pruneExpiredCodes(nextRows.licenseRows as CodeRow[]))
    else setCodes((rows) => pruneExpiredCodes([{ member: displayMember, code: result.row?.code ?? nextCode, status: '啟用中', remain: `${clampedPlanDays}天` }, ...rows]))
  }
  const refreshLicenses = async () => {
    const nextRows = await getOnlineLicenseStatus({ adminAccount: displayManager, adminSessionToken })
    setLicenseStatus(nextRows)
    if (nextRows.licenseRows.length) setCodes(pruneExpiredCodes(nextRows.licenseRows as CodeRow[]))
    return nextRows
  }
  const toggleCode = (member: string) => setSelectedCodeMembers((current) => current.includes(member) ? current.filter((item) => item !== member) : [...current, member])
  const toggleAgent = (account: string) => setSelectedAgents((current) => current.includes(account) ? current.filter((item) => item !== account) : [...current, account])
  const toggleCollapse = (account: string) => setCollapsedAgents((current) => current.includes(account) ? current.filter((item) => item !== account) : [...current, account])
  const logoutAdmin = () => {
    window.sessionStorage.removeItem('darven-admin-account')
    window.sessionStorage.removeItem('darven-admin-role')
    window.sessionStorage.removeItem('darven-admin-session-token')
    window.sessionStorage.removeItem('darven-admin-session-expires-at')
    window.sessionStorage.removeItem('darven_admin_login')
    window.location.assign('/admin-login')
  }
  const selectedCodeRows = () => codes.filter((row) => selectedCodeMembers.includes(row.code))
  const deleteSelectedCodes = async () => {
    if (!canManageCodes) return notify('此角色不能管理驗證碼')
    const rows = selectedCodeRows()
    if (!rows.length) return notify('請先勾選驗證碼')
    setCodeActionBusy(true)
    try {
      await Promise.all(rows.map((row) => deleteOnlineLicense({ code: row.code, adminSessionToken })))
      setSelectedCodeMembers([])
      await refreshLicenses()
      notify('已刪除選取驗證碼')
    } catch (error: any) {
      notify(error?.message || '刪除驗證碼失敗')
    } finally {
      setCodeActionBusy(false)
    }
  }
  const suspendSelectedCodes = async () => {
    if (!canManageCodes) return notify('此角色不能管理驗證碼')
    const rows = selectedCodeRows()
    if (!rows.length) return notify('請先勾選驗證碼')
    setCodeActionBusy(true)
    try {
      await Promise.all(rows.map((row) => setOnlineLicenseStatus({ code: row.code, status: 'suspended', adminSessionToken })))
      await refreshLicenses()
      notify('已暫停選取驗證碼')
    } catch (error: any) {
      notify(error?.message || '暫停驗證碼失敗')
    } finally {
      setCodeActionBusy(false)
    }
  }
  const activateSelectedCodes = async () => {
    if (!canManageCodes) return notify('此角色不能管理驗證碼')
    const rows = selectedCodeRows()
    if (!rows.length) return notify('請先勾選驗證碼')
    setCodeActionBusy(true)
    try {
      await Promise.all(rows.map((row) => setOnlineLicenseStatus({ code: row.code, status: 'active', adminSessionToken })))
      await refreshLicenses()
      notify('已開啟選取驗證碼')
    } catch (error: any) {
      notify(error?.message || '開啟驗證碼失敗')
    } finally {
      setCodeActionBusy(false)
    }
  }
  const extendSelectedCodes = async () => {
    if (!canManageCodes) return notify('此角色不能管理驗證碼')
    const rows = selectedCodeRows()
    if (!rows.length) return notify('請先勾選驗證碼')
    setCodeActionBusy(true)
    try {
      await Promise.all(rows.map((row) => extendOnlineLicense({ code: row.code, days: clampedPlanDays, adminSessionToken })))
      await refreshLicenses()
      notify(`已延長選取驗證碼 ${clampedPlanDays} 天`)
    } catch (error: any) {
      notify(error?.message || '延長驗證碼失敗')
    } finally {
      setCodeActionBusy(false)
    }
  }
  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(''), 2600) }
  const copyText = async (text: string, message: string) => { await navigator.clipboard?.writeText(text); notify(message) }
  const createAgentFromForm = async () => {
    const rawCode = newAgentCode.trim()
    if (!canManageAgents) return notify('此角色不能開設代理')
    if (!rawCode) return notify('請輸入帳號')
    if (!roleOptions.includes(newAgentRole)) return notify('下級等級不能高於或平級於上級')
    const parentCode = newAgentParent || displayManager
    const code = buildChildAgentAccount(parentCode, rawCode)
    setAgentActionBusy(true)
    try {
      const result = await createOnlineAgent({ code, name: code, role: newAgentRole, parentCode, adminSessionToken, permission: rolePermission(newAgentRole) })
      if (!result.ok && !result.skipped) throw new Error(result.error || '建立失敗')
      setNewAgentCode('')
      setNewAgentParent('')
      await refreshLicenses()
      notify(`代理帳號已建立：${code}`)
    } catch (error: any) {
      notify(error?.message || '建立代理失敗')
    } finally {
      setAgentActionBusy(false)
    }
  }
  const adjustSelectedAgents = async () => {
    if (!canManageAgents) return notify('此角色不能調整等級')
    if (!selectedAgents.length) return notify('請先勾選代理')
    if (!roleOptions.includes(newAgentRole)) return notify('下級等級不能高於或平級於上級')
    setAgentActionBusy(true)
    try {
      await Promise.all(selectedAgents.map((code) => {
        const current = agents.find((agent) => agent.account === code)
        return createOnlineAgent({ code, name: code, role: newAgentRole, parentCode: current?.parent ?? displayManager, adminSessionToken, permission: rolePermission(newAgentRole) })
      }))
      await refreshLicenses()
      notify('代理角色已調整')
    } catch (error: any) {
      notify(error?.message || '調整等級失敗')
    } finally {
      setAgentActionBusy(false)
    }
  }
  const deleteSelectedAgents = async () => {
    if (!canManageAgents) return notify('此角色不能刪除代理')
    if (!selectedAgents.length) return notify('請先勾選代理')
    setAgentActionBusy(true)
    try {
      await deleteOnlineAgents({ codes: selectedAgents, adminSessionToken })
      setSelectedAgents([])
      await refreshLicenses()
      notify('已刪除選取帳號；若選取管理員，其附屬下級也已刪除')
    } catch (error: any) {
      notify(error?.message || '刪除代理失敗')
    } finally {
      setAgentActionBusy(false)
    }
  }
  const enableMaintenanceMode = async () => {
    if (!isSuper) return notify('只有超級管理員可以啟用維護模式')
    await updateOnlineAppSetting({ scope: 'frontend', key: 'ui_defaults', value: { maintenanceMode: true, enabledAt: new Date().toISOString() }, isPublic: true, adminSessionToken })
    notify('維護模式已啟用')
    window.location.reload()
  }
  const dailyReports = cloudDataStatus.dailyReports ?? []
  const latestReport = dailyReports[0] ?? memoryCenter.reports[0]
  const actualRounds = cloudDataStatus.todayRoundCount ?? latestReport?.rounds ?? totalRounds
  const agents = useMemo(() => normalizeAgents(licenseStatus.configured === false ? initialAgents : licenseStatus.agentRows, displayManager), [licenseStatus.configured, licenseStatus.agentRows, displayManager])
  const visibleAgents = useMemo(() => filterCollapsedAgents(agents, collapsedAgents), [agents, collapsedAgents])
  const filteredAgents = useMemo(() => filterAgents(visibleAgents, agentSearch), [visibleAgents, agentSearch])
  const filteredCodes = useMemo(() => filterCodes(codes, codeSearch), [codes, codeSearch])
  const canManageCodes = ['super','manager','agent'].includes(loginRoleName)
  const canManageAgents = ['super','manager'].includes(loginRoleName)
  const canOnlyObserve = loginRoleName === 'viewer'
  const roleOptions = allowedChildRoles(isSuper ? 'super' : loginRoleName)

  return <main className="admin-shell admin-v015-shell" style={{ width: '100%', maxWidth: 'none' }}>
    {toast ? <div className="toast">{toast}</div> : null}
    <header className="admin-hero clean-hero v015-hero" style={{ width: '100%', maxWidth: 'none' }}>
      <div className="admin-title-block">
        <h1>AI百家預測後台</h1>
        <span>授權序號 / 會員帳號 / 代理管理 / 驗證碼管理</span>
      </div>
      <button className="admin-logout" onClick={logoutAdmin}>登出</button>
    </header>

    <section className="admin-summary-grid auth-summary v015-summary v044-summary-grid" aria-label="管理總覽" style={{ width: '100%', maxWidth: 'none' }}>
      <article className="admin-metric purple settings-metric"><span>線上設定管理</span>{isSuper ? <button onClick={enableMaintenanceMode}>啟用維護模式</button> : <strong>僅超級管理員</strong>}</article>
      <AdminMetric title="數據抓取" value={`已抓 ${actualRounds} 局`} tone="cyan" />
      <AdminMetric title="資料庫" value={formatConnectionMetric(supabaseStatus, '資料庫')} tone={supabaseStatus.state === 'error' ? 'yellow' : 'green'} />
      <AdminMetric title="記憶中心" value={formatConnectionMetric(onlineCoreStatus, '記憶中心')} tone={onlineCoreStatus.state === 'error' ? 'yellow' : 'cyan'} />
    </section>

    <section className="admin-panel v015-auth-panel" aria-label="建立會員驗證密碼" style={{ width: '100%', maxWidth: 'none' }}>
      <p className="panel-label">授權管理</p>
      <h2>建立會員驗證密碼</h2>
      <div className="v015-form-grid">
        <label>會員帳號<input placeholder="請輸入會員帳號" value={memberAccount} onChange={(event) => setMemberAccount(event.target.value)} /></label>
        <label>代理帳號<input placeholder="請輸入代理帳號" value={displayManagerLabel} readOnly /></label>
        <label>方案天數<input aria-label="方案天數" type="number" min="1" max="30" value={String(clampedPlanDays)} onChange={(event) => setPlanDays(String(clampPlanDays(event.target.value)))} /></label>
        <label>流水號<input aria-label="流水號" value={serialNo} readOnly /></label>
      </div>
      <button className="primary create-auth" disabled={!canManageCodes} onClick={createAuthorization}>建立授權</button>
      <div className="v015-result-grid">
        <div className="serial-box member-box">會員帳號：{latestMember || '尚未建立'}</div>
        <div className="serial-box code-box">驗證碼：{latestCode || '尚未建立'}</div>
      </div>
      <div className="v015-copy-row">
        <button onClick={() => copyText(latestMember || '', '會員帳號已複製')}>複製帳號</button><button onClick={() => copyText(latestCode || '', '驗證碼已複製')}>複製驗證碼</button><button onClick={() => copyText(`會員帳號：${latestMember}\n驗證碼：${latestCode}`, '帳密已複製')}>複製帳密</button>
      </div>
      <div className="auth-summary-mini v015-date-grid">
        <span><b>建立日期</b><strong>{startDate}</strong></span>
        <span><b>到期日期</b><strong>{expiryDate}</strong></span>
        <span><b>方案天數</b><strong>{clampedPlanDays} 天</strong></span>
        <span><b>流水號</b><strong>{serialNo}</strong></span>
      </div>
    </section>

    <section className="v015-management-grid v019-scaled-lists" style={{ width: '100%', maxWidth: 'none' }}>
      <section className="admin-panel list-panel" aria-label="下級代理">
        <h2>下級代理</h2>
        <input className="search-input" placeholder="尋找代理帳號" value={agentSearch} onChange={(event) => setAgentSearch(event.target.value)} />
        <div className="admin-action-row compact agent-action-form"><input placeholder="輸入代理帳號尾碼" value={newAgentCode} onChange={(event) => setNewAgentCode(event.target.value)} /><select value={newAgentRole} onChange={(event) => setNewAgentRole(event.target.value as 'viewer' | 'agent' | 'manager')}>{roleOptions.map((role) => <option value={role} key={role}>{roleLabelText(role)}</option>)}</select><button disabled={!canManageAgents || agentActionBusy} onClick={createAgentFromForm}>新增帳號</button><button disabled={!canManageAgents || agentActionBusy} onClick={deleteSelectedAgents}>刪除選取帳號</button><button disabled={!canManageAgents || agentActionBusy} onClick={adjustSelectedAgents}>調整等級</button></div>
        <div className="scroll-list agent-list hierarchy-list">
          <div className="list-head agent-hierarchy-head"><span>展開</span><span>帳號</span><span>代理等級</span><span>增加代理</span></div>
          {filteredAgents.map((agent) => {
            const collapsible = hasAgentChildren(agents, agent.account)
            const collapsed = collapsedAgents.includes(agent.account)
            return <div className={`list-row agent-row hierarchy-row depth-${agent.depth ?? 0}`} key={agent.account}>
              <span className="agent-select-cell">
                <button className="collapse-agent" disabled={!collapsible} aria-label={`${collapsed ? '展開' : '收合'} ${agent.account}`} onClick={() => toggleCollapse(agent.account)}>{collapsible ? (collapsed ? '▸' : '▾') : '•'}</button>
                <input aria-label={`勾選 ${agent.account}`} type="checkbox" checked={selectedAgents.includes(agent.account)} onChange={() => toggleAgent(agent.account)} />
              </span>
              <span>{agent.account}</span><b className={agent.level.includes('管理員') ? 'green-text' : agent.level.includes('代理') ? 'yellow-text' : ''}>{agent.level}</b><button className="inline-add-agent" disabled={!canCreateUnder(agent.level, loginRoleName)} onClick={() => { setNewAgentCode(''); setNewAgentParent(agent.account); setNewAgentRole(defaultChildRole(agent.level)); notify(`請在上方輸入帳號尾碼，帳號將建立為 ${agent.account}-代理帳號`) }}>新增下級</button>
            </div>
          })}
        </div>
      </section>

      <section className="admin-panel list-panel" aria-label="已建立驗證碼">
        <h2>已建立驗證碼</h2>
        <input className="search-input" placeholder="尋找驗證碼" value={codeSearch} onChange={(event) => setCodeSearch(event.target.value)} />
        <div className="admin-action-row compact code-action-row">
          <button className="danger" disabled={!canManageCodes || codeActionBusy} onClick={deleteSelectedCodes}>刪除驗證碼</button>
          <button className="warning" disabled={!canManageCodes || codeActionBusy} onClick={suspendSelectedCodes}>暫停驗證碼</button>
          <button className="activate" disabled={!canManageCodes || codeActionBusy} onClick={activateSelectedCodes}>開啟驗證碼</button>
          <button className="extend" disabled={!canManageCodes || codeActionBusy} onClick={extendSelectedCodes}>延長驗證碼</button>
        </div>
        <div className="scroll-list code-list">
          {filteredCodes.map((row) => <div className="list-row code-row" key={row.member}>
            <input aria-label={`勾選 ${row.code}`} type="checkbox" checked={selectedCodeMembers.includes(row.code)} onChange={() => toggleCode(row.code)} />
            <span>{row.member}</span><b>{row.code}</b><em>{row.status}｜{row.remain}</em>
            <input placeholder="延長1-30天" />
          </div>)}
        </div>
      </section>
    </section>

    <section className="admin-panel list-panel weak-panel" aria-label="弱桌分析">
      <h2>弱桌分析</h2>
      <div className="weak-grid">{tableDisplayOrder.map((name, index) => <article className="weak-card" key={name}><strong>{name}桌</strong><span>主命中率 {cloudDataStatus.tableStats?.[index]?.mainHitRate ?? tableHitRate(strategyAnalysis, index, 'main')}</span><span>副命中率 {cloudDataStatus.tableStats?.[index]?.sideHitRate ?? tableHitRate(strategyAnalysis, index, 'side')}</span></article>)}</div>
    </section>

    <section className="admin-panel list-panel report-panel" aria-label="線上記憶與報表">
      <h2>線上記憶與報表</h2>
      <div className="report-wide-row report-head"><span>日期</span><span>當日總局數</span><span>莊命中率</span><span>閒命中率</span><span>和命中率</span><span>龍寶命中率</span><span>對子命中率</span><span>超六命中率</span></div>
      {(dailyReports.length ? dailyReports : [latestReport]).filter(Boolean).map((report: any) => <div className="report-wide-row" key={report.date ?? report.created_at ?? 'latest'}><span>{report.date ?? new Date().toLocaleDateString('zh-TW')}</span><b>{report.rounds ?? actualRounds}局</b><span>{categoryHitRate(report, 'banker')}</span><span>{categoryHitRate(report, 'player')}</span><span>{categoryHitRate(report, 'tie')}</span><span>{categoryHitRate(report, 'dragon')}</span><span>{categoryHitRate(report, 'pair')}</span><span>{categoryHitRate(report, 'six')}</span></div>)}
    </section>

  </main>
}

function useInactivityLogout(mode: 'admin' | 'member' | null) {
  useEffect(() => {
    if (!mode) return
    const timeoutMs = 10 * 60 * 1000
    let timer: ReturnType<typeof setTimeout>
    const clearLogin = () => {
      if (mode === 'admin') {
        window.sessionStorage.removeItem('darven-admin-account')
        window.sessionStorage.removeItem('darven-admin-role')
        window.sessionStorage.removeItem('darven-admin-session-token')
        window.sessionStorage.removeItem('darven-admin-session-expires-at')
        window.sessionStorage.removeItem('darven_admin_login')
        if (window.location.pathname === '/admin') window.location.assign('/admin-login')
        return
      }
      clearMemberSession()
      if (window.location.pathname === '/' || window.location.pathname === '') window.location.assign('/login')
    }
    const reset = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(clearLogin, timeoutMs)
    }
    ;['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'].forEach((event) => window.addEventListener(event, reset, { passive: true }))
    reset()
    return () => {
      window.clearTimeout(timer)
      ;['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'].forEach((event) => window.removeEventListener(event, reset))
    }
  }, [mode])
}

function normalizeRole(role?: string | null) {
  const value = String(role ?? '').toLowerCase()
  if (value.includes('total') || value.includes('super')) return 'super'
  if (value.includes('manager') || value.includes('管理')) return 'manager'
  if (value.includes('agent') || value.includes('代理')) return 'agent'
  if (value.includes('viewer') || value.includes('觀察')) return 'viewer'
  return 'viewer'
}

function roleLabelText(role: string) {
  if (role === 'manager') return '管理員'
  if (role === 'agent') return '代理'
  return '觀察者'
}

function allowedChildRoles(role: string) {
  if (role === 'super') return ['manager', 'agent', 'viewer']
  if (role === 'manager') return ['agent', 'viewer']
  return []
}

function canCreateUnder(parentLevel: string, loginRoleName: string) {
  if (!['super','manager'].includes(loginRoleName)) return false
  return parentLevel.includes('超級') || parentLevel.includes('管理員')
}

function defaultChildRole(parentLevel: string): 'viewer' | 'agent' | 'manager' {
  if (parentLevel.includes('超級')) return 'manager'
  if (parentLevel.includes('管理員')) return 'agent'
  return 'viewer'
}

function categoryHitRate(report: any, key: string) {
  const direct = report?.[`${key}_hit_rate`] ?? report?.[`${key}HitRate`] ?? report?.raw_summary?.[`${key}_hit_rate`] ?? report?.metadata?.[`${key}_hit_rate`]
  if (direct != null) return formatPercentValue(direct)
  if (key === 'banker' || key === 'player') return report?.main_hit_rate != null ? formatPercentValue(report.main_hit_rate) : '-'
  if (['dragon','pair','six','tie'].includes(key)) return formatSideHitRate(report)
  return '-'
}

function formatPercentValue(value: any) {
  if (value == null || value === '-') return '-'
  const text = String(value)
  return text.endsWith('%') ? text : `${text}%`
}

function clampPlanDays(value: string | number) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 30
  return Math.min(30, Math.max(1, Math.floor(parsed)))
}

function findLowestAvailableSerial(codes: CodeRow[], agentCode: string) {
  const used = new Set(codes
    .map((row) => row.code.match(new RegExp(`^${escapeRegExp(agentCode)}_(\\d+)$`))?.[1])
    .filter(Boolean)
    .map((value) => Number(value)))
  for (let index = 1; index <= 999; index += 1) {
    if (!used.has(index)) return String(index).padStart(3, '0')
  }
  return '999'
}

function normalizeAgents(rows: Array<Partial<AgentRow>>, loginAgent: string): AgentRow[] {
  const normalized: AgentRow[] = rows.map((row, index) => ({
    account: String(row.account ?? `Agent${String(index + 1).padStart(3, '0')}`),
    level: row.level ?? '代理',
    permission: row.permission ?? '可建碼',
    parent: row.parent,
    depth: row.depth,
  }))
  const scoped = loginAgent.toLowerCase() === SUPER_ADMIN
    ? normalized.filter((row) => !row.level.includes('超級'))
    : normalized.filter((row) => row.account !== loginAgent && isDescendant(row, loginAgent, normalized))
  return sortAgentsByHierarchy(scoped)
}

function sortAgentsByHierarchy(agents: AgentRow[]) {
  const byParent = new Map<string, AgentRow[]>()
  const accounts = new Set(agents.map((agent) => agent.account))
  for (const agent of agents) {
    const parent = agent.parent && accounts.has(agent.parent) ? agent.parent : '__root__'
    if (!byParent.has(parent)) byParent.set(parent, [])
    byParent.get(parent)!.push(agent)
  }
  for (const list of byParent.values()) list.sort((a, b) => a.account.localeCompare(b.account, 'zh-Hant-u-nu-latn'))
  const output: AgentRow[] = []
  const seen = new Set<string>()
  const walk = (parent: string, depth: number) => {
    for (const agent of byParent.get(parent) ?? []) {
      if (seen.has(agent.account)) continue
      seen.add(agent.account)
      output.push({ ...agent, depth })
      walk(agent.account, depth + 1)
    }
  }
  walk('__root__', 0)
  for (const agent of agents) if (!seen.has(agent.account)) output.push({ ...agent, depth: Math.max(0, agent.depth ?? inferAgentDepth(agent.level)) })
  return output
}

function isDescendant(row: AgentRow, ancestor: string, agents: AgentRow[]) {
  let parent = row.parent
  const seen = new Set<string>()
  while (parent) {
    if (seen.has(parent)) return false
    seen.add(parent)
    if (parent === ancestor) return true
    parent = agents.find((agent) => agent.account === parent)?.parent
  }
  return false
}

function hasAgentChildren(agents: AgentRow[], account: string) {
  return agents.some((agent) => agent.parent === account)
}

function filterCollapsedAgents(agents: AgentRow[], collapsed: string[]) {
  return agents.filter((agent) => {
    let parent = agent.parent
    const seen = new Set<string>()
    while (parent) {
      if (seen.has(parent)) return true
      seen.add(parent)
      if (collapsed.includes(parent)) return false
      parent = agents.find((item) => item.account === parent)?.parent
    }
    return true
  })
}

function inferAgentDepth(level: string) {
  if (level.includes('超級')) return 0
  if (level.includes('管理員')) return 1
  if (level.includes('觀察')) return 3
  return 2
}

function filterAgents(agents: AgentRow[], query: string) {
  const text = query.trim().toLowerCase()
  if (!text) return agents
  return agents.filter((agent) => `${agent.account} ${agent.level} ${agent.permission}`.toLowerCase().includes(text))
}

function filterCodes(codes: CodeRow[], query: string) {
  const text = query.trim().toLowerCase()
  const sorted = [...codes].sort((a, b) => String(a.agentCode ?? a.code.split('_')[0]).localeCompare(String(b.agentCode ?? b.code.split('_')[0])) || a.code.localeCompare(b.code))
  if (!text) return sorted
  return sorted.filter((row) => `${row.member} ${row.code} ${row.status} ${row.remain}`.toLowerCase().includes(text))
}

function pruneExpiredCodes(codes: CodeRow[]) {
  const now = new Date()
  return codes.filter((row) => {
    if (row.expiresOn) {
      const expiry = new Date(`${row.expiresOn}T00:00:00`)
      expiry.setDate(expiry.getDate() + 3)
      if (now > expiry) return false
    }
    if (row.status === '暫停中' && row.suspendedAt) {
      const suspended = new Date(`${row.suspendedAt}T00:00:00`)
      suspended.setDate(suspended.getDate() + 7)
      if (now > suspended) return false
    }
    return true
  })
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildChildAgentAccount(parentCode: string, rawCode: string) {
  const parent = String(parentCode || SUPER_ADMIN).trim()
  const child = String(rawCode || '').trim().replace(/^[-\s]+|[-\s]+$/g, '')
  if (!child) return parent ? `${parent}-代理帳號` : '代理帳號'
  if (parent && child.toLowerCase().startsWith(`${parent.toLowerCase()}-`)) return child
  return parent ? `${parent}-${child}` : child
}

function buildLicenseCode(agentCode: string, memberAccount: string, runningNo: string) {
  const safeAgent = String(agentCode || SUPER_ADMIN).replace(/[^A-Za-z0-9]/g, '') || SUPER_ADMIN
  const letters = safeAgent.match(/[A-Za-z]+/)?.[0] ?? 'dv'
  const agentDigits = safeAgent.replace(/\D/g, '')
  const memberDigits = memberAccount.match(/\d+/)?.[0] ?? ''
  const digits = (agentDigits || memberDigits || '0001').slice(-4).padStart(4, '0')
  return `${letters}${digits}_${runningNo || '001'}`
}

function rolePermission(role: string) {
  if (role === 'manager') return '可開代理 / 可建碼'
  if (role === 'viewer') return '僅可觀察'
  return '可建碼'
}


function formatSideHitRate(report: any) {
  const value = report?.side_hit_rate ?? report?.sideHitRate ?? report?.bonus_hit_rate
  return value != null ? `${value}%` : '-'
}

function tableHitRate(analysis: OnlineStrategyAnalysis, index: number, kind: 'main' | 'side') {
  const tableName = tableDisplayOrder[index]
  const row = [...(analysis.weakTables ?? []), ...(analysis.strongTables ?? []), ...(analysis.watchTables ?? [])].find((item: any) => String(item.name ?? '').includes(tableName)) as any
  const value = kind === 'main' ? row?.mainHitRate ?? row?.hitRate : row?.sideHitRate
  return value != null ? `${value}%` : '-'
}

function formatConnectionMetric(status: { state: string; message: string }, label: string) {
  if (status.state === 'connected') return '已連線'
  if (status.state === 'error') return status.message.replace(`${label} `, '').replace('Supabase ', '').replace('SUPABASE', '資料庫')
  if (status.state === 'connecting') return '檢查中'
  return status.message || '未設定'
}

function AdminMetric({ title, value, tone }: { title: string; value: string; tone: 'green' | 'cyan' | 'purple' | 'yellow' }) { return <article className={`admin-metric ${tone}`}><span>{title}</span><strong>{value}</strong></article> }
function Stat({ title, value, tone, accent = false }: { title: string; value: string; tone?: 'Banker' | 'Player' | 'Tie'; accent?: boolean }) { return <article className={`stat-card result-stat centered-stat ${tone ?? ''} ${accent ? 'accent' : ''}`}><span>{title}</span><strong>{value}</strong></article> }
function PredictionMetric({ title, value, tone, active = false }: { title: string; value: number | null; tone: 'Banker' | 'Player' | 'Tie'; active?: boolean }) { return <article className={`prediction-metric ${tone} ${active ? 'active' : ''}`} aria-label={`${title}預測`}><span>{title}</span><strong className="probability-value">{value == null ? '等待' : `${value}%`}</strong></article> }
function PredictionHistoryTable({ history }: { history: TableUiHistory | null }) {
  const predictions = [...(history?.settledPredictions ?? [])].sort((left, right) => left.round - right.round).slice(-10)
  const outcomeLabel = { banker: '莊', player: '閒', tie: '和' } as const
  const shoe = String(history?.shoe ?? '')
  return <div className="prediction-history-block">
    <h2 className="prediction-history-title">近十局預測紀錄</h2>
    <div className="prediction-history-scroll">
      <table className="prediction-history" aria-label="近十局預測紀錄">
      <tbody>
        <tr><th scope="row">局數</th>{predictions.map((item) => <td key={`${shoe}:${item.round}:round`}>第{item.round}局</td>)}</tr>
        <tr><th scope="row">AI預測</th>{predictions.map((item) => <td className={item.predictedResult} key={`${shoe}:${item.round}:prediction`}>{outcomeLabel[item.predictedResult]}</td>)}</tr>
        <tr><th scope="row">實際開獎</th>{predictions.map((item) => <td className={item.actualResult} key={`${shoe}:${item.round}:actual`}>{outcomeLabel[item.actualResult]}</td>)}</tr>
        <tr><th scope="row">結果</th>{predictions.map((item) => <td className={item.isHit ? 'hit' : 'miss'} key={`${shoe}:${item.round}:hit`}>{item.isHit ? '命中' : '未中'}</td>)}</tr>
      </tbody>
    </table>
    </div>
  </div>
}

function RoadCard({ title, subtitle, children }: { title: string; subtitle: React.ReactNode; children: React.ReactNode }) { return <section className="road-card"><div className="card-heading"><h2>{title}</h2><span>{subtitle}</span></div>{children}</section> }
