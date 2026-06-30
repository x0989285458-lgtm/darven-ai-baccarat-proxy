import { useEffect, useMemo, useRef, useState } from 'react'
import { mockTables } from './data/mockTables'
import { LiveRoadClient, type LiveTable } from './lib/liveClient'
import { applyAskRoadWeighting, calculatePrediction, calculateBonusPredictions, parseBeadPlate, parseBigRoad } from './lib/roadParser'
import { checkSupabaseConnection, isSupabaseConfigured, supabaseConfig } from './lib/supabaseClient'
import { checkOnlineCoreStatus, getOnlineMemoryCenter, getOnlineStrategyAnalysis, updateOnlineAppSetting, updateOnlineFeatureFlag, type OnlineCoreStatus, type OnlineMemoryCenter, type OnlineStrategyAnalysis } from './lib/onlineCoreClient'
import { createOnlineLicense, deleteOnlineLicense, extendOnlineLicense, getOnlineLicenseStatus, memberLogin, setOnlineLicenseStatus, type OnlineLicenseStatus } from './lib/onlineLicenseClient'

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
  const [tables, setTables] = useState<LiveTable[]>(mockTables)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [token, setToken] = useState(defaultToken)
  const [status, setStatus] = useState({ state: 'disconnected', message: '未連線' })
  const [supabaseStatus, setSupabaseStatus] = useState({ state: isSupabaseConfigured ? 'connecting' : 'error', message: isSupabaseConfigured ? 'Supabase 檢查中' : 'Supabase 未設定' })
  const [onlineCoreStatus, setOnlineCoreStatus] = useState<OnlineCoreStatus>({ state: 'connecting', message: '記憶中心檢查中' })
  const [updatedAt, setUpdatedAt] = useState(new Date())
  const client = useRef<LiveRoadClient | null>(null)
  const visibleTables = useMemo(() => tables.slice(0, 9), [tables])
  const selectedSafeIndex = Math.min(selectedIndex, Math.max(visibleTables.length - 1, 0))
  const selected = visibleTables[selectedSafeIndex] ?? tables[0]
  const fullRoad = useMemo(() => parseBeadPlate(selected?.trend.bead_plate2 ?? ''), [selected])
  const bigRoad = useMemo(() => parseBigRoad(selected?.trend.big2 ?? '').filter((cell) => cell.outcome !== 'Tie'), [selected])
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
      token,
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

  const demo = () => {
    client.current?.disconnect(false)
    setTables(mockTables)
    setSelectedIndex(0)
    setUpdatedAt(new Date())
    setStatus({ state: 'disconnected', message: '示範資料' })
  }

  if (!selected) return null

  if (window.location.pathname === '/login') {
    return <LoginApp />
  }

  if (window.location.pathname === '/admin') {
    return <AdminApp tables={visibleTables} supabaseStatus={supabaseStatus} onlineCoreStatus={onlineCoreStatus} />
  }

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
      <aside className="sidebar balanced-sidebar-line" aria-label="桌號與連線控制">
        <section className="turnstile"><span>Cloudflare Turnstile</span><code>sitekey: placeholder</code><small>正式登入驗證碼預留區塊</small></section>
        <section className="control-card"><h2>連線控制</h2><label>Token<input aria-label="Token" value={token} onChange={(event) => setToken(event.target.value)} /></label><div className="button-row"><button className="primary" onClick={start}>開始抓取</button><button onClick={() => client.current?.disconnect()}>停止</button></div><p className={`live-status ${status.state}`}>{status.message}</p><button className="demo" onClick={demo}>改用示範資料</button></section>
        <nav className="table-list" aria-label="桌號選擇">
          {visibleTables.map((table, index) => <button className={`table-item ${index === selectedSafeIndex ? 'active' : ''}`} key={`${String(table.id)}-${index}`} onClick={() => setSelectedIndex(index)}>
            MT百家樂第{tableNumber(table, index)}桌 第{table.trend.current_round ?? 0}局
          </button>)}
        </nav>
      </aside>
      <section className="content">
        <div className="stats-grid" aria-label="統計資訊">
          <Stat title="莊" value={String(selected.trend.total_round_banker ?? 0)} tone="Banker" />
          <Stat title="和" value={String(selected.trend.total_round_tie ?? 0)} tone="Tie" />
          <Stat title="閒" value={String(selected.trend.total_round_player ?? 0)} tone="Player" />
        </div>
        <section className="prediction-card" aria-label="AI預測結果">
          <div className="prediction-row side-prediction-row" aria-label="副項目預測機率">
            <PredictionMetric title="閒龍寶" value={bonusPredictions.playerDragon} tone="Player" />
            <PredictionMetric title="閒對" value={bonusPredictions.playerPair} tone="Player" />
            <PredictionMetric title="和局" value={bonusPredictions.tie} tone="Tie" />
            <PredictionMetric title="超六" value={bonusPredictions.superSix} tone="Tie" />
            <PredictionMetric title="莊對" value={bonusPredictions.bankerPair} tone="Banker" />
            <PredictionMetric title="莊龍寶" value={bonusPredictions.bankerDragon} tone="Banker" />
          </div>
          <div className="prediction-row main-probability-row" aria-label="莊閒預測機率">
            <PredictionMetric title="閒" value={outcomePredictions.player} tone="Player" />
            <PredictionMetric title="莊" value={outcomePredictions.banker} tone="Banker" />
          </div>
          <h2 className="ai-prediction-line">AI預測:<span className={prediction.recommendation}>{label[prediction.recommendation]}</span></h2>
          <strong className="ai-confidence-line">AI信心值:{prediction.confidence}%</strong>
        </section>
        <div className="roads-grid single-road">
          <RoadCard title="大路" subtitle="紅圈＝莊　藍圈＝閒">
            <div className="big-road classic-road" aria-label="傳統大路">
              {bigRoad.map((cell) => <div style={{ gridColumn: cell.column + 1, gridRow: cell.row + 1 }} title={cell.outcome} className={`big-cell ${cell.outcome}`} key={`${cell.code}-${cell.column}-${cell.row}`}>{label[cell.outcome]}</div>)}
            </div>
          </RoadCard>
        </div>
      </section>
    </div>
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

