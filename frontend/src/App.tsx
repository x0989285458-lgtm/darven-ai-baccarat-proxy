import { useEffect, useMemo, useRef, useState } from 'react'
import { mockTables } from './data/mockTables'
import { LiveRoadClient, type LiveTable } from './lib/liveClient'
import { applyAskRoadWeighting, calculatePrediction, calculateBonusPredictions, parseBeadPlate, parseBigRoad } from './lib/roadParser'
import { checkSupabaseConnection, isSupabaseConfigured, supabaseConfig } from './lib/supabaseClient'
import { checkOnlineCoreStatus, getOnlineMemoryCenter, getOnlineStrategyAnalysis, updateOnlineAppSetting, updateOnlineFeatureFlag, type OnlineCoreStatus, type OnlineMemoryCenter, type OnlineStrategyAnalysis } from './lib/onlineCoreClient'
import { agentLogin, createOnlineAgent, createOnlineLicense, deleteOnlineAgents, deleteOnlineLicense, extendOnlineLicense, getCloudDataStatus, getOnlineLicenseStatus, memberLogin, setOnlineLicenseStatus, type OnlineLicenseStatus } from './lib/onlineLicenseClient'

const defaultToken = 'decd8bec9f968ef4f67a437f80430727'
const label = { Banker: '莊', Player: '閒', Tie: '和' }
const tableDisplayOrder = ['1', '2', '3', '3A', '5', '6', '7', '8', '9']

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
  const [tables, setTables] = useState<LiveTable[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [status, setStatus] = useState({ state: 'disconnected', message: '等待雲端資料來源' })
  const [supabaseStatus, setSupabaseStatus] = useState({ state: isSupabaseConfigured ? 'connecting' : 'error', message: isSupabaseConfigured ? 'Supabase 檢查中' : 'Supabase 未設定' })
  const [onlineCoreStatus, setOnlineCoreStatus] = useState<OnlineCoreStatus>({ state: 'connecting', message: '記憶中心檢查中' })
  const [updatedAt, setUpdatedAt] = useState(new Date())
  const client = useRef<LiveRoadClient | null>(null)
  const visibleTables = useMemo(() => tables.slice(0, 9), [tables])
  const selectedSafeIndex = Math.min(selectedIndex, Math.max(visibleTables.length - 1, 0))
  const selected = visibleTables[selectedSafeIndex] ?? tables[0]
  const fullRoad = useMemo(() => parseBeadPlate(selected?.trend.bead_plate2 ?? ''), [selected])
  const allBigRoad = useMemo(() => parseBigRoad(selected?.trend.big2 ?? ''), [selected])
  const bigRoad = useMemo(() => markBigRoadTies(allBigRoad), [allBigRoad])
  const prediction = useMemo(() => calculatePrediction({
    beadCells: fullRoad,
    bigRoadCells: bigRoad,
    askRoad: selected?.trend,
    tableStats: {
      total_round_banker: selected?.trend.total_round_banker,
      total_round_player: selected?.trend.total_round_player,
      total_round_tie: selected?.trend.total_round_tie,
    },
  }), [fullRoad, bigRoad, selected])
  const bonusPredictions = useMemo(() => calculateBonusPredictions(fullRoad, selected?.trend), [fullRoad, selected])
  const outcomePredictions = useMemo(() => {
    const banker = Number(selected?.trend.total_round_banker ?? 0)
    const player = Number(selected?.trend.total_round_player ?? 0)
    const tie = Number(selected?.trend.total_round_tie ?? 0)
    const total = banker + player + tie
    return applyAskRoadWeighting({ banker: pct(banker, total), player: pct(player, total), tie: pct(tie, total) }, selected?.trend)
  }, [selected])

  useEffect(() => () => client.current?.disconnect(false), [])
  useEffect(() => {
    if (window.location.pathname === '/login') return
    let active = true
    checkSupabaseConnection().then((result) => {
      if (!active) return
      setSupabaseStatus({ state: result.ok ? 'connected' : 'error', message: result.message })
    })
    checkOnlineCoreStatus().then((result) => {
      if (!active) return
      setOnlineCoreStatus(result)
    })
    return () => { active = false }
  }, [])

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
    if (window.location.pathname === '/' || window.location.pathname === '') start()
    return () => client.current?.disconnect(false)
  }, [])

  useInactivityLogout(window.location.pathname === '/admin' ? 'admin' : window.location.pathname === '/' || window.location.pathname === '' ? 'member' : null)

  if (window.location.pathname === '/login') {
    return <LoginApp />
  }

  if (window.location.pathname === '/admin-login' || window.location.pathname === '/後台登入') {
    return <AdminLoginApp />
  }

  if (window.location.pathname === '/admin') {
    return <AdminApp tables={visibleTables} supabaseStatus={supabaseStatus} onlineCoreStatus={onlineCoreStatus} />
  }

  if (!selected) return <WaitingForCloudData status={status} supabaseStatus={supabaseStatus} />

  return <main className="app-shell">
    <header className="topbar">
      <div className="promo-block" aria-label="官方資訊">
        <strong>免費AI百家預測軟體</strong>
        <span>私訊官方賴@Dv1788</span>
      </div>
      <div className="brand" aria-label="主標題">
        <h1>AI百家預測軟體</h1>
        <p className="eyebrow">DarevnAI Version 010</p>
      </div>
      <div className="header-meta"><span className={`status ${supabaseStatus.state}`} title={supabaseConfig.projectRef}>{supabaseStatus.message}</span></div>
    </header>
    <div className="workspace">
      <aside className="sidebar balanced-sidebar-line" aria-label="桌號與資料選擇">
        <section className="turnstile"><span>Cloudflare Turnstile</span><code>sitekey: placeholder</code><small>正式登入驗證碼預留區塊</small></section>
        <nav className="table-list" aria-label="桌號選擇">
          {visibleTables.map((table, index) => <button className={`table-item ${index === selectedSafeIndex ? 'active' : ''}`} key={`${String(table.id)}-${index}`} onClick={() => setSelectedIndex(index)}>
            MT百家樂第{tableNumber(table, index)}桌 第{table.trend.current_round ?? 0}局
          </button>)}
        </nav>
      </aside>
      <section className="content">
        <div className="stats-grid" aria-label="統計資訊">
          <Stat title="閒" value={String(selected.trend.total_round_player ?? 0)} tone="Player" />
          <Stat title="和" value={String(selected.trend.total_round_tie ?? 0)} tone="Tie" />
          <Stat title="莊" value={String(selected.trend.total_round_banker ?? 0)} tone="Banker" />
        </div>
        <section className="prediction-card" aria-label="AI預測結果">
          <div className="prediction-row side-prediction-row" aria-label="副項目預測機率">
            <PredictionMetric title="閒龍寶" value={bonusPredictions.playerDragon} tone="Player" />
            <PredictionMetric title="閒對" value={bonusPredictions.playerPair} tone="Player" />
            <PredictionMetric title="超六" value={bonusPredictions.superSix} tone="Tie" />
            <PredictionMetric title="莊對" value={bonusPredictions.bankerPair} tone="Banker" />
            <PredictionMetric title="莊龍寶" value={bonusPredictions.bankerDragon} tone="Banker" />
          </div>
          <div className="prediction-row main-probability-row" aria-label="莊閒預測機率">
            <PredictionMetric title="閒" value={outcomePredictions.player} tone="Player" />
            <PredictionMetric title="和" value={outcomePredictions.tie} tone="Tie" />
            <PredictionMetric title="莊" value={outcomePredictions.banker} tone="Banker" />
          </div>
          <h2 className="ai-prediction-line">AI預測:<span className={prediction.recommendation}>{label[prediction.recommendation]}</span></h2>
          <strong className="ai-confidence-line">AI信心值:{prediction.confidence}%</strong>
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

