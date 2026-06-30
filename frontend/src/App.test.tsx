import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react'
import App from './App'
import { mockTables } from './data/mockTables'
import { applyAskRoadWeighting, calculateAskRoadInfluence, calculateBonusPredictions, calculatePrediction, createSidePredictionLearningRecord, detectRoadTrends, evaluateFiveRoadPrediction, isSidePredictionActionable, scoreMainPrediction, normalizeOutcomeFromBead, parseBigRoad } from './lib/roadParser'

async function renderApp(path = '/', waitForConnected = true) {
  window.history.pushState({}, '', path)
  const result = render(<App />)
  if (waitForConnected) {
    await waitFor(() => expect(screen.getByText(/已連線/)).toBeInTheDocument())
  }
  return result
}

describe('AI百家預測軟體', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/api/online-license/status')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ configured: true }) })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items: [], reports: [], strategies: [] }) })
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders the requested v010 title and centered brand order', async () => {
    await renderApp()
    expect(screen.getByRole('heading', { name: 'AI百家預測軟體' })).toBeInTheDocument()
    expect(screen.getByText('DarevnAI Version 010')).toBeInTheDocument()
  })

  it('shows only Supabase connection status in the header and removes live status/update time', async () => {
    await renderApp()
    const header = screen.getByRole('banner')
    expect(within(header).getByText('授權後端已連線')).toBeInTheDocument()
    expect(within(header).queryByText('未連線')).not.toBeInTheDocument()
    expect(within(header).queryByText(/更新：/)).not.toBeInTheDocument()
  })

  it('v032 shows actual Supabase 401 failure instead of leaving frontend/header ambiguous', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 401 })))
    await renderApp('/', false)
    expect(await screen.findByText('Supabase 連線失敗 (401)')).toBeInTheDocument()
  })

  it('shows the requested promo text in the top-left corner', async () => {
    await renderApp()
    const promo = screen.getByLabelText('官方資訊')
    expect(within(promo).getByText('免費AI百家預測軟體')).toBeInTheDocument()
    expect(within(promo).getByText('私訊官方賴@Dv1788')).toBeInTheDocument()
  })

  it('keeps only banker tie player in the top stats row and centers/enlarges the labels', async () => {
    await renderApp()
    const stats = screen.getByLabelText('統計資訊')
    const statCards = stats.querySelectorAll('.stat-card.result-stat')
    expect(statCards).toHaveLength(3)
    expect(within(stats).getByText('莊')).toBeInTheDocument()
    expect(within(stats).getByText('和')).toBeInTheDocument()
    expect(within(stats).getByText('閒')).toBeInTheDocument()
    expect(within(stats).queryByText('AI信心值')).not.toBeInTheDocument()
    expect(within(stats).queryByText('局數')).not.toBeInTheDocument()
    statCards.forEach((card) => expect(card).toHaveClass('centered-stat'))
    expect(within(stats).getByText('莊').closest('.stat-card')).toHaveClass('Banker')
    expect(within(stats).getByText('和').closest('.stat-card')).toHaveClass('Tie')
    expect(within(stats).getByText('閒').closest('.stat-card')).toHaveClass('Player')
  })

  it('centers the red-box prediction UI with side, main, and AI rows and puts percentages below labels', async () => {
    await renderApp()
    const prediction = screen.getByLabelText('AI預測結果')
    const sideRow = within(prediction).getByLabelText('副項目預測機率')
    const mainRow = within(prediction).getByLabelText('莊閒預測機率')

    ;['閒龍寶', '閒對', '和局', '超六', '莊對', '莊龍寶'].forEach((label) => {
      const item = within(sideRow).getByLabelText(`${label}預測`)
      expect(within(item).getByText(label)).toBeInTheDocument()
      expect(within(item).getByText(/\d+%/)).toHaveClass('probability-value')
    })

    ;['閒', '和', '莊'].forEach((label) => {
      const item = within(mainRow).getByLabelText(`${label}預測`)
      expect(within(item).getByText(label)).toBeInTheDocument()
      expect(within(item).getByText(/\d+%/)).toHaveClass('probability-value')
    })

    expect(within(prediction).getByText(/AI預測:/)).toBeInTheDocument()
    expect(within(prediction).getByText(/AI信心值:\d+%/)).toBeInTheDocument()
    expect(within(sideRow).getByText('和局')).toBeInTheDocument()
    expect(within(mainRow).getByText('和')).toBeInTheDocument()
    expect(within(prediction).queryByText(/高|中|低/)).not.toBeInTheDocument()
    expect(within(prediction).queryByText(/風險:/)).not.toBeInTheDocument()
    expect(within(prediction).queryByText(/最近 \d+ 局/)).not.toBeInTheDocument()
    expect(within(prediction).queryByText('近期莊閒趨勢相近，建議持續觀察。')).not.toBeInTheDocument()
  })

  it('v044 removes manual token connection controls and reads backend tables automatically', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/api/tables')) return Promise.resolve({ ok: true, json: () => Promise.resolve(mockTables.map((table, index) => ({
        tableId: table.id,
        displayName: `MT百家樂第${index + 1}桌`,
        tableType: table.table_type,
        round: Number(table.trend.current_round ?? 0) + 10,
        bankerCount: table.trend.total_round_banker,
        playerCount: table.trend.total_round_player,
        tieCount: table.trend.total_round_tie,
        beadPlateRaw: table.trend.bead_plate2,
        bigRoadRaw: table.trend.big2,
      }))) })
      if (url.includes('/api/online-license/status')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ configured: true }) })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
    }))
    await renderApp('/', false)
    expect(screen.queryByRole('heading', { name: '連線控制' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Token')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '開始抓取' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '改用示範資料' })).not.toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /MT百家樂第1桌 第44局/ })).toBeInTheDocument()
  })

  it('keeps Cloudflare verification and MT table labels without manual connection controls', async () => {
    await renderApp()
    const sidebar = screen.getByLabelText('桌號與資料選擇')
    expect(sidebar).toHaveClass('balanced-sidebar-line')
    expect(within(sidebar).queryByText('百家樂桌')).not.toBeInTheDocument()
    expect(within(sidebar).getByText('Cloudflare Turnstile')).toBeInTheDocument()
    expect(within(sidebar).queryByRole('heading', { name: '連線控制' })).not.toBeInTheDocument()
    expect(within(sidebar).queryByText(/BAG/)).not.toBeInTheDocument()

    const expectedLabels = ['1', '2', '3', '3A', '5', '6', '7', '8', '9']
    const tableButtons = within(sidebar).getAllByRole('button', { name: /MT百家樂第.+桌 第\d+局/ })
    expect(tableButtons).toHaveLength(expectedLabels.length)
    expectedLabels.forEach((tableLabel, index) => {
      expect(tableButtons[index]).toHaveTextContent(`MT百家樂第${tableLabel}桌`)
    })
  })

  it('renders the original traditional big-road shape from big2 without tie cells', async () => {
    await renderApp()
    expect(screen.queryByText('珠盤路')).not.toBeInTheDocument()
    expect(document.querySelector('.bead-grid')).not.toBeInTheDocument()
    expect(screen.getByLabelText('傳統大路')).toBeInTheDocument()
    expect(screen.getByText(/紅圈＝莊\s+藍圈＝閒/)).toBeInTheDocument()
    expect(document.querySelector('.big-cell.Tie')).not.toBeInTheDocument()
    expect(document.querySelectorAll('.big-cell.Banker')).toHaveLength(11)
    expect(document.querySelectorAll('.big-cell.Player')).toHaveLength(5)
  })

  it('keeps the selected table after proxy polling refreshes table data', async () => {
    vi.mocked(fetch).mockImplementation(() => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(mockTables.map((table, index) => ({
        tableId: table.id,
        displayName: `MT百家樂第${index + 1}桌`,
        tableType: table.table_type,
        round: Number(table.trend.current_round ?? 0) + 100,
        bankerCount: table.trend.total_round_banker,
        playerCount: table.trend.total_round_player,
        tieCount: table.trend.total_round_tie,
        beadPlateRaw: table.trend.bead_plate2,
        bigRoadRaw: table.trend.big2,
      }))),
    } as Response))

    await renderApp()
    const tableButtons = screen.getAllByRole('button', { name: /MT百家樂第.+桌 第\d+局/ })
    fireEvent.click(tableButtons[1])
    expect(tableButtons[1]).toHaveClass('active')

    await waitFor(() => expect(screen.getByRole('button', { name: /MT百家樂第1桌 第134局/ })).toBeInTheDocument())
    const refreshedButtons = screen.getAllByRole('button', { name: /MT百家樂第.+桌 第\d+局/ })
    expect(refreshedButtons[1]).toHaveClass('active')
    expect(refreshedButtons[0]).not.toHaveClass('active')
  })

  it('keeps selected table slot even when refreshed proxy table ids change', async () => {
    let refreshNo = 0
    vi.mocked(fetch).mockImplementation(() => Promise.resolve({
      ok: true,
      status: 200,
      json: () => {
        refreshNo += 1
        return Promise.resolve(mockTables.map((table, index) => ({
          tableId: `LIVE-${refreshNo}-${index + 1}`,
          displayName: `MT百家樂第${index + 1}桌`,
          tableType: table.table_type,
          round: Number(table.trend.current_round ?? 0) + 200,
          bankerCount: table.trend.total_round_banker,
          playerCount: table.trend.total_round_player,
          tieCount: table.trend.total_round_tie,
          beadPlateRaw: table.trend.bead_plate2,
          bigRoadRaw: table.trend.big2,
        })))
      },
    } as Response))

    await renderApp()
    const tableButtons = screen.getAllByRole('button', { name: /MT百家樂第.+桌 第\d+局/ })
    fireEvent.click(tableButtons[1])
    expect(tableButtons[1]).toHaveClass('active')

    await waitFor(() => expect(screen.getByRole('button', { name: /MT百家樂第1桌 第234局/ })).toBeInTheDocument())
    const refreshedButtons = screen.getAllByRole('button', { name: /MT百家樂第.+桌 第\d+局/ })
    expect(refreshedButtons[1]).toHaveClass('active')
    expect(refreshedButtons[0]).not.toHaveClass('active')
  })

  it('ignores pair metadata when parsing bead outcomes', () => {
    expect(normalizeOutcomeFromBead('12')).toBe('Banker')
    expect(normalizeOutcomeFromBead('21')).toBe('Player')
    expect(normalizeOutcomeFromBead('33')).toBe('Tie')
  })

  it('calculates bonus prediction percentages for dragon bonus, pairs, super six, and tie', () => {
    expect(calculateBonusPredictions([
      { code: '12', outcome: 'Banker' },
      { code: '21', outcome: 'Player' },
      { code: '33', outcome: 'Tie' },
      { code: '02', outcome: 'Banker' },
    ], {
      total_round_banker: 2,
      total_round_player: 1,
      total_round_tie: 1,
      total_round_banker_pair: 2,
      total_round_player_pair: 2,
    })).toEqual({
      bankerDragon: 18,
      playerDragon: 9,
      bankerPair: 50,
      playerPair: 50,
      superSix: 6,
      tie: 25,
    })
  })

  it('allows ties in big-road parser when tie codes are present', () => {
    expect(parseBigRoad('0101,0303,#0202').map((cell) => cell.outcome)).toEqual(['Player', 'Tie', 'Banker'])
  })

  it('turns banker/player ask-road data into a directional weighting feature', () => {
    expect(calculateAskRoadInfluence({
      next_banker2: '111',
      next_player2: '222',
    })).toEqual({ bankerScore: 3, playerScore: 0, weight: 6 })

    expect(applyAskRoadWeighting({ banker: 48, player: 42, tie: 10 }, {
      next_banker2: '222',
      next_player2: '111',
    })).toEqual({ banker: 42, player: 48, tie: 10 })
  })

  it('v016 predicts only Banker or Player with confidence clamped to 30-80 and no observe recommendation', () => {
    expect(calculatePrediction([])).toMatchObject({ recommendation: 'Banker', confidence: 30 })
    expect(calculatePrediction([
      { code: '01', outcome: 'Player' },
      { code: '03', outcome: 'Tie' },
    ])).toMatchObject({ recommendation: 'Player' })
    expect(calculatePrediction([
      { code: '01', outcome: 'Player' },
      { code: '03', outcome: 'Tie' },
    ]).confidence).toBeGreaterThanOrEqual(30)
    expect(calculatePrediction(Array.from({ length: 20 }, () => ({ code: '02', outcome: 'Banker' })))).toMatchObject({ recommendation: 'Banker', confidence: 80 })
  })

  it('v016 excludes ties from main prediction hit-rate scoring', () => {
    expect(scoreMainPrediction('Banker', 'Banker')).toEqual({ evaluated: true, hit: true, push: false })
    expect(scoreMainPrediction('Banker', 'Player')).toEqual({ evaluated: true, hit: false, push: false })
    expect(scoreMainPrediction('Banker', 'Tie')).toEqual({ evaluated: false, hit: false, push: true })
  })

  it('v016 records every side prediction for learning but only counts action when each threshold is reached', () => {
    expect(createSidePredictionLearningRecord({
      tie: 13,
      superSix: 7,
      bankerPair: 8,
      playerPair: 9,
      bankerDragon: 10,
      playerDragon: 9,
    }, {
      tie: true,
      superSix: false,
      bankerPair: false,
      playerPair: true,
      bankerDragon: true,
      playerDragon: false,
    })).toEqual(expect.objectContaining({
      learnedEvents: 6,
      actions: expect.objectContaining({
        tie: false,
        superSix: false,
        bankerPair: false,
        playerPair: true,
        bankerDragon: true,
        playerDragon: false,
      }),
      hits: expect.objectContaining({
        playerPair: true,
        bankerDragon: true,
      }),
    }))

    expect(isSidePredictionActionable('tie', 14)).toBe(true)
    expect(isSidePredictionActionable('superSix', 8)).toBe(true)
    expect(isSidePredictionActionable('bankerPair', 9)).toBe(true)
    expect(isSidePredictionActionable('playerPair', 9)).toBe(true)
    expect(isSidePredictionActionable('bankerDragon', 10)).toBe(true)
    expect(isSidePredictionActionable('playerDragon', 10)).toBe(true)
  })

  it('v017 detects road trends including single jump, double jump, long dragon, double dragon, and slopes', () => {
    expect(detectRoadTrends(['Banker', 'Player', 'Banker', 'Player', 'Banker']).singleJump).toBe(true)
    expect(detectRoadTrends(['Banker', 'Banker', 'Player', 'Player', 'Banker', 'Banker']).doubleJump).toBe(true)
    expect(detectRoadTrends(['Player', 'Banker', 'Banker', 'Banker', 'Banker']).longDragon).toEqual({ side: 'Banker', length: 4 })
    expect(detectRoadTrends(['Banker', 'Banker', 'Banker', 'Player', 'Player', 'Player']).doubleDragon).toBe(true)
    expect(detectRoadTrends(['Banker', 'Player', 'Banker', 'Banker', 'Player', 'Player', 'Banker', 'Banker', 'Banker']).upSlope).toBe(true)
    expect(detectRoadTrends(['Banker', 'Banker', 'Banker', 'Player', 'Player', 'Banker', 'Player']).downSlope).toBe(true)
  })

  it('v017 main prediction combines five roads, ask-road, table stats, global stats, and trend weights', () => {
    const prediction = evaluateFiveRoadPrediction({
      beadCells: [
        { code: '02', outcome: 'Banker' },
        { code: '01', outcome: 'Player' },
        { code: '02', outcome: 'Banker' },
        { code: '02', outcome: 'Banker' },
      ],
      bigRoadCells: parseBigRoad('0102,0202,0302,#0101,#0102,0202'),
      askRoad: { next_banker2: '111', next_player2: '222' },
      tableStats: { banker: 31, player: 22, tie: 4 },
      globalStats: { banker: 188, player: 164, tie: 30 },
    })
    expect(prediction.recommendation).toBe('Banker')
    expect(prediction.confidence).toBeGreaterThanOrEqual(30)
    expect(prediction.confidence).toBeLessThanOrEqual(80)
    expect(prediction.weights.beadRoad).toBeCloseTo(0.18)
    expect(prediction.weights.bigRoad).toBeCloseTo(0.24)
    expect(prediction.weights.bigEyeRoad).toBeCloseTo(0.14)
    expect(prediction.weights.smallRoad).toBeCloseTo(0.10)
    expect(prediction.weights.cockroachRoad).toBeCloseTo(0.10)
    expect(prediction.patterns.longDragon.side).toBe('Banker')
    expect(prediction.sourceScores.bigRoad.banker).toBeGreaterThan(prediction.sourceScores.bigRoad.player)
  })

  it('v017 report-facing prediction still hides internal source-weight hit rates from UI text', async () => {
    await renderApp()
    const prediction = screen.getByLabelText('AI預測結果')
    expect(within(prediction).getByText(/AI預測:/)).toBeInTheDocument()
    expect(within(prediction).getByText(/AI信心值:\d+%/)).toBeInTheDocument()
    expect(within(prediction).queryByText(/珠盤路|大眼仔|小路|蟑螂|單跳|雙跳|權重/)).not.toBeInTheDocument()
  })

  it('carries ask-road proxy payloads into frontend table trends', async () => {
    vi.mocked(fetch).mockImplementation(() => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(mockTables.map((table, index) => ({
        tableId: table.id,
        displayName: `MT百家樂第${index + 1}桌`,
        tableType: table.table_type,
        round: table.trend.current_round,
        bankerCount: table.trend.total_round_banker,
        playerCount: table.trend.total_round_player,
        tieCount: table.trend.total_round_tie,
        beadPlateRaw: table.trend.bead_plate2,
        bigRoadRaw: table.trend.big2,
        nextBankerRaw: '111',
        nextPlayerRaw: '222',
      }))),
    } as Response))

    await renderApp()

    await waitFor(() => expect(screen.getByLabelText('莊預測')).toHaveTextContent('54%'))
    expect(screen.getByLabelText('閒預測')).toHaveTextContent('36%')
  })

  it('v030 member login calls online license API and enters frontend only after success', async () => {
    const fetchMock = vi.fn((url: string, options?: RequestInit) => {
      if (url.includes('/api/online-license/member-login')) {
        expect(options?.body).toBe(JSON.stringify({ memberAccount: 'User001', verificationPassword: 'DVAI1788_001' }))
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, license: { code: 'DVAI1788_001' } }) })
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ connected: true }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    await renderApp('/login', false)

    expect(screen.getByRole('heading', { name: '瑞文AI預測百家' })).toBeInTheDocument()
    expect(screen.getByPlaceholderText('請輸入會員帳號')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('請輸入驗證密碼')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('請輸入驗證碼')).not.toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('請輸入會員帳號'), { target: { value: 'User001' } })
    fireEvent.change(screen.getByPlaceholderText('請輸入驗證密碼'), { target: { value: 'DVAI1788_001' } })
    fireEvent.click(screen.getByRole('button', { name: '會員登入' }))

    expect(await screen.findByText('登入成功，正在進入前台')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8787/api/online-license/member-login', expect.objectContaining({ method: 'POST' }))
  })

  it('v043 admin login calls online license API and enters backend dashboard after success', async () => {
    const fetchMock = vi.fn((url: string, options?: RequestInit) => {
      if (url.includes('/api/online-license/agent-login')) {
        expect(options?.body).toBe(JSON.stringify({ agentAccount: 'DVAI' }))
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, agent: { code: 'DVAI' } }) })
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ connected: true }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    await renderApp('/admin-login', false)

    expect(screen.getByRole('heading', { name: 'AI百家管理後台登入' })).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('請輸入管理員或代理帳號'), { target: { value: 'DVAI' } })
    fireEvent.click(screen.getByRole('button', { name: '管理員登入' }))

    expect(await screen.findByText('登入成功，正在進入後台')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8787/api/online-license/agent-login', expect.objectContaining({ method: 'POST' }))
  })

  it('v030 admin loads real Supabase license rows instead of static placeholder agents and codes', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/api/online-license/status')) return Promise.resolve({ ok: true, json: () => Promise.resolve({
        managers: [{ username: 'DV1788', role: 'total' }],
        agents: [{ code: 'DVAI', name: 'DV1788超級代理' }],
        plans: [{ name: '正式月卡', duration_days: 30 }],
        licenses: [{ code: 'DVAI1788_001', status: 'active', agent_code: 'DVAI', plan_name: '正式月卡', expires_on: '2026-07-29' }],
      }) })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ state: 'connected', message: '記憶中心已連線' }) })
    }))

    await renderApp('/admin', false)
    expect(await screen.findByText(/DV1788/)).toBeInTheDocument()
    expect(screen.getAllByText('DVAI1788_001').length).toBeGreaterThan(0)
    expect(screen.queryByText('Agent001')).not.toBeInTheDocument()
    expect(screen.queryByText('Agent001_001')).not.toBeInTheDocument()
  })

  it('v032 admin shows Supabase error message instead of staying at 檢查中', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/auth/v1/settings')) return Promise.resolve({ ok: false, status: 401 })
      if (url.includes('/api/online-license/status')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ managers: [], agents: [], plans: [], licenses: [] }) })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items: [], reports: [], strategies: [] }) })
    }))

    await renderApp('/admin', false)
    expect(await screen.findByText('連線失敗 (401)')).toBeInTheDocument()
    expect(screen.queryByText('檢查中')).not.toBeInTheDocument()
  })

  it('v034 admin shows latest auto-synced 300-round test report metrics from memory center', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/api/online-core/memory-center')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ connected: true, items: [], strategies: [], reports: [{ strategy_version: 'v034-auto-memory', report_type: '300_round_live_test', rounds: 300, main_hit_rate: '51.80', hits: 144, misses: 134, pushes: 22, report_path: 'proxy/reports/draven-v034-300-round-report.png' }] }) })
      if (url.includes('/api/online-license/status')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ managers: [], agents: [], plans: [], licenses: [] }) })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ connected: true, project: { name: 'AI百家' }, featureFlags: {} }) })
    }))

    await renderApp('/admin', false)

    expect(await screen.findByText('v034-auto-memory')).toBeInTheDocument()
    expect(screen.getByText('300局')).toBeInTheDocument()
    expect(screen.getByText('51.80%')).toBeInTheDocument()
    expect(screen.getByText('144 / 134')).toBeInTheDocument()
  })

  it('v035 admin shows strategy comparison, weak-table analysis, and next-version suggestions', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/api/online-core/strategy-analysis')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ connected: true, strategyRows: [{ strategy_version: 'v034-auto-memory', rounds: 300, main_hit_rate: '54.50', hits: 150, misses: 125, conclusion: '目前最佳' }], weakTables: [{ name: 'MT百家樂第5桌', hitRate: 38.5 }], strongTables: [{ name: 'MT百家樂第2桌', hitRate: 64 }], suggestions: ['第5桌低於45%，建議降低信心權重並啟用反向檢查'] }) })
      if (url.includes('/api/online-core/memory-center')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ connected: true, items: [], strategies: [], reports: [{ strategy_version: 'v034-auto-memory', report_type: '300_round_live_test', rounds: 300, main_hit_rate: '54.50', hits: 150, misses: 125, pushes: 25 }] }) })
      if (url.includes('/api/online-license/status')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ managers: [], agents: [], plans: [], licenses: [] }) })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ connected: true, project: { name: 'AI百家' }, featureFlags: {} }) })
    }))

    await renderApp('/admin', false)

    expect(await screen.findByText('策略版本比較')).toBeInTheDocument()
    expect(screen.getAllByText('v034-auto-memory').length).toBeGreaterThan(0)
    expect(screen.getByText('目前最佳')).toBeInTheDocument()
    expect(screen.getByText('弱桌分析')).toBeInTheDocument()
    expect(screen.getByText('MT百家樂第5桌')).toBeInTheDocument()
    expect(screen.getByText('38.5%')).toBeInTheDocument()
    expect(screen.getByText('第5桌低於45%，建議降低信心權重並啟用反向檢查')).toBeInTheDocument()
  })

  it('admin wide-screen shell uses the full viewport instead of leaving a large right blank area', async () => {
    await renderApp('/admin')

    const shell = document.querySelector('.admin-v015-shell')
    expect(shell).toBeInTheDocument()
    expect(window.getComputedStyle(shell!).maxWidth).toBe('none')
    expect(window.getComputedStyle(shell!).width).toBe('100%')

    ;['.v015-hero', '.v015-summary', '.v015-auth-panel', '.v015-management-grid'].forEach((selector) => {
      const element = document.querySelector(selector)
      expect(element).toBeInTheDocument()
      const computed = window.getComputedStyle(element!)
      expect(computed.maxWidth).toBe('none')
      expect(computed.width).toBe('100%')
    })
  })

  it('admin moves verification-code actions to the top of the right panel as three equal controls', async () => {
    await renderApp('/admin')

    const codePanel = screen.getByLabelText('已建立驗證碼')
    expect(within(codePanel).getByRole('button', { name: '刪除驗證碼' })).toBeInTheDocument()
    expect(within(codePanel).getByRole('button', { name: '暫停驗證碼' })).toBeInTheDocument()
    expect(within(codePanel).getByRole('button', { name: '延長驗證碼' })).toBeInTheDocument()
    expect(within(codePanel).queryByRole('button', { name: '刪除 User001 驗證碼' })).not.toBeInTheDocument()
    expect(within(codePanel).getByLabelText('勾選 User001')).toHaveAttribute('type', 'checkbox')
  })

  it('admin narrow/scaled list rows use the dedicated readable list class so text does not squeeze together', async () => {
    await renderApp('/admin')
    const grid = document.querySelector('.v019-scaled-lists')
    expect(grid).toBeInTheDocument()
    expect(grid).toHaveClass('v015-management-grid')
  })

  it('v044 applies requested admin layout, search, checkbox, fixed-agent, and 30-day limit behavior', async () => {
    window.sessionStorage.setItem('darven-admin-account', 'DVAI')
    await renderApp('/admin')

    const adminLoginHeading = document.querySelector('.admin-login-title')
    expect(adminLoginHeading).not.toBeInTheDocument()

    const summary = screen.getByLabelText('管理總覽')
    expect(Array.from(summary.querySelectorAll('.admin-metric')).map((node) => node.textContent)).toEqual([
      expect.stringContaining('AI策略版本'),
      expect.stringContaining('今日局數'),
      expect.stringContaining('SUPABASE'),
      expect.stringContaining('記憶中心'),
    ])
    expect(summary).toHaveClass('v044-summary-grid')

    expect(screen.queryByLabelText('線上授權正式重建')).not.toBeInTheDocument()
    expect(screen.getByLabelText('後台功能四格')).toHaveClass('v044-feature-grid')

    const agentInput = screen.getByPlaceholderText('請輸入代理帳號')
    expect(agentInput).toHaveValue('DVAI')
    expect(agentInput).toHaveAttribute('readonly')

    const daysInput = screen.getByLabelText('方案天數')
    fireEvent.change(daysInput, { target: { value: '99' } })
    expect(daysInput).toHaveValue(30)

    expect(screen.getByText('超級管理員')).toBeInTheDocument()
    expect(screen.getAllByText('管理員').length).toBeGreaterThan(0)
    expect(screen.getAllByText('代理').length).toBeGreaterThan(0)
    expect(screen.getAllByText('觀察者').length).toBeGreaterThan(0)
    expect(screen.getByLabelText('勾選 Agent001')).toHaveAttribute('type', 'checkbox')
    expect(screen.getByLabelText('勾選 User001')).toHaveAttribute('type', 'checkbox')

    fireEvent.change(screen.getByPlaceholderText('尋找代理帳號'), { target: { value: 'View001' } })
    expect(screen.getByText('View001')).toBeInTheDocument()
    expect(screen.queryByText('Agent002')).not.toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('尋找驗證碼'), { target: { value: 'User010' } })
    expect(screen.getByText('User010')).toBeInTheDocument()
    expect(screen.queryByText('User001')).not.toBeInTheDocument()
  })

  it('admin creates login credentials and deletes checked verification rows from the top action controls', async () => {
    window.sessionStorage.setItem('darven-admin-account', 'Agent001')
    await renderApp('/admin')

    fireEvent.change(screen.getByPlaceholderText('請輸入會員帳號'), { target: { value: 'User888' } })
    fireEvent.click(screen.getByRole('button', { name: '建立授權' }))

    expect(await screen.findByText('最新會員帳號：User888')).toBeInTheDocument()
    expect(screen.getByText('最新驗證碼：Agent001_003')).toBeInTheDocument()

    expect(screen.getByText('User001')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('勾選 User001'))
    fireEvent.click(screen.getByLabelText('勾選 User002'))
    fireEvent.click(screen.getByRole('button', { name: '刪除驗證碼' }))
    expect(screen.queryByText('User001')).not.toBeInTheDocument()
    expect(screen.queryByText('User002')).not.toBeInTheDocument()
  })
})
