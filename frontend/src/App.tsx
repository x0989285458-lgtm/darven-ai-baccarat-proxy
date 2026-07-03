import { useEffect, useMemo, useRef, useState } from 'react'
import { mockTables } from './data/mockTables'
import { LiveRoadClient, type LiveTable } from './lib/liveClient'
import { applyAskRoadWeighting, calculatePrediction, calculateBonusPredictions, parseBeadPlate, parseBigRoad } from './lib/roadParser'
import { checkSupabaseConnection, isSupabaseConfigured, supabaseConfig } from './lib/supabaseClient'
import { checkOnlineCoreStatus, getOnlineMemoryCenter, getOnlineStrategyAnalysis, updateOnlineAppSetting, type OnlineCoreStatus, type OnlineMemoryCenter, type OnlineStrategyAnalysis } from './lib/onlineCoreClient'
import { agentLogin, createOnlineAgent, createOnlineLicense, deleteOnlineAgents, deleteOnlineLicense, extendOnlineLicense, getCloudDataStatus, getOnlineLicenseStatus, memberLogin, setOnlineLicenseStatus, type OnlineLicenseStatus } from './lib/onlineLicenseClient'

const defaultToken = 'decd8bec9f968ef4f67a437f80430727'
const SUPER_ADMIN = 'dv1788'
const sideThresholds = { playerDragon: 40, playerPair: 25, superSix: 32, bankerPair: 25, bankerDragon: 38 }
const label = { Banker: '莊', Player: '閒', Tie: '和' }
const tableDisplayOrder = ['1', '2', '3', '4', '5', '6', '7', '8', '9']

function pct(count: number, total: number) {
  if (!total) return 0
  return Math.round((count / total) * 100)
}
function tableNumber(table: LiveTable, index: number) {
  if (tableDisplayOrder[index]) return tableDisplayOrder[index]
  const match = String(table.table_name ?? table.name ?? table.id).match(/\d+/)
  return match?.[0] ? String(Number(match[0])) : String(index + 1)
}