const initialAgents = [
  { account: 'Agent001', level: '高級代理', permission: '可開下級 / 可建碼' },
  { account: 'Agent002', level: '普通代理', permission: '不可開下級 / 可建碼' },
  { account: 'View001', level: '觀察代理', permission: '僅可登入確認' },
  { account: 'DV1688', level: '高級代理', permission: '可開下級 / 可建碼' },
  { account: 'A1024', level: '普通代理', permission: '不可開下級 / 可建碼' },
  { account: 'B7788', level: '觀察代理', permission: '僅可登入確認' },
  { account: 'M8888', level: '高級代理', permission: '可開下級 / 可建碼' },
  { account: 'Test009', level: '普通代理', permission: '不可開下級 / 可建碼' },
  { account: 'C2026', level: '觀察代理', permission: '僅可登入確認' },
  { account: 'Agent010', level: '高級代理', permission: '可開下級 / 可建碼' },
]

const initialCodes = [
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
  const [memberAccount, setMemberAccount] = useState('')
  const [managerAccount, setManagerAccount] = useState('')
  const [planDays, setPlanDays] = useState('30')
  const [runningNo, setRunningNo] = useState('001')
  const [latestMember, setLatestMember] = useState('User001')
  const [latestCode, setLatestCode] = useState('DVAI1788_001')
  const [codes, setCodes] = useState(initialCodes)
  const [selectedCodeMember, setSelectedCodeMember] = useState('User001')
  const [memoryCenter, setMemoryCenter] = useState<OnlineMemoryCenter>({ state: 'connecting', items: [], reports: [], strategies: [] })
  const [strategyAnalysis, setStrategyAnalysis] = useState<OnlineStrategyAnalysis>({ state: 'connecting', strategyRows: [], weakTables: [], strongTables: [], watchTables: [], suggestions: [] })
  const [licenseStatus, setLicenseStatus] = useState<OnlineLicenseStatus>({ managers: [], agents: [], plans: [], licenses: [], agentRows: [], licenseRows: [] })
  useEffect(() => { getOnlineMemoryCenter().then(setMemoryCenter); getOnlineStrategyAnalysis().then(setStrategyAnalysis) }, [])
  useEffect(() => { getOnlineLicenseStatus().then((status) => {
    setLicenseStatus(status)
    if (status.licenseRows.length) {
      setCodes(status.licenseRows)
      setLatestCode(status.licenseRows[0].code)
      setLatestMember(status.licenseRows[0].member)
      setSelectedCodeMember(status.licenseRows[0].member)
    } else {
      setCodes(initialCodes)
      setSelectedCodeMember('User001')
    }
  }) }, [])
  const startDate = '2026/06/25'
  const displayManager = managerAccount.trim() || 'DVAI'
  const displayMember = memberAccount.trim() || 'User001'
  const expiryDate = useMemo(() => {
    const parsedDays = Number(planDays) || 0
    const date = new Date('2026-06-25T00:00:00')
    date.setDate(date.getDate() + parsedDays)
    return date.toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' })
  }, [planDays])
  const createAuthorization = async () => {
    const nextCode = buildLicenseCode(displayManager, displayMember, runningNo || '001')
    const result = await createOnlineLicense({ code: nextCode, agentCode: displayManager, durationDays: Number(planDays) || 30 })
    setLatestMember(displayMember)
    setLatestCode(result.row?.code ?? nextCode)
    const nextRows = await getOnlineLicenseStatus()
    setLicenseStatus(nextRows)
    if (nextRows.licenseRows.length) setCodes(nextRows.licenseRows)
    else setCodes((rows) => [{ member: displayMember, code: result.row?.code ?? nextCode, status: '啟用中', remain: `${planDays || '30'}天` }, ...rows])
  }
  const refreshLicenses = async () => {
    const nextRows = await getOnlineLicenseStatus()
    setLicenseStatus(nextRows)
    if (nextRows.licenseRows.length) {
      setCodes(nextRows.licenseRows)
      setSelectedCodeMember(nextRows.licenseRows[0].member)
    }
    return nextRows
  }
  const findSelectedLicenseCode = () => codes.find((row) => row.member === selectedCodeMember)?.code
  const deleteCode = async (member: string) => {
    const code = codes.find((row) => row.member === member)?.code
    setCodes((rows) => rows.filter((row) => row.member !== member))
    setSelectedCodeMember((current) => current === member ? '' : current)
    if (code) await deleteOnlineLicense({ code })
  }
  const suspendSelectedCode = async () => {
    const code = findSelectedLicenseCode()
    if (!code) return
    await setOnlineLicenseStatus({ code, status: 'suspended' })
    setCodes((rows) => rows.map((row) => row.code === code ? { ...row, status: '暫停中' } : row))
    await refreshLicenses()
  }
  const extendSelectedCode = async () => {
    const code = findSelectedLicenseCode()
    if (!code) return
    await extendOnlineLicense({ code, days: Number(planDays) || 30 })
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

  return <main className="admin-shell admin-v015-shell" style={{ width: '100%', maxWidth: 'none' }}>
    <header className="admin-hero clean-hero v015-hero" style={{ width: '100%', maxWidth: 'none' }}>
      <div className="admin-title-block">
        <h1>AI百家預測後台</h1>
        <span>授權序號 / 會員帳號 / 代理管理 / 驗證碼管理</span>
      </div>
    </header>

    <section className="admin-summary-grid auth-summary v015-summary" aria-label="管理總覽" style={{ width: '100%', maxWidth: 'none' }}>
      <AdminMetric title="AI策略版本" value="v1.0.8" tone="purple" />
      <AdminMetric title="SUPABASE" value={formatConnectionMetric(supabaseStatus, 'Supabase')} tone={supabaseStatus.state === 'error' ? 'yellow' : 'green'} />
      <AdminMetric title="記憶中心" value={formatConnectionMetric(onlineCoreStatus, '記憶中心')} tone={onlineCoreStatus.state === 'error' ? 'yellow' : 'cyan'} />
      <AdminMetric title="今日局數" value={`${totalRounds} 局`} tone="purple" />
    </section>

    <section className="admin-panel v015-auth-panel" aria-label="建立會員驗證密碼" style={{ width: '100%', maxWidth: 'none' }}>
      <p className="panel-label">授權管理</p>
      <h2>建立會員驗證密碼</h2>
      <div className="v015-form-grid">
        <label>會員帳號<input placeholder="請輸入會員帳號" value={memberAccount} onChange={(event) => setMemberAccount(event.target.value)} /></label>
        <label>代理帳號<input placeholder="請輸入代理帳號" value={managerAccount} onChange={(event) => setManagerAccount(event.target.value)} /></label>
        <label>方案天數<input aria-label="方案天數" value={planDays} onChange={(event) => setPlanDays(event.target.value)} /></label>
        <label>流水號<input aria-label="流水號" value={runningNo} onChange={(event) => setRunningNo(event.target.value)} /></label>
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
        <span><b>方案天數</b><strong>{planDays || '0'} 天</strong></span>
        <span><b>流水號</b><strong>{runningNo || '001'}</strong></span>
      </div>
    </section>

    <section className="v015-management-grid v019-scaled-lists" style={{ width: '100%', maxWidth: 'none' }}>
      <section className="admin-panel list-panel" aria-label="線上設定管理">
        <h2>線上設定管理</h2>
        <div className="admin-action-row compact">
          <button onClick={enableMaintenanceMode}>啟用維護模式</button>
          <button onClick={enableCloudCapture}>啟用雲端抓取</button>
          <button>同步記憶中心</button>
        </div>
      </section>
    </section>

    <section className="v015-management-grid v019-scaled-lists" style={{ width: '100%', maxWidth: 'none' }}>
      <section className="admin-panel list-panel" aria-label="線上記憶與報表">
        <h2>線上記憶與報表</h2>
        <div className="list-head"><span>策略版本</span><span>實測報告</span><span>主命中率</span><span>命中/未中</span></div>
        <div className="list-row agent-row"><span>{latestReport?.strategy_version ?? '尚無策略版本'}</span><b className="green-text">{latestReport ? `${latestReport.rounds ?? 0}局` : '尚無實測報告'}</b><strong>{latestReportHitRate}</strong><em>{latestReportHitMiss}</em></div>
      </section>
    </section>

    <section className="v015-management-grid v019-scaled-lists" style={{ width: '100%', maxWidth: 'none' }}>
      <section className="admin-panel list-panel" aria-label="策略版本比較">
        <h2>策略版本比較</h2>
        <div className="list-head"><span>策略版本</span><span>局數</span><span>主命中率</span><span>結論</span></div>
        <div className="list-row agent-row"><span>{bestStrategy?.strategy_version ?? '尚無策略版本'}</span><b className="green-text">{bestStrategy ? `${bestStrategy.rounds ?? 0}局` : '-'}</b><strong>{bestStrategy?.main_hit_rate != null ? `${bestStrategy.main_hit_rate}%` : '-'}</strong><em>{bestStrategy?.conclusion ?? '-'}</em></div>
      </section>
      <section className="admin-panel list-panel" aria-label="弱桌分析">
        <h2>弱桌分析</h2>
        <div className="list-head"><span>弱桌</span><span>命中率</span><span>強桌參考</span></div>
        <div className="list-row agent-row"><span>{primaryWeakTable?.name ?? '尚無弱桌'}</span><b className="yellow-text">{primaryWeakTable ? `${primaryWeakTable.hitRate}%` : '-'}</b><em>{primaryStrongTable ? `${primaryStrongTable.name} ${primaryStrongTable.hitRate}%` : '尚無強桌'}</em></div>
        <div className="list-row agent-row"><span>{strategyAnalysis.suggestions[0] ?? '尚無策略建議'}</span><b></b><em></em></div>
      </section>
    </section>

    <section className="v015-management-grid v019-scaled-lists" style={{ width: '100%', maxWidth: 'none' }}>
      <section className="admin-panel list-panel" aria-label="線上授權正式重建">
        <h2>線上授權正式重建</h2>
        <div className="list-head"><span>正式管理員</span><span>代理階層</span><span>會員授權碼</span></div>
        <div className="list-row agent-row"><span>{licenseStatus.managers[0]?.username ?? '尚無管理員'}</span><b className="green-text">{licenseStatus.licenses[0]?.plan_name ?? licenseStatus.plans[0]?.name ?? '尚無方案'}</b><em>{licenseStatus.licenses[0]?.code ?? '尚無會員授權碼'}</em></div>
      </section>
    </section>

    <section className="v015-management-grid v019-scaled-lists" style={{ width: '100%', maxWidth: 'none' }}>
      <section className="admin-panel list-panel" aria-label="下級代理">
        <h2>下級代理</h2>
        <input className="search-input" placeholder="尋找代理帳號" />
        <div className="admin-action-row compact"><button>增加代理</button><button>刪除代理</button><button>調整等級</button></div>
        <div className="scroll-list agent-list">
          <div className="list-head"><span>帳號</span><span>代理等級</span><span>權限</span></div>
          {(licenseStatus.agentRows.length ? licenseStatus.agentRows : initialAgents).map((agent) => <div className="list-row agent-row" key={agent.account}><span>{agent.account}</span><b className={agent.level.includes('高級') || agent.level.includes('超級') ? 'green-text' : agent.level.includes('普通') ? 'yellow-text' : ''}>{agent.level}</b><em>{agent.permission}</em></div>)}
        </div>
      </section>

      <section className="admin-panel list-panel" aria-label="已建立驗證碼">
        <h2>已建立驗證碼</h2>
        <input className="search-input" placeholder="尋找驗證碼" />
        <div className="admin-action-row compact code-action-row">
          <button className="danger" onClick={() => selectedCodeMember && deleteCode(selectedCodeMember)}>刪除驗證碼</button>
          <button className="warning" onClick={suspendSelectedCode}>暫停驗證碼</button>
          <button className="extend" onClick={extendSelectedCode}>延長驗證碼</button>
        </div>
        <div className="scroll-list code-list">
          {codes.map((row) => <div className="list-row code-row" key={row.member}>
            <button className={selectedCodeMember === row.member ? 'select-code selected' : 'select-code'} aria-label={`選取 ${row.member}`} onClick={() => setSelectedCodeMember(row.member)}>{selectedCodeMember === row.member ? '已選' : '選取'}</button>
            <span>{row.member}</span><b>{row.code}</b><em>{row.status}｜{row.remain}</em>
            <input placeholder="延長1-30天" />
          </div>)}
        </div>
      </section>
    </section>
  </main>
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