function WaitingForCloudData({ status, supabaseStatus }: { status: { state: string; message: string }; supabaseStatus: { state: string; message: string } }) {
  return <main className="app-shell waiting-shell">
    <header className="topbar">
      <div className="promo-block" aria-label="官方資訊"><strong>免費AI百家預測軟體</strong><span>私訊官方賴@Dv1788</span></div>
      <div className="brand" aria-label="主標題"><h1>AI百家預測軟體</h1><p className="eyebrow">DarevnAI Version 010</p></div>
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
  const [memberAccount, setMemberAccount] = useState('')
  const [verificationPassword, setVerificationPassword] = useState('')
  const [loginMessage, setLoginMessage] = useState('')
  const submitLogin = async () => {
    setLoginMessage('登入驗證中')
    try {
      const result = await memberLogin({ memberAccount, verificationPassword })
      if (!result.ok) {
        setLoginMessage('登入失敗，請確認會員帳號與驗證密碼')
        return
      }
      window.sessionStorage.setItem('darven-member-login', 'yes')
      setLoginMessage('登入成功，正在進入前台')
    } catch {
      setLoginMessage('登入失敗，請確認本機代理是否啟動')
    }
  }
  return <main className="login-shell">
    <section className="login-card" aria-label="前台登入驗證">
      <h1>瑞文AI預測百家</h1>
      <strong>免費AI請私訊官方賴@Dv1788</strong>
      <div className="login-chip">前台登入驗證</div>
      <label>會員帳號<input placeholder="請輸入會員帳號" value={memberAccount} onChange={(event) => setMemberAccount(event.target.value)} /></label>
      <label>驗證密碼<input placeholder="請輸入驗證密碼" type="password" value={verificationPassword} onChange={(event) => setVerificationPassword(event.target.value)} /></label>
      <button onClick={submitLogin}>會員登入</button>
      <p>前台登入形式：會員帳號 / 驗證密碼</p>
      {loginMessage ? <em>{loginMessage}</em> : <em>驗證密碼 = 後台建立的會員授權密碼</em>}
    </section>
  </main>
}

