import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within, fireEvent } from '@testing-library/react'
import App, { selectMemberTable } from './App'
import { mockTables } from './data/mockTables'
import { applyAskRoadWeighting, calculateAskRoadInfluence, ALL_MT_EQUAL_MAIN_WEIGHTS, ALL_MT_EQUAL_SIDE_WEIGHTS, calculateBonusPredictions, calculateMainOutcomeProbabilities, calculatePrediction, createSidePredictionLearningRecord, detectRoadTrends, evaluateFiveRoadPrediction, getSidePredictionActions, isSidePredictionActionable, scoreMainPrediction, normalizeOutcomeFromBead, parseBigRoad, SIDE_PREDICTION_THRESHOLDS, SIDE_PREDICTION_ACTION_RATE_TARGETS, SIDE_PREDICTION_WEIGHT_PROFILES } from './lib/roadParser'

async function renderApp(path = '/', waitForConnected = true) {
  window.history.pushState({}, '', path)
  if (path === '/' || path === '') {
    window.sessionStorage.setItem('darven-member-session-token', 'test-member-session')
    window.sessionStorage.setItem('darven-member-session-expires-at', new Date(Date.now() + 600000).toISOString())
  }
  if (path === '/admin') {
    if (!window.sessionStorage.getItem('darven-admin-account')) window.sessionStorage.setItem('darven-admin-account', 'DV1788')
    if (!window.sessionStorage.getItem('darven-admin-session-token')) window.sessionStorage.setItem('darven-admin-session-token', 'test-admin-session')
    if (!window.sessionStorage.getItem('darven-admin-role')) {
      const account = window.sessionStorage.getItem('darven-admin-account')?.toLowerCase()
      window.sessionStorage.setItem('darven-admin-role', account === 'dv1788' ? 'super' : 'manager')
    }
  }
  const currentFetch = fetch
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/api/online-license/member-session')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, sessionExpiresAt: new Date(Date.now() + 600000).toISOString() }) })
    const response = await currentFetch(url, init)
    if (!url.includes('/api/tables') || !response.ok) return response
    return {
      ...response,
      json: async () => {
        const body = await response.json()
        return Array.isArray(body) ? body.map((table) => ({ ...table, sourceUpdatedAt: table.sourceUpdatedAt ?? new Date().toISOString() })) : body
      },
    }
  }))
  const result = render(<App />)
  if (waitForConnected && path !== '/admin') {
    await waitFor(() => expect(screen.getByText(/已連線/)).toBeInTheDocument())
  }
  return result
}

function proxyTablesFromMocks() {
  return mockTables.map((table, index) => ({
    tableId: table.id,
    displayName: `MT百家樂第${index + 1}桌`,
    tableType: table.table_type,
    shoe: table.trend.current_shoe,
    round: table.trend.current_round,
    bankerCount: table.trend.total_round_banker,
    playerCount: table.trend.total_round_player,
    tieCount: table.trend.total_round_tie,
    bankerPairCount: table.trend.total_round_banker_pair,
    playerPairCount: table.trend.total_round_player_pair,
    beadPlateRaw: table.trend.bead_plate2,
    bigRoadRaw: table.trend.big2,
    sourceUpdatedAt: new Date().toISOString(),
    buildVersion: '098',
    prediction: {
      source: 'backend',
      strategyVersion: 'v098_主信心實際命中校準版',
      buildVersion: '098',
      targetTableId: table.id,
      targetShoe: table.trend.current_shoe,
      targetRound: Number(table.trend.current_round ?? 0) + 1,
      predictedResult: index % 2 === 0 ? 'banker' : 'player',
      confidence: 34,
      probabilities: { banker: 12.5, player: 77.25, tie: 10.25 },
      scoreTotals: { banker: 38, player: 33 },
      sidePredictions: { tie: 11, superSix: 22, bankerPair: 33, playerPair: 44, bankerDragon: 55, playerDragon: 66 },
      sideActions: { tie: false, superSix: false, bankerPair: false, playerPair: false, bankerDragon: true, playerDragon: false },
    },
  }))
}

function tableUiHistory(tableId = 'BAG01', shoe: string | number = 12) {
  return {
    ok: true,
    buildVersion: '098',
    tableId,
    shoe,
    settledPredictions: [
      { round: 3, predictedResult: 'player', actualResult: 'tie', isHit: false },
      { round: 2, predictedResult: 'banker', actualResult: 'banker', isHit: true },
      { round: 1, predictedResult: 'player', actualResult: 'banker', isHit: false },
    ],
    realCardRounds: [
      { round: 1, result: 'banker', bankerPoint: 6, playerPoint: 4 },
      { round: 2, result: 'tie', bankerPoint: 6, playerPoint: 6 },
      { round: 3, result: 'player', bankerPoint: 5, playerPoint: 7 },
    ],
    realCardHistoryCompleteThroughRound: 3,
  }
}