export default function App() {
  const path = window.location.pathname
  const memberLoggedIn = window.sessionStorage.getItem('darven-member-login') === 'yes'
  const adminLoggedIn = Boolean(window.sessionStorage.getItem('darven-admin-account'))
  const [tables, setTables] = useState<LiveTable[]>([])
  const [stableSelected, setStableSelected] = useState<LiveTable | null>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [status, setStatus] = useState({ state: 'disconnected', message: '等待雲端資料來源' })
  const [supabaseStatus, setSupabaseStatus] = useState({ state: isSupabaseConfigured ? 'connecting' : 'error', message: isSupabaseConfigured ? 'Supabase 檢查中' : 'Supabase 未設定' })
  const [onlineCoreStatus, setOnlineCoreStatus] = useState<OnlineCoreStatus>({ state: 'connecting', message: '記憶中心檢查中' })
  const [updatedAt, setUpdatedAt] = useState(new Date())
  const client = useRef<LiveRoadClient | null>(null)
  const visibleTables = useMemo(() => tables.slice(0, 9), [tables])
  const selectedSafeIndex = Math.min(selectedIndex, Math.max(visibleTables.length - 1, 0))
  const selected = visibleTables[selectedSafeIndex] ?? tables[0]
  useEffect(() => {
    if (isCompleteTableUpdate(selected)) setStableSelected(selected)
  }, [selected])
  const displaySelected = stableSelected ?? selected
  const fullRoad = useMemo(() => parseBeadPlate(displaySelected?.trend.bead_plate2 ?? ''), [displaySelected])
  const allBigRoad = useMemo(() => parseBigRoad(displaySelected?.trend.big2 ?? ''), [displaySelected])
  const bigRoad = useMemo(() => markBigRoadTies(allBigRoad), [allBigRoad])
  const prediction = useMemo(() => calculatePrediction({
    beadCells: fullRoad,
    bigRoadCells: bigRoad,
    askRoad: displaySelected?.trend,
    tableStats: {
      total_round_banker: displaySelected?.trend.total_round_banker,
      total_round_player: displaySelected?.trend.total_round_player,
      total_round_tie: displaySelected?.trend.total_round_tie,
    },
  }), [fullRoad, bigRoad, displaySelected])
  const bonusPredictions = useMemo(() => calculateBonusPredictions(fullRoad, displaySelected?.trend), [fullRoad, displaySelected])
  const outcomePredictions = useMemo(() => {
    const banker = Number(displaySelected?.trend.total_round_banker ?? 0)
    const player = Number(displaySelected?.trend.total_round_player ?? 0)
    const tie = Number(displaySelected?.trend.total_round_tie ?? 0)
    const total = banker + player + tie
    return applyAskRoadWeighting({ banker: pct(banker, total), player: pct(player, total), tie: pct(tie, total) }, displaySelected?.trend)
  }, [displaySelected])

  useEffect(() => () => client.current?.disconnect(false), [])
  useEffect(() => {
    if (path === '/login' || path === '/admin-login' || path === '/後台登入') return
    if ((path === '/' || path === '') && !memberLoggedIn) return
    if (path === '/admin' && !adminLoggedIn) return
    let active = true
    checkSupabaseConnection().then((result) => {
      if (!active) return
      setSupabaseStatus({ state: result.ok ? 'connected' : 'error', message: result.message })
    })
    const loadCoreStatus = () => checkOnlineCoreStatus().then((result) => {
      if (!active) return
      setOnlineCoreStatus(result)
      enforceMaintenanceLogout(result, path, client.current)
    })
    loadCoreStatus()
    const timer = window.setInterval(loadCoreStatus, 5000)
    return () => { active = false; window.clearInterval(timer) }
  }, [path, memberLoggedIn, adminLoggedIn])

  const start = () => {
    client.current?.disconnect(false)
    client.current = new LiveRoadClient({
      token: defaultToken,
      onTables: (next) => {
        if (next.length) {
          setTables(next)
          setSelectedIndex((currentIndex) => Math.min(currentIndex, Math.max(next.slice(0, 9).length - 1, 0)))
          setUpdatedAt(new Date())
        }
      },
      onStatus: setStatus,
    })
    client.current.connect()
  }

  useEffect(() => {
    if ((path === '/' || path === '') && memberLoggedIn) start()
    return () => client.current?.disconnect(false)
  }, [path, memberLoggedIn])

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

  if ((path === '/' || path === '') && !memberLoggedIn) return <LoginApp />

  if (!displaySelected) return <WaitingForCloudData status={status} supabaseStatus={supabaseStatus} />

  return <main className="app-shell">
    <header className="topbar">
      <div className="promo-block" aria-label="官方資訊">
        <strong>免費智慧百家預測軟體</strong>
        <span>私訊官方賴@Dv1788</span>
      </div>
      <div className="brand" aria-label="主標題">
        <h1>智慧百家預測軟體</h1>
        <p className="eyebrow">瑞文智慧版 010</p>
      </div>
      <div className="header-meta"><span className={`status ${supabaseStatus.state}`} title={supabaseConfig.projectRef}>{supabaseStatus.message}</span></div>
    </header>
    <div className="workspace">
      <aside className="sidebar balanced-sidebar-line" aria-label="桌號與資料選擇">
        <nav className="table-list" aria-label="桌號選擇">
          {visibleTables.map((table, index) => <button className={`table-item ${index === selectedSafeIndex ? 'active' : ''}`} key={`${String(table.id)}-${index}`} onClick={() => setSelectedIndex(index)}>
            MT百家樂第{tableNumber(table, index)}桌 第{table.trend.current_round ?? 0}局
          </button>)}
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
            <PredictionMetric title="閒龍寶" value={bonusPredictions.playerDragon} tone="Player" active={bonusPredictions.playerDragon >= sideThresholds.playerDragon} />
            <PredictionMetric title="閒對" value={bonusPredictions.playerPair} tone="Player" active={bonusPredictions.playerPair >= sideThresholds.playerPair} />
            <PredictionMetric title="超六" value={bonusPredictions.superSix} tone="Tie" active={bonusPredictions.superSix >= sideThresholds.superSix} />
            <PredictionMetric title="莊對" value={bonusPredictions.bankerPair} tone="Banker" active={bonusPredictions.bankerPair >= sideThresholds.bankerPair} />
            <PredictionMetric title="莊龍寶" value={bonusPredictions.bankerDragon} tone="Banker" active={bonusPredictions.bankerDragon >= sideThresholds.bankerDragon} />
          </div>
          <div className="prediction-row main-probability-row" aria-label="莊閒預測機率">
            <PredictionMetric title="閒" value={outcomePredictions.player} tone="Player" active={prediction.recommendation === 'Player'} />
            <PredictionMetric title="和" value={outcomePredictions.tie} tone="Tie" active={label[prediction.recommendation] === '和'} />
            <PredictionMetric title="莊" value={outcomePredictions.banker} tone="Banker" active={prediction.recommendation === 'Banker'} />
          </div>
          <h2 className="ai-prediction-line">智慧預測:<span className={prediction.recommendation}>{label[prediction.recommendation]}</span></h2>
          <strong className="ai-confidence-line">智慧信心值:{prediction.confidence}%</strong>
        </section>
        <div className="roads-grid single-road">
          <RoadCard title="大路" subtitle="紅圈＝莊　藍圈＝閒">
            <div className="big-road classic-road" aria-label="傳統大路">
              {bigRoad.map((cell) => <div style={{ gridColumn: cell.column + 1, gridRow: cell.row + 1 }} title={cell.hasTie ? `${cell.outcome} 和局` : cell.outcome} className={`big-cell ${cell.outcome} ${cell.hasTie ? 'tie-mark' : ''}`} key={`${cell.code}-${cell.column}-${cell.row}`}>{label[cell.outcome]}</div>)}
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
    window.sessionStorage.removeItem('darven-member-login')
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
      window.sessionStorage.removeItem('darven_admin_login')
      if (window.location.pathname !== '/admin-login') window.location.assign('/admin-login')
    }
  }
}