function AdminLoginApp() {
  const [agentAccount, setAgentAccount] = useState('')
  const [loginMessage, setLoginMessage] = useState('')
  const submitLogin = async () => {
    setLoginMessage('後台登入驗證中')
    try {
      const result = await agentLogin({ agentAccount })
      if (!result.ok && !result.skipped) {
        setLoginMessage('登入失敗，請確認管理員或代理帳號')
        return
      }
      window.sessionStorage.setItem('darven-admin-account', agentAccount.trim())
      setLoginMessage('登入成功，正在進入後台')
      window.location.assign('/admin')
    } catch {
      setLoginMessage('登入失敗，請確認後端 API 是否上線')
    }
  }
  return <main className="login-shell">
    <section className="login-card" aria-label="管理後台登入">
      <h1 className="admin-login-title">AI百家管理後台登入</h1>
      <strong>Darven AI 後台管理</strong>
      <div className="login-chip">管理員 / 代理登入</div>
      <label>管理員或代理帳號<input placeholder="請輸入管理員或代理帳號" value={agentAccount} onChange={(event) => setAgentAccount(event.target.value)} /></label>
      <button onClick={submitLogin}>管理員登入</button>
      {loginMessage ? <em>{loginMessage}</em> : null}
    </section>
  </main>
}

type AgentRow = { account: string; level: string; permission: string; parent?: string; depth?: number }
type CodeRow = { member: string; code: string; status: string; remain: string; expiresOn?: string; suspendedAt?: string }