describe('AI百家預測軟體', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/api/online-license/member-session')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, sessionExpiresAt: new Date(Date.now() + 600000).toISOString() }) })
      if (url.includes('/ui-history')) {
        const tableId = url.match(/\/api\/tables\/([^/]+)\/ui-history/)?.[1] ?? 'BAG01'
        const table = proxyTablesFromMocks().find((item) => item.tableId === tableId)
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(tableUiHistory(tableId, table?.shoe ?? 0)) })
      }
      if (url.includes('/api/tables')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(proxyTablesFromMocks()) })
      if (url.includes('/api/status')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ connected: true, authenticated: true, tables: proxyTablesFromMocks(), statusText: '已抓到9桌' }) })
      if (url.includes('/api/cloud-data/status')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, mtAutoLoginEnabled: false, message: 'MT自動登入未啟用', tableCount: 0 }) })
      if (url.includes('/api/online-license/status')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ configured: true }) })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items: [], reports: [], strategies: [] }) })
    }))
  })

  afterEach(() => {
    vi.useRealTimers()
    window.sessionStorage.clear()
    vi.unstubAllGlobals()
  })

  it('keeps the approved top design without the 瑞文AI版 010 subtitle', async () => {
    await renderApp()
    expect(screen.getByRole('heading', { name: 'AI百家預測軟體' })).toBeInTheDocument()
    expect(screen.queryByText('瑞文AI版 010')).not.toBeInTheDocument()
  })

  it('shows only Supabase connection status in the header and removes live status/update time', async () => {
    await renderApp()
    const header = screen.getByRole('banner')
    expect(within(header).getByText('授權後端已連線')).toBeInTheDocument()
    expect(within(header).queryByText('未連線')).not.toBeInTheDocument()
    expect(within(header).queryByText(/更新：/)).not.toBeInTheDocument()
  })

  it('v093 shows stale data badge without treating old sourceUpdatedAt as realtime', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/api/tables')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(proxyTablesFromMocks().map((table) => ({ ...table, sourceUpdatedAt: '2026-07-11T00:00:00.000Z' }))) })
      if (url.includes('/api/status')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ connected: true, authenticated: true, tableCount: 9, statusText: '雲端資料過期，等待Worker重新抓牌' }) })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items: [], reports: [], strategies: [] }) })
    }))
    await renderApp('/', false)
    expect(await screen.findByText(/雲端資料過期，等待Worker重新抓牌/)).toBeInTheDocument()
    expect(screen.queryByLabelText('AI預測結果')).not.toBeInTheDocument()
  })

  it('v098 clears the member session and returns to login on backend 401', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 401 })))
    await renderApp('/', false)
    await waitFor(() => expect(window.sessionStorage.getItem('darven-member-session-token')).toBeNull())
    expect(screen.getByRole('heading', { name: '瑞文AI百家預測' })).toBeInTheDocument()
  })

  it('removes the dashboard promo and every specified prediction confidence label', async () => {
    await renderApp()
    expect(screen.queryByLabelText('官方資訊')).not.toBeInTheDocument()
    expect(screen.queryByText('免費AI百家預測軟體')).not.toBeInTheDocument()
    expect(screen.queryByText('私訊官方賴@Dv1788')).not.toBeInTheDocument()
    expect(document.body.textContent).not.toContain('AI預測:')
    expect(document.body.textContent).not.toContain('AI信心值')
    expect(document.body.textContent).not.toContain('信心值')
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

  it('keeps five approved side metrics on row one and 閒和莊 on row two', async () => {
    await renderApp()
    const prediction = screen.getByLabelText('AI預測結果')
    const sideRow = within(prediction).getByLabelText('副項目預測機率')
    const mainRow = within(prediction).getByLabelText('莊閒預測機率')

    const sideLabels = ['閒龍寶', '閒對', '超六', '莊對', '莊龍寶']
    expect(Array.from(sideRow.querySelectorAll('.prediction-metric span')).map((node) => node.textContent)).toEqual(sideLabels)
    sideLabels.forEach((label) => {
      const item = within(sideRow).getByLabelText(`${label}預測`)
      expect(within(item).getByText(label)).toBeInTheDocument()
      expect(within(item).getByText(/\d+%/)).toHaveClass('probability-value')
    })
    expect(within(sideRow).queryByLabelText('和局預測')).not.toBeInTheDocument()

    const mainLabels = ['閒', '和', '莊']
    expect(Array.from(mainRow.querySelectorAll('.prediction-metric span')).map((node) => node.textContent)).toEqual(mainLabels)
    mainLabels.forEach((label) => {
      const item = within(mainRow).getByLabelText(`${label}預測`)
      expect(within(item).getByText(label)).toBeInTheDocument()
      expect(within(item).getByText(/\d+%/)).toHaveClass('probability-value')
    })

    expect(within(prediction).queryByText(/AI預測:/)).not.toBeInTheDocument()
    expect(within(prediction).queryByText(/AI信心值/)).not.toBeInTheDocument()
    expect(within(mainRow).getByText('和')).toBeInTheDocument()
    expect(within(prediction).queryByText(/^(高|中|低)$/)).not.toBeInTheDocument()
    expect(within(prediction).queryByText(/風險:/)).not.toBeInTheDocument()
    expect(within(prediction).queryByText(/最近 \d+ 局/)).not.toBeInTheDocument()
    expect(within(prediction).queryByText('近期莊閒趨勢相近，建議持續觀察。')).not.toBeInTheDocument()
  })

  it('v098.18 keeps backend percentages without separate prediction or confidence copy', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/api/tables')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(proxyTablesFromMocks().map((table, index) => ({
        ...table,
        prediction: { source: 'backend', predictedResult: index % 2 === 0 ? 'banker' : 'player', confidence: 34, strategyVersion: 'v098_主信心實際命中校準版' },
      }))) })
      if (url.includes('/api/status')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ connected: true, authenticated: true, tables: [], statusText: '已抓到9桌' }) })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items: [], reports: [], strategies: [] }) })
    }))

    await renderApp()

    const prediction = screen.getByLabelText('AI預測結果')
    expect(within(prediction).queryByText('AI信心值:34%')).not.toBeInTheDocument()
    expect(within(prediction).queryByText('AI預測:')).not.toBeInTheDocument()
  })

  it('v098.18 renders the current-shoe latest predictions as a fixed four-row B table', async () => {
    await renderApp()
    const history = await screen.findByLabelText('近十局預測紀錄')
    expect(screen.getByText('近十局預測紀錄')).toBeVisible()
    const rowLabels = Array.from(history.querySelectorAll('tr > th:first-child')).map((node) => node.textContent)
    expect(rowLabels).toEqual(['局數', 'AI預測', '實際開獎', '結果'])
    expect(await within(history).findByText('第1局')).toBeInTheDocument()
    expect(within(history).getByText('第2局')).toBeInTheDocument()
    expect(within(history).getByText('第3局')).toBeInTheDocument()
    expect(within(history).getAllByText('命中')).toHaveLength(1)
    expect(within(history).getAllByText('未中')).toHaveLength(2)
    expect(within(history).getByText('和')).toBeInTheDocument()
  })

  it('shows settled predictions when real-card history is incomplete for the selected round', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/api/online-license/member-session')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) })
      if (url.includes('/api/tables/BAG01/ui-history')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({
        ...tableUiHistory('BAG01', 12),
        settledPredictions: [
          { round: 20, predictedResult: 'banker', actualResult: 'banker', isHit: true },
          { round: 21, predictedResult: 'player', actualResult: 'banker', isHit: false },
          { round: 22, predictedResult: 'tie', actualResult: 'tie', isHit: true },
        ],
      }) })
      if (url.includes('/api/tables')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([
        { ...proxyTablesFromMocks()[0], shoe: 12, round: 22 },
      ]) })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ connected: true, configured: true }) })
    }))

    await renderApp('/', false)

    const history = await screen.findByLabelText('近十局預測紀錄')
    expect(await within(history).findByText('第20局')).toBeInTheDocument()
    expect(within(history).getByText('第21局')).toBeInTheDocument()
    expect(within(history).getByText('第22局')).toBeInTheDocument()
  })

  it('v098.18 clears old B-table rows immediately and ignores a late prior-table response', async () => {
    let resolveBag01!: (value: Response) => void
    const bag01History = new Promise<Response>((resolve) => { resolveBag01 = resolve })
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/api/online-license/member-session')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) })
      if (url.includes('/api/tables/BAG01/ui-history')) return bag01History
      if (url.includes('/api/tables/BAG02/ui-history')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({
        ...tableUiHistory('BAG02', mockTables[1].trend.current_shoe ?? 0),
        settledPredictions: [{ round: 22, predictedResult: 'player', actualResult: 'player', isHit: true }],
      }) })
      if (url.includes('/api/tables')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(proxyTablesFromMocks()) })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ connected: true, configured: true }) })
    }))
    await renderApp('/', false)
    const buttons = await screen.findAllByRole('button', { name: /MT百家樂第.+桌 第\d+局/ })
    fireEvent.click(buttons[1])
    expect(screen.queryByText('第1局')).not.toBeInTheDocument()
    expect(await screen.findByText('第22局')).toBeInTheDocument()
    resolveBag01({ ok: true, status: 200, json: async () => ({ ...tableUiHistory('BAG01', mockTables[0].trend.current_shoe ?? 0), settledPredictions: [{ round: 99, predictedResult: 'banker', actualResult: 'banker', isHit: true }] }) } as Response)
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByText('第99局')).not.toBeInTheDocument()
    expect(screen.getByText('第22局')).toBeInTheDocument()
  })

  it('refreshes ui-history when the selected table advances within the same shoe', async () => {
    let pushTables!: (round: number) => void
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder()
        pushTables = (round) => controller.enqueue(encoder.encode(`event: tables\ndata: ${JSON.stringify({
          tables: [{ ...proxyTablesFromMocks()[0], shoe: 12, round }],
        })}\n\n`))
      },
    })
    let historyCalls = 0
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/api/online-license/member-session')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) })
      if (url.includes('/api/tables/stream')) return Promise.resolve({ ok: true, status: 200, body: stream })
      if (url.includes('/api/tables/BAG01/ui-history')) {
        historyCalls += 1
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(tableUiHistory('BAG01', 12)) })
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ connected: true, configured: true }) })
    }))

    await renderApp('/', false)
    act(() => pushTables(0))
    await waitFor(() => expect(historyCalls).toBe(1))

    act(() => pushTables(1))
    await waitFor(() => expect(historyCalls).toBe(2))
  })

  it('keeps same-shoe history while a bounded retry waits for the durable round', async () => {
    let pushTables!: (round: number) => void
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder()
        pushTables = (round) => controller.enqueue(encoder.encode(`event: tables\ndata: ${JSON.stringify({
          tables: [{ ...proxyTablesFromMocks()[0], shoe: 12, round }],
        })}\n\n`))
      },
    })
    let historyCalls = 0
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/api/online-license/member-session')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) })
      if (url.includes('/api/tables/stream')) return Promise.resolve({ ok: true, status: 200, body: stream })
      if (url.includes('/api/tables/BAG01/ui-history')) {
        historyCalls += 1
        const durable = historyCalls !== 2
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({
          ...tableUiHistory('BAG01', 12),
          settledPredictions: [{ round: durable && historyCalls > 2 ? 4 : 3, predictedResult: 'player', actualResult: 'player', isHit: true }],
          realCardHistoryCompleteThroughRound: durable ? (historyCalls > 2 ? 1 : 0) : 0,
        }) })
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ connected: true, configured: true }) })
    }))

    await renderApp('/', false)
    act(() => pushTables(0))
    expect(await screen.findByText('第3局')).toBeInTheDocument()

    act(() => pushTables(1))
    await waitFor(() => expect(historyCalls).toBe(2))
    expect(screen.getByText('第3局')).toBeInTheDocument()
    expect(screen.queryByText('第4局')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('第4局')).toBeInTheDocument())
    expect(historyCalls).toBe(3)
  })

  it('does not invent a settled row when show_poker advances but bounded retries stay behind', async () => {
    let pushTables!: (round: number) => void
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder()
        pushTables = (round) => controller.enqueue(encoder.encode(`event: tables\ndata: ${JSON.stringify({
          tables: [{ ...proxyTablesFromMocks()[0], shoe: 12, round }],
        })}\n\n`))
      },
    })
    let historyCalls = 0
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/api/online-license/member-session')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) })
      if (url.includes('/api/tables/stream')) return Promise.resolve({ ok: true, status: 200, body: stream })
      if (url.includes('/api/tables/BAG01/ui-history')) {
        historyCalls += 1
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({
          ...tableUiHistory('BAG01', 12),
          settledPredictions: [{ round: 3, predictedResult: 'player', actualResult: 'player', isHit: true }],
          realCardHistoryCompleteThroughRound: historyCalls === 1 ? 3 : 4,
        }) })
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ connected: true, configured: true }) })
    }))

    await renderApp('/', false)
    act(() => pushTables(3))
    expect(await screen.findByText('第3局')).toBeInTheDocument()

    act(() => pushTables(4))
    await waitFor(() => expect(historyCalls).toBe(4))
    expect(screen.getByText('第3局')).toBeInTheDocument()
    expect(screen.queryByText('第4局')).not.toBeInTheDocument()
  })

  it('v096 displays backend side prediction values and actions without frontend recalculation', async () => {
    await renderApp()
    const sideRow = screen.getByLabelText('副項目預測機率')
    expect(Array.from(sideRow.querySelectorAll('.probability-value')).map((node) => node.textContent)).toEqual(['66%', '44%', '22%', '33%', '55%'])
    expect(Array.from(sideRow.querySelectorAll('.prediction-metric.active')).map((node) => node.textContent)).toEqual([expect.stringContaining('55%')])
  })

  it('v098 displays backend main probabilities verbatim instead of deriving them from score totals', async () => {
    await renderApp()

    expect(screen.getByLabelText('莊預測')).toHaveTextContent('12.5%')
    expect(screen.getByLabelText('閒預測')).toHaveTextContent('77.25%')
    expect(screen.getByLabelText('和預測')).toHaveTextContent('10.25%')
  })

  it('v098 disables all actions and warns when the backend strategy is not current', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/api/tables')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(proxyTablesFromMocks().map((table) => ({ ...table, prediction: { ...table.prediction, strategyVersion: 'v096_副預測權重與信心校準版' } }))) })
      if (url.includes('/api/online-license/member-session')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ connected: true, configured: true }) })
    }))

    await renderApp('/', false)

    expect(await screen.findByText(/策略版本不符.*停止出手/)).toBeInTheDocument()
    expect(screen.getByLabelText('AI預測結果').querySelectorAll('.prediction-metric.active')).toHaveLength(0)
  })

  it('v096 waits and never takes side actions when backend side prediction data is missing', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/api/tables')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(proxyTablesFromMocks().map((table) => ({ ...table, prediction: { source: 'backend', strategyVersion: 'v098_主信心實際命中校準版', predictedResult: 'banker', confidence: 34 } }))) })
      if (url.includes('/api/status')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ connected: true, authenticated: true, tables: [], statusText: '已抓到9桌' }) })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items: [], reports: [], strategies: [] }) })
    }))
    await renderApp()
    const sideRow = screen.getByLabelText('副項目預測機率')
    expect(sideRow.querySelectorAll('.prediction-metric.active')).toHaveLength(0)
    expect(Array.from(sideRow.querySelectorAll('.probability-value')).map((node) => node.textContent)).toEqual(['等待', '等待', '等待', '等待', '等待'])
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
    expect(within(sidebar).queryByText('Cloudflare Turnstile')).not.toBeInTheDocument()
    expect(within(sidebar).queryByRole('heading', { name: '連線控制' })).not.toBeInTheDocument()
    expect(within(sidebar).queryByText(/BAG/)).not.toBeInTheDocument()

    const expectedLabels = ['1', '2', '3', '3A', '5', '6', '7', '8', '9', '10']
    const tableButtons = within(sidebar).getAllByRole('button', { name: /MT百家樂第.+桌 第\d+局/ })
    expect(tableButtons).toHaveLength(expectedLabels.length)
    expectedLabels.forEach((tableLabel, index) => {
      expect(tableButtons[index]).toHaveTextContent(`MT百家樂第${tableLabel}桌`)
    })
  })

  it('shows only the approved ten member tables in exact identity order', async () => {
    const ids = ['BAG15', 'BAG03A', 'BAG11', 'BAG02', 'BAG13A', 'BAG01', 'BAG12', 'BAG10', 'BAG09', 'BAG08', 'BAG07', 'BAG06', 'BAG05', 'BAG13', 'BAG03', 'BAG03A']
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/api/tables')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(ids.map((tableId, index) => ({
        tableId, displayName: tableId, tableType: 'BAC', shoe: 1, round: 100 + index,
        bankerCount: 1, playerCount: 1, tieCount: 0, beadPlateRaw: '0102', bigRoadRaw: '01#02',
      }))) })
      if (url.includes('/api/online-license/status')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ configured: true }) })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ connected: true, authenticated: true }) })
    }))

    await renderApp('/', false)

    const sidebar = await screen.findByLabelText('桌號與資料選擇')
    const buttons = within(sidebar).getAllByRole('button', { name: /MT百家樂第.+桌 第\d+局/ })
    expect(buttons).toHaveLength(10)
    expect(buttons.map((button) => button.textContent?.match(/第(.+?)桌/)?.[1])).toEqual(['1', '2', '3', '3A', '5', '6', '7', '8', '9', '10'])
    expect(buttons[3]).toHaveTextContent('第3A桌 第101局')
  })

  it('v098.19 renders the six-row big road directly from authoritative MT codes with points and no legends', async () => {
    await renderApp()
    expect(screen.queryByText('珠盤路')).not.toBeInTheDocument()
    expect(document.querySelector('.bead-grid')).not.toBeInTheDocument()
    expect(screen.getByLabelText('傳統大路')).toBeInTheDocument()
    const road = screen.getByLabelText('傳統大路')
    const mtCodes = mockTables[0].trend.big2.split('#').flatMap((column) => column.split(',').map((code) => code.trim()).filter((code) => /^\d{4}$/.test(code)))
    await waitFor(() => expect(document.querySelectorAll('.big-cell')).toHaveLength(mtCodes.length))
    expect(within(road).queryByText('和')).not.toBeInTheDocument()
    expect(screen.queryByText(/紅圈＝莊|藍圈＝閒|tie/i)).not.toBeInTheDocument()
    expect(document.querySelector('.big-cell.Tie')).not.toBeInTheDocument()
    expect(document.querySelectorAll('.big-cell.Banker')).toHaveLength(mtCodes.filter((code) => code[3] === '2').length)
    expect(document.querySelectorAll('.big-cell.Player')).toHaveLength(mtCodes.filter((code) => code[3] === '1').length)
    expect(within(road).getAllByText(mtCodes[0][1]).length).toBeGreaterThan(0)
    expect(document.querySelectorAll('.big-cell.tie-mark')).toHaveLength(mtCodes.filter((code) => Number(code[0]) > 0).length)
    const heading = screen.getByRole('heading', { name: '大路' }).parentElement!
    expect(within(heading).getByText(`莊局數：${mockTables[0].trend.total_round_banker}`)).toHaveClass('Banker')
    expect(within(heading).getByText(`閒局數：${mockTables[0].trend.total_round_player}`)).toHaveClass('Player')
  })

  it('v046 shows a formal waiting state instead of mock tables when cloud data is empty', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/api/tables')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) })
      if (url.includes('/api/status')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ connected: false, authenticated: false, statusText: 'MT自動登入未啟用，等待手動或Worker資料來源' }) })
      if (url.includes('/api/online-license/status')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ configured: true, agents: [], licenses: [] }) })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
    }))
    await renderApp('/', false)
    expect(await screen.findByRole('heading', { name: '等待雲端資料' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /MT百家樂第1桌/ })).not.toBeInTheDocument()
    expect(await screen.findByText(/MT自動登入未啟用/)).toBeInTheDocument()
  })

  it('v046 admin create license and agent actions send real member/admin payloads to backend', async () => {
    const calls: Array<{ url: string; body: any }> = []
    vi.stubGlobal('prompt', vi.fn()
      .mockReturnValueOnce('A1688')
      .mockReturnValueOnce('agent')
      .mockReturnValueOnce('Admin001'))
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (init?.body) calls.push({ url, body: JSON.parse(String(init.body)) })
      if (url.includes('/api/cloud-data/status')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ mtAutoLoginEnabled: false, message: 'MT自動登入未啟用', tableCount: 15, todayRoundCount: 88 }) })
      if (url.includes('/api/online-license/status')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ configured: true, agents: [{ code: 'Admin001', role: 'manager', permission: '可開代理 / 可建碼' }], licenses: [] }) })
      if (url.includes('/api/online-license/licenses')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, row: { code: 'Admin001_001', member_account: 'User1688' } }) })
      if (url.includes('/api/online-license/agents')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, row: { code: 'A1688' } }) })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
    }))
    window.sessionStorage.setItem('darven-admin-account', 'Admin001')
    await renderApp('/admin', false)
    fireEvent.change(screen.getByPlaceholderText('請輸入會員帳號'), { target: { value: 'User1688' } })
    fireEvent.click(screen.getByRole('button', { name: '建立授權' }))
    fireEvent.change(screen.getByPlaceholderText('輸入代理帳號尾碼'), { target: { value: 'A1688' } })
    fireEvent.click(screen.getByRole('button', { name: '新增帳號' }))
    await waitFor(() => expect(calls.some((call) => call.url.includes('/api/online-license/licenses') && call.body.memberAccount === 'User1688' && call.body.adminSessionToken === 'test-admin-session')).toBe(true))
    expect(document.body.textContent).toMatch(/88/)
  })

  it('v045 overlays a green tie slash on banker/player big-road cells when a tie appears', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/ui-history')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({
        ...tableUiHistory('BAG01', 1),
        settledPredictions: [],
        realCardRounds: [
          { round: 1, result: 'tie', bankerPoint: 6, playerPoint: 6 },
          { round: 2, result: 'tie', bankerPoint: 5, playerPoint: 5 },
          { round: 3, result: 'banker', bankerPoint: 8, playerPoint: 4 },
          { round: 4, result: 'tie', bankerPoint: 7, playerPoint: 7 },
          { round: 5, result: 'tie', bankerPoint: 4, playerPoint: 4 },
          { round: 6, result: 'player', bankerPoint: 1, playerPoint: 9 },
        ],
        realCardHistoryCompleteThroughRound: 6,
      }) })
      if (url.includes('/api/tables')) return Promise.resolve({ ok: true, json: () => Promise.resolve([{
        tableId: 'BAG01',
        displayName: 'MT百家樂第1桌',
        tableType: 'baccarat',
        shoe: 1,
        round: 8,
        bankerCount: 3,
        playerCount: 3,
        tieCount: 2,
        beadPlateRaw: '0101,0303,0202,0303,0101',
        bigRoadRaw: '1802#0901',
      }]) })
      if (url.includes('/api/online-license/status')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ configured: true }) })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
    }))
    await renderApp('/', false)
    await waitFor(() => expect(document.querySelectorAll('.big-cell.tie-mark')).toHaveLength(1))
    expect(document.querySelector('.big-cell.Tie')).not.toBeInTheDocument()
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

  it('keeps the selected approved table identity when an earlier table disappears and reappears', () => {
    const selectedTableId = 'BAG02'
    expect(selectMemberTable(mockTables, selectedTableId)?.id).toBe('BAG02')
    expect(selectMemberTable(mockTables.filter((table) => table.id !== 'BAG01'), selectedTableId)?.id).toBe('BAG02')
    expect(selectMemberTable(mockTables, selectedTableId)?.id).toBe('BAG02')
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
      bankerDragon: 46,
      playerDragon: 35,
      bankerPair: 37,
      playerPair: 40,
      superSix: 45,
      tie: 41,
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

  it('v016 predicts only Banker or Player with confidence varied within 30-70 and no observe recommendation', () => {
    expect(calculatePrediction([])).toMatchObject({ recommendation: 'Player', confidence: 30 })
    expect(calculatePrediction([
      { code: '01', outcome: 'Player' },
      { code: '03', outcome: 'Tie' },
    ])).toMatchObject({ recommendation: 'Player' })
    expect(calculatePrediction([
      { code: '01', outcome: 'Player' },
      { code: '03', outcome: 'Tie' },
    ]).confidence).toBeGreaterThanOrEqual(30)
    const strongBanker = calculatePrediction(Array.from({ length: 20 }, () => ({ code: '02', outcome: 'Banker' })))
    expect(strongBanker.recommendation).toBe('Banker')
    expect(strongBanker.confidence).toBeGreaterThan(30)
    expect(strongBanker.confidence).toBeLessThanOrEqual(70)
  })

  it('v062 breaks exact main-score ties without defaulting to banker', () => {
    expect(calculatePrediction([
      { code: '02', outcome: 'Banker' },
      { code: '01', outcome: 'Player' },
    ])).toMatchObject({ recommendation: 'Banker', confidence: 30 })
    expect(calculatePrediction([
      { code: '01', outcome: 'Player' },
      { code: '02', outcome: 'Banker' },
    ])).toMatchObject({ recommendation: 'Player', confidence: 30 })
  })

  it('v016 excludes ties from main prediction hit-rate scoring', () => {
    expect(scoreMainPrediction('Banker', 'Banker')).toEqual({ evaluated: true, hit: true, push: false })
    expect(scoreMainPrediction('Banker', 'Player')).toEqual({ evaluated: true, hit: false, push: false })
    expect(scoreMainPrediction('Banker', 'Tie')).toEqual({ evaluated: false, hit: false, push: true })
  })

  it('v051 records every side prediction for learning but only counts action when each threshold is reached', () => {
    expect(SIDE_PREDICTION_THRESHOLDS).toEqual({
      tie: 47,
      superSix: 65,
      bankerPair: 53,
      playerPair: 55,
      bankerDragon: 53,
      playerDragon: 57,
    })
    expect(createSidePredictionLearningRecord({
      tie: 46,
      superSix: 64,
      bankerPair: 49,
      playerPair: 55,
      bankerDragon: 53,
      playerDragon: 52,
    }, {
      tie: true,
      superSix: false,
      bankerPair: false,
      playerPair: true,
      bankerDragon: false,
      playerDragon: false,
    })).toEqual(expect.objectContaining({
      learnedEvents: 6,
      actions: expect.objectContaining({
        tie: false,
        superSix: false,
        bankerPair: false,
        playerPair: true,
        bankerDragon: false,
        playerDragon: false,
      }),
      hits: expect.objectContaining({
        playerPair: true,
        bankerDragon: false,
      }),
    }))

    expect(isSidePredictionActionable('tie', 46)).toBe(false)
    expect(isSidePredictionActionable('tie', 47)).toBe(true)
    expect(isSidePredictionActionable('superSix', 64)).toBe(false)
    expect(isSidePredictionActionable('superSix', 65)).toBe(true)
    expect(isSidePredictionActionable('bankerPair', 49)).toBe(false)
    expect(isSidePredictionActionable('playerPair', 54)).toBe(false)
    expect(isSidePredictionActionable('playerPair', 55)).toBe(true)
    expect(isSidePredictionActionable('bankerDragon', 52)).toBe(false)
    expect(isSidePredictionActionable('bankerDragon', 53)).toBe(true)
    expect(isSidePredictionActionable('playerDragon', 56)).toBe(false)
    expect(isSidePredictionActionable('playerDragon', 57)).toBe(true)
  })


  it('v084 dragon bonus follows main side and threshold', () => {
    expect(getSidePredictionActions({
      tie: 0,
      superSix: 0,
      bankerPair: 0,
      playerPair: 0,
      bankerDragon: 53,
      playerDragon: 0,
    }, 'Banker')).toEqual(expect.objectContaining({ bankerDragon: true, playerDragon: false }))
    expect(getSidePredictionActions({
      tie: 0,
      superSix: 0,
      bankerPair: 0,
      playerPair: 0,
      bankerDragon: 95,
      playerDragon: 95,
    }, 'Banker')).toEqual(expect.objectContaining({ bankerDragon: true, playerDragon: false }))
  })

  it('v084 gates super six and dragon bonus by main prediction', () => {
    const bankerBonus = {
      tie: 0,
      superSix: 95,
      bankerPair: 0,
      playerPair: 0,
      bankerDragon: 66,
      playerDragon: 54,
    }
    const playerBonus = {
      tie: 0,
      superSix: 95,
      bankerPair: 0,
      playerPair: 0,
      bankerDragon: 54,
      playerDragon: 66,
    }
    expect(getSidePredictionActions(playerBonus, 'Player')).toEqual(expect.objectContaining({
      superSix: false,
      bankerDragon: false,
      playerDragon: true,
    }))
    expect(getSidePredictionActions(bankerBonus, 'Banker')).toEqual(expect.objectContaining({
      superSix: true,
      bankerDragon: true,
      playerDragon: false,
    }))
  })


  it('v068 keeps side prediction weights independent per target with requested action rates', () => {
    expect(SIDE_PREDICTION_ACTION_RATE_TARGETS).toEqual({
      tie: 0.15,
      superSix: 0.10,
      bankerPair: 0.20,
      playerPair: 0.20,
      bankerDragon: 0.08,
      playerDragon: 0.08,
    })
    expect(Object.keys(SIDE_PREDICTION_WEIGHT_PROFILES.tie)).toHaveLength(33)
    expect(Object.keys(SIDE_PREDICTION_WEIGHT_PROFILES.superSix)).toHaveLength(33)
    expect(SIDE_PREDICTION_WEIGHT_PROFILES.tie).not.toEqual(SIDE_PREDICTION_WEIGHT_PROFILES.superSix)
    expect(SIDE_PREDICTION_WEIGHT_PROFILES.bankerPair).not.toEqual(SIDE_PREDICTION_WEIGHT_PROFILES.bankerDragon)
  })

  it('v017 detects road trends including single jump, double jump, long dragon, double dragon, and slopes', () => {
    expect(detectRoadTrends(['Banker', 'Player', 'Banker', 'Player', 'Banker']).singleJump).toBe(true)
    expect(detectRoadTrends(['Banker', 'Banker', 'Player', 'Player', 'Banker', 'Banker']).doubleJump).toBe(true)
    expect(detectRoadTrends(['Player', 'Banker', 'Banker', 'Banker', 'Banker']).longDragon).toEqual({ side: 'Banker', length: 4 })
    expect(detectRoadTrends(['Banker', 'Banker', 'Banker', 'Player', 'Player', 'Player']).doubleDragon).toBe(true)
    expect(detectRoadTrends(['Banker', 'Player', 'Banker', 'Banker', 'Player', 'Player', 'Banker', 'Banker', 'Banker']).upSlope).toBe(true)
    expect(detectRoadTrends(['Banker', 'Banker', 'Banker', 'Player', 'Player', 'Banker', 'Player']).downSlope).toBe(true)
  })

  it('v067 uses high-hit weighted main and side prediction weights in the current frontend scorer', () => {
    const prediction = evaluateFiveRoadPrediction({
      beadCells: [
        { code: '02', outcome: 'Banker' },
        { code: '01', outcome: 'Player' },
        { code: '02', outcome: 'Banker' },
        { code: '02', outcome: 'Banker' },
      ],
      bigRoadCells: parseBigRoad('0102,0202,0302,#0101,#0102,0202'),
      askRoad: { next_banker2: { big: '111' }, next_player2: { big: '222' } },
      tableStats: { banker: 31, player: 22, tie: 4, total_round_banker_pair: 3, total_round_player_pair: 2 },
      globalStats: { banker: 188, player: 164, tie: 30 },
      tableContext: { table_id: 'BAG01', display_name: 'MT百家樂第1桌', dealer_name: '小旻', total_players: 123, room_id: '29', shoe: 12, round: 34 },
      roadRaw: { bead_road: '0102#0201', big_road: '0102,0201', big_eye_road: '1,2', small_road: '2,1', cockroach_road: '1,1' },
    })

    expect(Object.keys(ALL_MT_EQUAL_MAIN_WEIGHTS)).toHaveLength(36)
    expect(Object.keys(ALL_MT_EQUAL_SIDE_WEIGHTS)).toHaveLength(33)
    expect(prediction.weights.table_id).toBe(0)
    expect(prediction.weights.big_road).toBeCloseTo(0.15)
    expect(prediction.weights.big_eye_road).toBeCloseTo(0.13)
    expect(prediction.weights.next_player_road).toBeCloseTo(0.12)
    expect(prediction.weights.super_six).toBeCloseTo(0.005)
    expect(prediction.sourceScores.big_eye_road).toBeDefined()
    expect(prediction.sourceScores.next_banker_road).toBeDefined()
    expect(prediction.confidence).toBeGreaterThanOrEqual(30)
    expect(prediction.confidence).toBeLessThanOrEqual(70)
  })

  it('v064 main probability row uses five-road weighted score totals instead of mirroring confidence', () => {
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
    const row = calculateMainOutcomeProbabilities(prediction, 7)

    expect(prediction.recommendation).toBe('Banker')
    expect(row.banker).toBe(52)
    expect(row.player).toBe(41)
    expect(row.tie).toBe(7)
    expect(row.banker).not.toBe(prediction.confidence)
    expect(row.banker + row.player + row.tie).toBe(100)
  })

  it('v017 report-facing prediction still hides internal source-weight hit rates from UI text', async () => {
    await renderApp()
    const prediction = screen.getByLabelText('AI預測結果')
    expect(within(prediction).queryByText(/AI預測:/)).not.toBeInTheDocument()
    expect(within(prediction).queryByText(/AI信心值/)).not.toBeInTheDocument()
    expect(within(prediction).queryByText(/珠盤路|大眼仔|小路|蟑螂|單跳|雙跳|權重/)).not.toBeInTheDocument()
  })

  it('v098.18 removes the free-version contact copy from member login', async () => {
    await renderApp('/login', false)
    expect(screen.getByRole('heading', { name: '瑞文AI百家預測' })).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('免費版請私訊官方賴@Dv1788')
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
        prediction: {
          source: 'backend', strategyVersion: 'v098_主信心實際命中校準版',
          predictedResult: 'banker', confidence: 34, probabilities: { banker: 54, player: 46, tie: 0 }, scoreTotals: { banker: 38, player: 33 },
        },
      }))),
    } as Response))

    await renderApp()

    await waitFor(() => expect(screen.getByLabelText('莊預測')).toHaveTextContent('54%'))
    expect(screen.getByLabelText('閒預測')).toHaveTextContent('46%')
  })

  it('v030 member login calls online license API and enters frontend only after success', async () => {
    const fetchMock = vi.fn((url: string, options?: RequestInit) => {
      if (url.includes('/api/online-license/member-login')) {
        expect(options?.body).toBe(JSON.stringify({ memberAccount: 'User001', verificationPassword: 'DVAI1788_001' }))
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, memberSessionToken: 'member-session-1', sessionExpiresAt: '2026-07-13T20:30:00.000Z', license: { code: 'DVAI1788_001' } }) })
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ connected: true }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    await renderApp('/login', false)

    expect(screen.getByRole('heading', { name: '瑞文AI百家預測' })).toBeInTheDocument()
    expect(screen.getByPlaceholderText('請輸入會員帳號')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('請輸入驗證密碼')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('請輸入驗證碼')).not.toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('請輸入會員帳號'), { target: { value: 'User001' } })
    fireEvent.change(screen.getByPlaceholderText('請輸入驗證密碼'), { target: { value: 'DVAI1788_001' } })
    fireEvent.click(screen.getByRole('button', { name: '會員登入' }))

    expect(await screen.findByText('登入成功，正在進入前台')).toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([url, options]) => String(url).includes('/api/online-license/member-login') && (options as RequestInit)?.method === 'POST')).toBe(true)
    expect(window.sessionStorage.getItem('darven-member-session-token')).toBe('member-session-1')
    expect(window.sessionStorage.getItem('darven-member-login')).toBeNull()
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

    expect(screen.getByRole('heading', { name: '瑞文AI百家管理後台' })).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('請輸入帳號'), { target: { value: 'DVAI' } })
    fireEvent.click(screen.getByRole('button', { name: '登入' }))

    expect(await screen.findByText('登入成功，正在進入後台')).toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([url, options]) => String(url).includes('/api/online-license/agent-login') && (options as RequestInit)?.method === 'POST')).toBe(true)
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
    await waitFor(() => expect(document.body.textContent).toContain('DVAI1788_001'))
    await waitFor(() => expect(screen.queryByText('Agent001')).not.toBeInTheDocument())
    expect(screen.queryByText('Agent001_001')).not.toBeInTheDocument()
  })

  it('v032 admin shows Supabase error message instead of staying at 檢查中', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/api/online-license/status')) return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items: [], reports: [], strategies: [] }) })
    }))

    await renderApp('/admin', false)
    expect(await screen.findByText('授權後端連線失敗 (401)')).toBeInTheDocument()
    expect(screen.queryByText('檢查中')).not.toBeInTheDocument()
  })

  it('v034 admin shows latest auto-synced 300-round test report metrics from memory center', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/api/online-core/memory-center')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ connected: true, items: [], strategies: [], reports: [{ strategy_version: 'v034-auto-memory', report_type: '300_round_live_test', rounds: 300, main_hit_rate: '51.80', hits: 144, misses: 134, pushes: 22, report_path: 'proxy/reports/draven-v034-300-round-report.png' }] }) })
      if (url.includes('/api/online-license/status')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ managers: [], agents: [], plans: [], licenses: [] }) })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ connected: true, project: { name: 'AI百家' }, featureFlags: {} }) })
    }))

    await renderApp('/admin', false)

    expect(await screen.findByText('線上記憶與報表')).toBeInTheDocument()
    expect(screen.getByText('莊命中率')).toBeInTheDocument()
  })

  it('v035 admin shows strategy comparison, weak-table analysis, and next-version suggestions', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/api/online-core/strategy-analysis')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ connected: true, strategyRows: [{ strategy_version: 'v034-auto-memory', rounds: 300, main_hit_rate: '54.50', hits: 150, misses: 125, conclusion: '目前最佳' }], weakTables: [{ name: 'MT百家樂第5桌', hitRate: 38.5 }], strongTables: [{ name: 'MT百家樂第2桌', hitRate: 64 }], suggestions: ['第5桌低於45%，建議降低信心權重並啟用反向檢查'] }) })
      if (url.includes('/api/online-core/memory-center')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ connected: true, items: [], strategies: [], reports: [{ strategy_version: 'v034-auto-memory', report_type: '300_round_live_test', rounds: 300, main_hit_rate: '54.50', hits: 150, misses: 125, pushes: 25 }] }) })
      if (url.includes('/api/online-license/status')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ managers: [], agents: [], plans: [], licenses: [] }) })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ connected: true, project: { name: 'AI百家' }, featureFlags: {} }) })
    }))

    await renderApp('/admin', false)

    expect(await screen.findByText('線上記憶與報表')).toBeInTheDocument()
    expect(screen.getByText('弱桌分析')).toBeInTheDocument()
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
    expect(within(codePanel).getByLabelText('勾選 Agent001_001')).toHaveAttribute('type', 'checkbox')
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
      expect.stringContaining('線上設定管理'),
      expect.stringContaining('數據抓取'),
      expect.stringContaining('資料庫'),
      expect.stringContaining('記憶中心'),
    ])
    expect(summary).toHaveClass('v044-summary-grid')

    expect(screen.queryByLabelText('線上授權正式重建')).not.toBeInTheDocument()
    expect(screen.getByLabelText('管理總覽')).toHaveClass('v044-summary-grid')

    const agentInput = screen.getByPlaceholderText('請輸入代理帳號')
    expect(agentInput).toHaveValue('DVAI')
    expect(agentInput).toHaveAttribute('readonly')

    const daysInput = screen.getByLabelText('方案天數')
    fireEvent.change(daysInput, { target: { value: '99' } })
    expect(daysInput).toHaveValue(30)

    expect(screen.queryByText('超級管理員')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('勾選 DVAI')).not.toBeInTheDocument()
    expect(screen.getByText('下級代理')).toBeInTheDocument()
    expect(screen.queryByLabelText('勾選 Agent001')).not.toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('尋找代理帳號'), { target: { value: 'View001' } })
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

    await waitFor(() => expect(screen.getByLabelText('已建立驗證碼')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: '刪除驗證碼' })).toBeInTheDocument()
  })

  it('v045 admin has logout and frontend/backend inactivity clears login state after 10 minutes', async () => {
    vi.useFakeTimers()
    window.sessionStorage.setItem('darven-admin-account', 'DVAI')
    window.sessionStorage.setItem('darven_admin_login', 'yes')
    const adminRender = await renderApp('/admin', false)
    expect(screen.getByRole('button', { name: '登出' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '登出' }))
    expect(window.sessionStorage.getItem('darven-admin-account')).toBeNull()
    expect(window.sessionStorage.getItem('darven_admin_login')).toBeNull()
    adminRender.unmount()

    window.sessionStorage.setItem('darven-member-session-token', 'test-member-session')
    window.sessionStorage.setItem('darven-member-session-expires-at', new Date(Date.now() + 600000).toISOString())
    await renderApp('/', false)
    act(() => { vi.advanceTimersByTime(600001) })
    expect(window.sessionStorage.getItem('darven-member-session-token')).toBeNull()
    vi.useRealTimers()
  })
})