function WaitingForCloudData({ status, supabaseStatus }: { status: { state: string; message: string }; supabaseStatus: { state: string; message: string } }) {
  return <main className="app-shell waiting-shell">
    <header className="topbar">
      <div className="promo-block" aria-label="官方資訊"><strong>免費智慧百家預測軟體</strong><span>私訊官方賴@Dv1788</span></div>
      <div className="brand" aria-label="主標題"><h1>智慧百家預測軟體</h1><p className="eyebrow">瑞文智慧版 010</p></div>
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
        setLoginMessage('登入失敗，請確認會員帳號與驗證密碼')
        return
      }
      window.sessionStorage.setItem('darven-member-login', 'yes')
      setLoginMessage('登入成功，正在進入前台')
      window.location.assign('/')
    } catch {
      setLoginMessage('登入失敗，請確認本機代理是否啟動')
    }
  }
  return <main className="login-shell">
    <section className="login-card" aria-label="前台登入驗證">
      <h1>瑞文智慧預測百家</h1>
      <strong>免費版請私訊官方賴@Dv1788</strong>
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
      setLoginMessage('登入成功，正在進入後台')
      window.location.assign('/admin')
    } catch {
      setLoginMessage('登入失敗，請確認後端 API 是否上線')
    }
  }
  return <main className="login-shell">
    <section className="login-card" aria-label="管理後台登入">
      <h1 className="admin-login-title">智慧百家管理後台登入</h1>
      <strong>瑞文智慧後台管理</strong>
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
  const [toast, setToast] = useState('')
  const [memoryCenter, setMemoryCenter] = useState<OnlineMemoryCenter>({ state: 'connecting', items: [], reports: [], strategies: [] })
  const [strategyAnalysis, setStrategyAnalysis] = useState<OnlineStrategyAnalysis>({ state: 'connecting', strategyRows: [], weakTables: [], strongTables: [], watchTables: [], suggestions: [] })
  const [licenseStatus, setLicenseStatus] = useState<OnlineLicenseStatus>({ managers: [], agents: [], plans: [], licenses: [], agentRows: [], licenseRows: [] })
  const [cloudDataStatus, setCloudDataStatus] = useState<{ mtAutoLoginEnabled?: boolean; message?: string; tableCount?: number; todayRoundCount?: number; tableStats?: Array<{ tableId: string; mainHitRate: string; sideHitRate: string }>; dailyReports?: Array<Record<string, any>> }>({ mtAutoLoginEnabled: false, message: '資料抓取待確認', todayRoundCount: 0, tableStats: [], dailyReports: [] })
  useEffect(() => {
    const loadReports = () => { getOnlineMemoryCenter().then(setMemoryCenter); getOnlineStrategyAnalysis().then(setStrategyAnalysis); getCloudDataStatus().then(setCloudDataStatus) }
    loadReports()
    const timer = window.setInterval(loadReports, 300000)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => {
    if (onlineCoreStatus.maintenanceMode && !isSuper) logoutAdmin()
  }, [onlineCoreStatus.maintenanceMode, isSuper])
  useEffect(() => { getOnlineLicenseStatus(displayManager).then((status) => {
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
    const result = await createOnlineLicense({ memberAccount: displayMember, code: nextCode, agentCode: displayManager, durationDays: clampedPlanDays, adminAccount: displayManager })
    setLatestMember(displayMember)
    setLatestCode(result.row?.code ?? nextCode)
    const nextRows = await getOnlineLicenseStatus(displayManager)
    setLicenseStatus(nextRows)
    if (nextRows.licenseRows.length) setCodes(pruneExpiredCodes(nextRows.licenseRows as CodeRow[]))
    else setCodes((rows) => pruneExpiredCodes([{ member: displayMember, code: result.row?.code ?? nextCode, status: '啟用中', remain: `${clampedPlanDays}天` }, ...rows]))
  }
  const refreshLicenses = async () => {
    const nextRows = await getOnlineLicenseStatus(displayManager)
    setLicenseStatus(nextRows)
    if (nextRows.licenseRows.length) setCodes(pruneExpiredCodes(nextRows.licenseRows as CodeRow[]))
    return nextRows
  }
  const toggleCode = (member: string) => setSelectedCodeMembers((current) => current.includes(member) ? current.filter((item) => item !== member) : [...current, member])
  const toggleAgent = (account: string) => setSelectedAgents((current) => current.includes(account) ? current.filter((item) => item !== account) : [...current, account])
  const toggleCollapse = (account: string) => setCollapsedAgents((current) => current.includes(account) ? current.filter((item) => item !== account) : [...current, account])
  const logoutAdmin = () => {
    window.sessionStorage.removeItem('darven-admin-account')
    window.sessionStorage.removeItem('darven_admin_login')
    window.location.assign('/admin-login')
  }
  const selectedCodeRows = () => codes.filter((row) => selectedCodeMembers.includes(row.member))
  const deleteSelectedCodes = async () => {
    if (!canManageCodes) return notify('此角色不能管理驗證碼')
    const rows = selectedCodeRows()
    setCodes((current) => current.filter((row) => !selectedCodeMembers.includes(row.member)))
    setSelectedCodeMembers([])
    await Promise.all(rows.map((row) => deleteOnlineLicense({ code: row.code, adminAccount: displayManager }).catch(() => null)))
  }
  const suspendSelectedCodes = async () => {
    if (!canManageCodes) return notify('此角色不能管理驗證碼')
    const rows = selectedCodeRows()
    await Promise.all(rows.map((row) => setOnlineLicenseStatus({ code: row.code, status: 'suspended', adminAccount: displayManager }).catch(() => null)))
    setCodes((current) => current.map((row) => selectedCodeMembers.includes(row.member) ? { ...row, status: '暫停中' } : row))
    await refreshLicenses()
  }
  const extendSelectedCodes = async () => {
    if (!canManageCodes) return notify('此角色不能管理驗證碼')
    const rows = selectedCodeRows()
    await Promise.all(rows.map((row) => extendOnlineLicense({ code: row.code, days: clampedPlanDays, adminAccount: displayManager }).catch(() => null)))
    await refreshLicenses()
  }
  const notify = (message: string) => { setToast(message); window.alert(message); window.setTimeout(() => setToast(''), 2200) }
  const copyText = async (text: string, message: string) => { await navigator.clipboard?.writeText(text); notify(message) }
  const createAgentFromForm = async () => {
    const code = newAgentCode.trim()
    if (!canManageAgents) return notify('此角色不能開設代理')
    if (!code) return notify('請輸入帳號')
    if (!roleOptions.includes(newAgentRole)) return notify('下級等級不能高於或平級於上級')
    await createOnlineAgent({ code, name: code, role: newAgentRole, parentCode: displayManager, adminAccount: displayManager, permission: rolePermission(newAgentRole) })
    setNewAgentCode('')
    await refreshLicenses()
    notify('代理帳號已建立')
  }
  const adjustSelectedAgents = async () => {
    if (!canManageAgents) return notify('此角色不能調整等級')
    if (!canManageAgents) return notify('此角色不能刪除代理')
    if (!selectedAgents.length) return notify('請先勾選代理')
    if (!roleOptions.includes(newAgentRole)) return notify('下級等級不能高於或平級於上級')
    await Promise.all(selectedAgents.map((code) => {
      const current = agents.find((agent) => agent.account === code)
      return createOnlineAgent({ code, name: code, role: newAgentRole, parentCode: current?.parent ?? displayManager, adminAccount: displayManager, permission: rolePermission(newAgentRole) })
    }))
    await refreshLicenses()
    notify('代理角色已調整')
  }
  const deleteSelectedAgents = async () => {
    if (!canManageAgents) return notify('此角色不能刪除代理')
    if (!selectedAgents.length) return
    await deleteOnlineAgents({ codes: selectedAgents, adminAccount: displayManager })
    setSelectedAgents([])
    await refreshLicenses()
  }
  const enableMaintenanceMode = async () => {
    if (!isSuper) return notify('只有超級管理員可以啟用維護模式')
    await updateOnlineAppSetting({ scope: 'frontend', key: 'ui_defaults', value: { maintenanceMode: true, enabledAt: new Date().toISOString() }, isPublic: true })
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
        <h1>智慧百家預測後台</h1>
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
        <div className="admin-action-row compact agent-action-form"><input placeholder="輸入帳號" value={newAgentCode} onChange={(event) => setNewAgentCode(event.target.value)} /><select value={newAgentRole} onChange={(event) => setNewAgentRole(event.target.value as 'viewer' | 'agent' | 'manager')}>{roleOptions.map((role) => <option value={role} key={role}>{roleLabelText(role)}</option>)}</select><button disabled={!canManageAgents} onClick={createAgentFromForm}>增加代理</button><button disabled={!canManageAgents} onClick={deleteSelectedAgents}>刪除代理</button><button disabled={!canManageAgents} onClick={adjustSelectedAgents}>調整等級</button></div>
        <div className="scroll-list agent-list hierarchy-list">
          <div className="list-head agent-hierarchy-head"><span></span><span>帳號</span><span>代理等級</span><span>增加代理</span></div>
          {filteredAgents.map((agent) => {
            const collapsible = hasAgentChildren(agents, agent.account)
            const collapsed = collapsedAgents.includes(agent.account)
            return <div className={`list-row agent-row hierarchy-row depth-${agent.depth ?? 0}`} key={agent.account}>
              <span className="agent-select-cell">
                {collapsible ? <button className="collapse-agent" aria-label={`${collapsed ? '展開' : '收合'} ${agent.account}`} onClick={() => toggleCollapse(agent.account)}>{collapsed ? '▶' : '▼'}</button> : <i />}
                <input aria-label={`勾選 ${agent.account}`} type="checkbox" checked={selectedAgents.includes(agent.account)} onChange={() => toggleAgent(agent.account)} />
              </span>
              <span>{agent.account}</span><b className={agent.level.includes('管理員') ? 'green-text' : agent.level.includes('代理') ? 'yellow-text' : ''}>{agent.level}</b><button className="inline-add-agent" disabled={!canCreateUnder(agent.level, loginRoleName)} onClick={() => { setNewAgentCode(''); setNewAgentRole(defaultChildRole(agent.level)); notify(`請在上方輸入帳號，將新增到 ${agent.account} 底下`) }}>增加代理</button>
            </div>
          })}
        </div>
      </section>

      <section className="admin-panel list-panel" aria-label="已建立驗證碼">
        <h2>已建立驗證碼</h2>
        <input className="search-input" placeholder="尋找驗證碼" value={codeSearch} onChange={(event) => setCodeSearch(event.target.value)} />
        <div className="admin-action-row compact code-action-row">
          <button className="danger" disabled={!canManageCodes} onClick={deleteSelectedCodes}>刪除驗證碼</button>
          <button className="warning" disabled={!canManageCodes} onClick={suspendSelectedCodes}>暫停驗證碼</button>
          <button className="extend" disabled={!canManageCodes} onClick={extendSelectedCodes}>延長驗證碼</button>
        </div>
        <div className="scroll-list code-list">
          {filteredCodes.map((row) => <div className="list-row code-row" key={row.member}>
            <input aria-label={`勾選 ${row.member}`} type="checkbox" checked={selectedCodeMembers.includes(row.member)} onChange={() => toggleCode(row.member)} />
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
    const timeoutMs = (mode === 'admin' ? 15 : 30) * 60 * 1000
    let timer: ReturnType<typeof setTimeout>
    const clearLogin = () => {
      if (mode === 'admin') {
        window.sessionStorage.removeItem('darven-admin-account')
        window.sessionStorage.removeItem('darven_admin_login')
        if (window.location.pathname === '/admin') window.location.assign('/admin-login')
        return
      }
      window.sessionStorage.removeItem('darven-member-login')
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

function isCompleteTableUpdate(table?: LiveTable) {
  const trend = table?.trend
  if (!trend) return false
  const round = Number(trend.current_round ?? 0)
  const road = String(trend.bead_plate2 ?? '') || String(trend.big2 ?? '')
  return round > 0 && road.length > 0
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

function markBigRoadTies(cells: ReturnType<typeof parseBigRoad>) {
  const visible: Array<ReturnType<typeof parseBigRoad>[number] & { hasTie?: boolean }> = []
  for (const cell of cells) {
    if (cell.outcome === 'Tie') {
      const last = visible.at(-1)
      if (last) last.hasTie = true
      continue
    }
    visible.push({ ...cell, hasTie: false })
  }
  return visible
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
  const scoped = loginAgent.toLowerCase() === SUPER_ADMIN ? normalized.filter((row) => !row.level.includes('超級')) : normalized.filter((row) => row.account !== loginAgent && isDescendant(row, loginAgent, normalized))
  return scoped.map((row) => ({ ...row, depth: Math.max(0, (row.depth ?? inferAgentDepth(row.level)) - (loginAgent.toLowerCase() === SUPER_ADMIN ? 1 : inferAgentDepth(normalized.find((agent) => agent.account === loginAgent)?.level ?? '管理員'))) }))
}

function isDescendant(row: AgentRow, ancestor: string, agents: AgentRow[]) {
  let parent = row.parent
  while (parent) {
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
    while (parent) {
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

function buildLicenseCode(agentCode: string, memberAccount: string, runningNo: string) {
  if (/\d/.test(agentCode)) return `${agentCode}_${runningNo || '001'}`
  const memberDigits = memberAccount.match(/\d+/)?.[0]?.padStart(4, '0').slice(-4) ?? '0001'
  return `${agentCode}${memberDigits}_${runningNo || '001'}`
}

function rolePermission(role: string) {
  if (role === 'manager') return '可開代理 / 可建碼'
  if (role === 'viewer') return '僅可觀察'
  return '可建碼'
}

function loginRole(account: string, agents: AgentRow[]) {
  if (account.toLowerCase() === SUPER_ADMIN) return 'super'
  const row = agents.find((agent) => agent.account === account)
  if (row?.level.includes('管理員')) return 'manager'
  if (row?.level.includes('觀察')) return 'viewer'
  return 'agent'
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
function PredictionMetric({ title, value, tone, active = false }: { title: string; value: number; tone: 'Banker' | 'Player' | 'Tie'; active?: boolean }) { return <article className={`prediction-metric ${tone} ${active ? 'active' : ''}`} aria-label={`${title}預測`}><span>{title}</span><strong className="probability-value">{value}%</strong></article> }
function RoadCard({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) { return <section className="road-card"><div className="card-heading"><h2>{title}</h2><span>{subtitle}</span></div>{children}</section> }