const initialAgents: AgentRow[] = [
  { account: 'DVAI', level: '超級管理員', permission: '最高權限 / 可開管理員', depth: 0 },
  { account: 'Admin001', level: '管理員', permission: '可開代理 / 可建碼', parent: 'DVAI', depth: 1 },
  { account: 'Agent001', level: '代理', permission: '可開觀察者 / 可建碼', parent: 'Admin001', depth: 2 },
  { account: 'Agent002', level: '代理', permission: '可建碼', parent: 'Admin001', depth: 2 },
  { account: 'View001', level: '觀察者', permission: '僅可登入確認', parent: 'Agent001', depth: 3 },
  { account: 'DV1688', level: '管理員', permission: '可開代理 / 可建碼', parent: 'DVAI', depth: 1 },
  { account: 'A1024', level: '代理', permission: '可建碼', parent: 'DV1688', depth: 2 },
  { account: 'B7788', level: '觀察者', permission: '僅可登入確認', parent: 'A1024', depth: 3 },
  { account: 'M8888', level: '管理員', permission: '可開代理 / 可建碼', parent: 'DVAI', depth: 1 },
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
  const loginAgent = window.sessionStorage.getItem('darven-admin-account')?.trim() || 'DVAI'
  const [memberAccount, setMemberAccount] = useState('')
  const [planDays, setPlanDays] = useState('30')
  const [latestMember, setLatestMember] = useState('User001')
  const [latestCode, setLatestCode] = useState('DVAI1788_001')
  const [codes, setCodes] = useState<CodeRow[]>(() => pruneExpiredCodes(initialCodes))
  const [selectedCodeMembers, setSelectedCodeMembers] = useState<string[]>([])
  const [selectedAgents, setSelectedAgents] = useState<string[]>([])
  const [agentSearch, setAgentSearch] = useState('')
  const [collapsedAgents, setCollapsedAgents] = useState<string[]>([])
  const [codeSearch, setCodeSearch] = useState('')
  const [memoryCenter, setMemoryCenter] = useState<OnlineMemoryCenter>({ state: 'connecting', items: [], reports: [], strategies: [] })
  const [strategyAnalysis, setStrategyAnalysis] = useState<OnlineStrategyAnalysis>({ state: 'connecting', strategyRows: [], weakTables: [], strongTables: [], watchTables: [], suggestions: [] })
  const [licenseStatus, setLicenseStatus] = useState<OnlineLicenseStatus>({ managers: [], agents: [], plans: [], licenses: [], agentRows: [], licenseRows: [] })
  const [cloudDataStatus, setCloudDataStatus] = useState<{ mtAutoLoginEnabled?: boolean; message?: string; tableCount?: number; todayRoundCount?: number }>({ mtAutoLoginEnabled: false, message: 'MT自動登入未啟用', todayRoundCount: 0 })
  useEffect(() => { getOnlineMemoryCenter().then(setMemoryCenter); getOnlineStrategyAnalysis().then(setStrategyAnalysis); getCloudDataStatus().then(setCloudDataStatus) }, [])
  useEffect(() => { getOnlineLicenseStatus().then((status) => {
    setLicenseStatus(status)
    if (status.licenseRows.length) {
      const rows = pruneExpiredCodes(status.licenseRows as CodeRow[])
      setCodes(rows)
      if (rows.length) {
        setLatestCode(rows[0].code)
        setLatestMember(rows[0].member)
      }
    } else if (status.configured === false || (!status.agentRows.length && !status.licenseRows.length)) {
      setCodes(pruneExpiredCodes(initialCodes))
    } else {
      setCodes([])
    }
  }) }, [])
  const startDate = '2026/06/25'
  const displayManager = loginAgent
  const displayMember = memberAccount.trim() || 'User001'
  const serialNo = useMemo(() => findLowestAvailableSerial(codes, displayManager), [codes, displayManager])
  const clampedPlanDays = clampPlanDays(planDays)
  const expiryDate = useMemo(() => {
    const date = new Date('2026-06-25T00:00:00')
    date.setDate(date.getDate() + clampedPlanDays)
    return date.toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' })
  }, [clampedPlanDays])
  const createAuthorization = async () => {
    const nextCode = buildLicenseCode(displayManager, displayMember, serialNo)
    const result = await createOnlineLicense({ memberAccount: displayMember, code: nextCode, agentCode: displayManager, durationDays: clampedPlanDays, adminAccount: displayManager })
    setLatestMember(displayMember)
    setLatestCode(result.row?.code ?? nextCode)
    const nextRows = await getOnlineLicenseStatus()
    setLicenseStatus(nextRows)
    if (nextRows.licenseRows.length) setCodes(pruneExpiredCodes(nextRows.licenseRows as CodeRow[]))
    else setCodes((rows) => pruneExpiredCodes([{ member: displayMember, code: result.row?.code ?? nextCode, status: '啟用中', remain: `${clampedPlanDays}天` }, ...rows]))
  }
  const refreshLicenses = async () => {
    const nextRows = await getOnlineLicenseStatus()
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
    const rows = selectedCodeRows()
    setCodes((current) => current.filter((row) => !selectedCodeMembers.includes(row.member)))
    setSelectedCodeMembers([])
    await Promise.all(rows.map((row) => deleteOnlineLicense({ code: row.code, adminAccount: displayManager }).catch(() => null)))
  }
  const suspendSelectedCodes = async () => {
    const rows = selectedCodeRows()
    await Promise.all(rows.map((row) => setOnlineLicenseStatus({ code: row.code, status: 'suspended', adminAccount: displayManager }).catch(() => null)))
    setCodes((current) => current.map((row) => selectedCodeMembers.includes(row.member) ? { ...row, status: '暫停中' } : row))
    await refreshLicenses()
  }
  const extendSelectedCodes = async () => {
    const rows = selectedCodeRows()
    await Promise.all(rows.map((row) => extendOnlineLicense({ code: row.code, days: clampedPlanDays, adminAccount: displayManager }).catch(() => null)))
    await refreshLicenses()
  }
  const createAgentFromPrompt = async () => {
    const code = window.prompt('請輸入代理帳號')?.trim()
    if (!code) return
    const role = window.prompt('請輸入角色：manager / agent / viewer', 'agent')?.trim() || 'agent'
    const parentCode = window.prompt('請輸入上級帳號，空白則使用目前登入帳號', displayManager)?.trim() || displayManager
    await createOnlineAgent({ code, name: code, role, parentCode, adminAccount: displayManager, permission: role === 'manager' ? '可開代理 / 可建碼' : '可建碼' })
    await refreshLicenses()
  }
  const deleteSelectedAgents = async () => {
    if (!selectedAgents.length) return
    await deleteOnlineAgents({ codes: selectedAgents, adminAccount: displayManager })
    setSelectedAgents([])
    await refreshLicenses()
  }
  const enableMaintenanceMode = () => updateOnlineAppSetting({ scope: 'frontend', key: 'ui_defaults', value: { maintenanceMode: true }, isPublic: true })
  const enableCloudCapture = () => updateOnlineFeatureFlag({ flagKey: 'cloud_capture', enabled: true })
  const latestReport = memoryCenter.reports[0]
  const latestReportHitRate = latestReport?.main_hit_rate != null ? `${latestReport.main_hit_rate}%` : '-'
  const latestReportHitMiss = latestReport?.hits != null || latestReport?.misses != null ? `${latestReport?.hits ?? 0} / ${latestReport?.misses ?? 0}` : '-'
  const bestStrategy = strategyAnalysis.strategyRows[0]
  const primaryWeakTable = strategyAnalysis.weakTables[0]
  const primaryStrongTable = strategyAnalysis.strongTables[0]
  const agents = useMemo(() => normalizeAgents(licenseStatus.agentRows.length ? licenseStatus.agentRows : initialAgents, displayManager), [licenseStatus.agentRows, displayManager])
  const visibleAgents = useMemo(() => filterCollapsedAgents(agents, collapsedAgents), [agents, collapsedAgents])
  const filteredAgents = useMemo(() => filterAgents(visibleAgents, agentSearch), [visibleAgents, agentSearch])
  const filteredCodes = useMemo(() => filterCodes(codes, codeSearch), [codes, codeSearch])

  return <main className="admin-shell admin-v015-shell" style={{ width: '100%', maxWidth: 'none' }}>
    <header className="admin-hero clean-hero v015-hero" style={{ width: '100%', maxWidth: 'none' }}>
      <div className="admin-title-block">
        <h1>AI百家預測後台</h1>
        <span>授權序號 / 會員帳號 / 代理管理 / 驗證碼管理</span>
      </div>
      <button className="admin-logout" onClick={logoutAdmin}>登出</button>
    </header>

    <section className="admin-summary-grid auth-summary v015-summary v044-summary-grid" aria-label="管理總覽" style={{ width: '100%', maxWidth: 'none' }}>
      <AdminMetric title="AI策略版本" value="v1.0.8" tone="purple" />
      <AdminMetric title="今日局數" value={`${cloudDataStatus.todayRoundCount ?? totalRounds} 局`} tone="purple" />
      <AdminMetric title="SUPABASE" value={formatConnectionMetric(supabaseStatus, 'Supabase')} tone={supabaseStatus.state === 'error' ? 'yellow' : 'green'} />
      <AdminMetric title="記憶中心" value={formatConnectionMetric(onlineCoreStatus, '記憶中心')} tone={onlineCoreStatus.state === 'error' ? 'yellow' : 'cyan'} />
    </section>

    <section className="admin-panel v015-auth-panel" aria-label="建立會員驗證密碼" style={{ width: '100%', maxWidth: 'none' }}>
      <p className="panel-label">授權管理</p>
      <h2>建立會員驗證密碼</h2>
      <div className="v015-form-grid">
        <label>會員帳號<input placeholder="請輸入會員帳號" value={memberAccount} onChange={(event) => setMemberAccount(event.target.value)} /></label>
        <label>代理帳號<input placeholder="請輸入代理帳號" value={displayManager} readOnly /></label>
        <label>方案天數<input aria-label="方案天數" type="number" min="1" max="30" value={String(clampedPlanDays)} onChange={(event) => setPlanDays(String(clampPlanDays(event.target.value)))} /></label>
        <label>流水號<input aria-label="流水號" value={serialNo} readOnly /></label>
      </div>
      <button className="primary create-auth" onClick={createAuthorization}>建立授權</button>
      <div className="v015-result-grid">
        <div className="serial-box member-box">最新會員帳號：{latestMember}</div>
        <div className="serial-box code-box">最新驗證碼：{latestCode}</div>
      </div>
      <div className="v015-copy-row">
        <button>複製帳號</button><button>複製驗證碼</button><button>複製帳密</button>
      </div>
      <div className="auth-summary-mini v015-date-grid">
        <span><b>建立日期</b><strong>{startDate}</strong></span>
        <span><b>到期日期</b><strong>{expiryDate}</strong></span>
        <span><b>方案天數</b><strong>{clampedPlanDays} 天</strong></span>
        <span><b>流水號</b><strong>{serialNo}</strong></span>
      </div>
    </section>

    <section className="v015-management-grid v019-scaled-lists v044-feature-grid" aria-label="後台功能四格" style={{ width: '100%', maxWidth: 'none' }}>
      <section className="admin-panel list-panel feature-card" aria-label="線上設定管理">
        <h2>線上設定管理</h2>
        <div className="admin-action-row compact">
          <button onClick={enableMaintenanceMode}>啟用維護模式</button>
          <button onClick={enableCloudCapture}>啟用雲端抓取</button>
          <button title={cloudDataStatus.message}>MT自動登入未啟用｜{cloudDataStatus.tableCount ?? tables.length}桌｜今日{cloudDataStatus.todayRoundCount ?? 0}局</button>
        </div>
      </section>

      <section className="admin-panel list-panel feature-card" aria-label="線上記憶與報表">
        <h2>線上記憶與報表</h2>
        <div className="list-head"><span>策略版本</span><span>實測報告</span><span>主命中率</span><span>命中/未中</span></div>
        <div className="list-row agent-row"><span>{latestReport?.strategy_version ?? '尚無策略版本'}</span><b className="green-text">{latestReport ? `${latestReport.rounds ?? 0}局` : '尚無實測報告'}</b><strong>{latestReportHitRate}</strong><em>{latestReportHitMiss}</em></div>
      </section>

      <section className="admin-panel list-panel feature-card" aria-label="策略版本比較">
        <h2>策略版本比較</h2>
        <div className="list-head"><span>策略版本</span><span>局數</span><span>主命中率</span><span>結論</span></div>
        <div className="list-row agent-row"><span>{bestStrategy?.strategy_version ?? '尚無策略版本'}</span><b className="green-text">{bestStrategy ? `${bestStrategy.rounds ?? 0}局` : '-'}</b><strong>{bestStrategy?.main_hit_rate != null ? `${bestStrategy.main_hit_rate}%` : '-'}</strong><em>{bestStrategy?.conclusion ?? '-'}</em></div>
      </section>
      <section className="admin-panel list-panel feature-card" aria-label="弱桌分析">
        <h2>弱桌分析</h2>
        <div className="list-head"><span>弱桌</span><span>命中率</span><span>強桌參考</span></div>
        <div className="list-row agent-row"><span>{primaryWeakTable?.name ?? '尚無弱桌'}</span><b className="yellow-text">{primaryWeakTable ? `${primaryWeakTable.hitRate}%` : '-'}</b><em>{primaryStrongTable ? `${primaryStrongTable.name} ${primaryStrongTable.hitRate}%` : '尚無強桌'}</em></div>
        <div className="list-row agent-row"><span>{strategyAnalysis.suggestions[0] ?? '尚無策略建議'}</span><b></b><em></em></div>
      </section>
    </section>

    <section className="v015-management-grid v019-scaled-lists" style={{ width: '100%', maxWidth: 'none' }}>
      <section className="admin-panel list-panel" aria-label="下級代理">
        <h2>下級代理</h2>
        <input className="search-input" placeholder="尋找代理帳號" value={agentSearch} onChange={(event) => setAgentSearch(event.target.value)} />
        <div className="admin-action-row compact"><button onClick={createAgentFromPrompt}>增加代理</button><button onClick={deleteSelectedAgents}>刪除代理</button><button>調整等級</button></div>
        <div className="scroll-list agent-list hierarchy-list">
          <div className="list-head agent-hierarchy-head"><span></span><span>帳號</span><span>代理等級</span><span>權限</span></div>
          {filteredAgents.map((agent) => {
            const collapsible = hasAgentChildren(agents, agent.account)
            const collapsed = collapsedAgents.includes(agent.account)
            return <div className={`list-row agent-row hierarchy-row depth-${agent.depth ?? 0}`} key={agent.account}>
              <span className="agent-select-cell">
                {collapsible ? <button className="collapse-agent" aria-label={`${collapsed ? '展開' : '收合'} ${agent.account}`} onClick={() => toggleCollapse(agent.account)}>{collapsed ? '▶' : '▼'}</button> : <i />}
                <input aria-label={`勾選 ${agent.account}`} type="checkbox" checked={selectedAgents.includes(agent.account)} onChange={() => toggleAgent(agent.account)} />
              </span>
              <span>{agent.account}</span><b className={agent.level.includes('管理員') ? 'green-text' : agent.level.includes('代理') ? 'yellow-text' : ''}>{agent.level}</b><em>{agent.permission}</em>
            </div>
          })}
        </div>
      </section>

      <section className="admin-panel list-panel" aria-label="已建立驗證碼">
        <h2>已建立驗證碼</h2>
        <input className="search-input" placeholder="尋找驗證碼" value={codeSearch} onChange={(event) => setCodeSearch(event.target.value)} />
        <div className="admin-action-row compact code-action-row">
          <button className="danger" onClick={deleteSelectedCodes}>刪除驗證碼</button>
          <button className="warning" onClick={suspendSelectedCodes}>暫停驗證碼</button>
          <button className="extend" onClick={extendSelectedCodes}>延長驗證碼</button>
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
  return normalized
    .filter((row) => !row.level.includes('超級') && row.account !== loginAgent)
    .map((row) => ({ ...row, depth: Math.max(0, (row.depth ?? inferAgentDepth(row.level)) - 1) }))
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
  if (!text) return codes
  return codes.filter((row) => `${row.member} ${row.code} ${row.status} ${row.remain}`.toLowerCase().includes(text))
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

function formatConnectionMetric(status: { state: string; message: string }, label: string) {
  if (status.state === 'connected') return '已連線'
  if (status.state === 'error') return status.message.replace(`${label} `, '').replace('Supabase ', '')
  if (status.state === 'connecting') return '檢查中'
  return status.message || '未設定'
}

function AdminMetric({ title, value, tone }: { title: string; value: string; tone: 'green' | 'cyan' | 'purple' | 'yellow' }) { return <article className={`admin-metric ${tone}`}><span>{title}</span><strong>{value}</strong></article> }
function Stat({ title, value, tone, accent = false }: { title: string; value: string; tone?: 'Banker' | 'Player' | 'Tie'; accent?: boolean }) { return <article className={`stat-card result-stat centered-stat ${tone ?? ''} ${accent ? 'accent' : ''}`}><span>{title}</span><strong>{value}</strong></article> }
function PredictionMetric({ title, value, tone }: { title: string; value: number; tone: 'Banker' | 'Player' | 'Tie' }) { return <article className={`prediction-metric ${tone}`} aria-label={`${title}預測`}><span>{title}</span><strong className="probability-value">{value}%</strong></article> }
function RoadCard({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) { return <section className="road-card"><div className="card-heading"><h2>{title}</h2><span>{subtitle}</span></div>{children}</section> }
