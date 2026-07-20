import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchTableUiHistory, LiveRoadClient, isLiveTableStale } from './liveClient'

describe('LiveRoadClient status messages', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('fetches one table ui-history with bearer auth and exposes 401/503 fail-closed status', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({
        ok: true,
        buildVersion: '098',
        tableId: 'BAG03A',
        shoe: 9,
        settledPredictions: [{ round: 1, predictedResult: 'banker', actualResult: 'tie', isHit: false }],
        realCardRounds: [{ round: 1, result: 'tie', bankerPoint: 6, playerPoint: 6 }],
        realCardHistoryCompleteThroughRound: 1,
      }) })
      .mockResolvedValueOnce({ ok: false, status: 401, json: () => Promise.resolve({}) })
      .mockResolvedValueOnce({ ok: false, status: 503, json: () => Promise.resolve({}) })
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchTableUiHistory('BAG03A', 'opaque-member-token')).resolves.toMatchObject({ tableId: 'BAG03A', shoe: 9 })
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toMatch(/\/api\/tables\/BAG03A\/ui-history$/)
    expect(String(url)).not.toContain('opaque-member-token')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer opaque-member-token')
    await expect(fetchTableUiHistory('BAG03A', 'opaque-member-token')).rejects.toMatchObject({ status: 401 })
    await expect(fetchTableUiHistory('BAG03A', 'opaque-member-token')).rejects.toMatchObject({ status: 503 })
  })

  it('reports proxy running but MT not connected when status endpoint has no tables', async () => {
    vi.useFakeTimers()
    const statuses: Array<{ state: string; message: string }> = []
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.endsWith('/api/status')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ connected: false, authenticated: null, tables: [], buildVersion: 'v102' }) })
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
    }))

    const client = new LiveRoadClient({ onTables: vi.fn(), onStatus: (status) => statuses.push(status) })
    client.connect()
    await vi.runOnlyPendingTimersAsync()
    client.disconnect(false)

    expect(statuses.some((status) => status.message === 'proxy已啟動，MT未連線，請確認 Token 是否過期')).toBe(true)
  })

  it('reports token authenticated but still waiting when MT is connected without table rows', async () => {
    vi.useFakeTimers()
    const statuses: Array<{ state: string; message: string }> = []
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.endsWith('/api/status')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ connected: true, authenticated: true, tables: [], buildVersion: 'v102' }) })
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
    }))

    const client = new LiveRoadClient({ onTables: vi.fn(), onStatus: (status) => statuses.push(status) })
    client.connect()
    await vi.runOnlyPendingTimersAsync()
    client.disconnect(false)

    expect(statuses.some((status) => status.message === 'MT已驗證，等待桌況資料…')).toBe(true)
  })

  it('surfaces proxy capture source statusText when available', async () => {
    vi.useFakeTimers()
    const statuses: Array<{ state: string; message: string }> = []
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.endsWith('/api/status')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ connected: true, statusText: 'Chrome已連接，等待MT登入驗證', buildVersion: 'v102' }) })
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
    }))

    const client = new LiveRoadClient({ onTables: vi.fn(), onStatus: (status) => statuses.push(status) })
    client.connect()
    await vi.runOnlyPendingTimersAsync()
    client.disconnect(false)

    expect(statuses.some((status) => status.message === 'Chrome已連接，等待MT登入驗證')).toBe(true)
  })

  it('preserves rich MT road, ask-road and table context fields for AI scoring', async () => {
    vi.useFakeTimers()
    const received: any[] = []
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.endsWith('/api/status')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ connected: true, authenticated: true, tableCount: 1, buildVersion: 'v102' }) })
      return Promise.resolve({ ok: true, json: () => Promise.resolve([{
        tableId: 'BAG01', displayName: 'MT百家樂第1桌', tableType: 'BAC', shoe: 12, round: 34,
        bankerCount: 11, playerCount: 10, tieCount: 2, bankerPairCount: 3, playerPairCount: 4,
        beadPlateRaw: '0102#0201', bigRoadRaw: '0102,0201', bigEyeRaw: '1,2', smallRoadRaw: '2,1', cockroachRaw: '1,1',
        nextBankerRaw: { big: 'ask banker' }, nextPlayerRaw: { big: 'ask player' },
        prediction: {
          strategyVersion: 'v096_副預測權重與信心校準版', predictedResult: 'banker', confidence: 57,
          sidePredictions: { tie: 11, superSix: 22, bankerPair: 33, playerPair: 44, bankerDragon: 55, playerDragon: 66 },
          sideActions: { tie: false, superSix: false, bankerPair: false, playerPair: false, bankerDragon: true, playerDragon: false },
        },
        dealerName: '小旻', totalPlayers: 123, roomId: '29', state: 0, orderState: 1, sourceUpdatedAt: new Date().toISOString(),
      }]) })
    }))

    const client = new LiveRoadClient({ onTables: (tables) => received.push(...tables), onStatus: vi.fn() })
    client.connect()
    await vi.runOnlyPendingTimersAsync()
    client.disconnect(false)

    expect(received[0].trend.big_eye2).toBe('1,2')
    expect(received[0].trend.small2).toBe('2,1')
    expect(received[0].trend.cockroach2).toBe('1,1')
    expect(received[0].trend.next_banker2).toEqual({ big: 'ask banker' })
    expect(received[0].dealerName).toBe('小旻')
    expect(received[0].totalPlayers).toBe(123)
    expect(received[0].roomId).toBe('29')
    expect(Date.parse(received[0].sourceUpdatedAt)).toBeGreaterThan(0)
    expect(received[0].prediction).toEqual({
      strategyVersion: 'v096_副預測權重與信心校準版', predictedResult: 'banker', confidence: 57,
      sidePredictions: { tie: 11, superSix: 22, bankerPair: 33, playerPair: 44, bankerDragon: 55, playerDragon: 66 },
      sideActions: { tie: false, superSix: false, bankerPair: false, playerPair: false, bankerDragon: true, playerDragon: false },
    })
  })

  it('marks source-updated tables as stale after the allowed live window', () => {
    const now = Date.parse('2026-07-11T10:00:00.000Z')
    expect(isLiveTableStale({ sourceUpdatedAt: '2026-07-11T09:59:20.000Z' }, now, 60000)).toBe(false)
    expect(isLiveTableStale({ sourceUpdatedAt: '2026-07-11T09:58:00.000Z' }, now, 60000)).toBe(true)
    expect(isLiveTableStale({ sourceUpdatedAt: null }, now, 60000)).toBe(true)
    expect(isLiveTableStale({ sourceUpdatedAt: 'not-a-date' }, now, 60000)).toBe(true)
  })

  it('preserves accepted tables when a partial response omits them', async () => {
    vi.useFakeTimers()
    const received: any[][] = []
    let tableCalls = 0
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith('/api/status')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ connected: true, authenticated: true, tableCount: 1, buildVersion: 'v102' }) })
      if (url.endsWith('/api/tables/stream')) return Promise.resolve({ ok: false, status: 503, body: null })
      tableCalls += 1
      const rows = tableCalls === 1 ? [{
        tableId: 'BAG01', displayName: 'MT百家樂第1桌', tableType: 'BAC', round: 1,
        beadPlateRaw: '0102', bigRoadRaw: '0102', sourceUpdatedAt: new Date().toISOString(),
      }] : []
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer member-session-1')
      return Promise.resolve({ ok: true, json: () => Promise.resolve(rows) })
    }))

    const client = new LiveRoadClient({ memberSessionToken: 'member-session-1', onTables: (tables) => received.push(tables), onStatus: vi.fn() })
    client.connect()
    await vi.advanceTimersByTimeAsync(5001)
    await vi.advanceTimersByTimeAsync(5001)
    client.disconnect(false)

    expect(received[0]).toHaveLength(1)
    expect(received.at(-1)).toHaveLength(1)
    expect(received.at(-1)?.[0].table_id).toBe('BAG01')
  })

  it('fails closed when backend status reports stale despite fresh table timestamps', async () => {
    vi.useFakeTimers()
    const received: any[][] = []
    const statuses: Array<{ state: string; message: string }> = []
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.endsWith('/api/status')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ connected: true, authenticated: true, statusText: '雲端資料 stale，等待Worker更新', buildVersion: 'v102' }) })
      return Promise.resolve({ ok: true, json: () => Promise.resolve([{
        tableId: 'BAG01', displayName: 'MT百家樂第1桌', tableType: 'BAC', round: 1,
        beadPlateRaw: '0102', bigRoadRaw: '0102', sourceUpdatedAt: new Date().toISOString(),
      }]) })
    }))

    const client = new LiveRoadClient({ memberSessionToken: 'member-session-1', onTables: (tables) => received.push(tables), onStatus: (status) => statuses.push(status) })
    client.connect()
    await vi.advanceTimersByTimeAsync(1)
    client.disconnect(false)

    expect(received.at(-1)).toEqual([])
    expect(statuses.at(-1)?.message).toMatch(/stale|過期/i)
  })

  it('throttles backup polling while SSE heartbeat is fresh', async () => {
    vi.useFakeTimers()
    let streamController: ReadableStreamDefaultController<Uint8Array>
    const fetchMock = vi.fn((url: string) => {
      if (!url.endsWith('/api/tables/stream')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) })
      return Promise.resolve({
        ok: true,
        status: 200,
        body: new ReadableStream({
          start(controller) {
            streamController = controller
            controller.enqueue(new TextEncoder().encode('event: heartbeat\ndata: {}\n\n'))
          },
        }),
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = new LiveRoadClient({ onTables: vi.fn(), onStatus: vi.fn() })
    client.connect()
    await vi.advanceTimersByTimeAsync(11000)
    streamController!.enqueue(new TextEncoder().encode('event: heartbeat\ndata: {}\n\n'))
    await vi.advanceTimersByTimeAsync(3000)
    client.disconnect(false)
    streamController!.close()

    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/tables'))).toHaveLength(0)
  })

  it('retains the first durable prediction when equal-time same-id content conflicts', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-16T01:00:30.000Z'))
    const received: any[][] = []
    const sourceUpdatedAt = '2026-07-16T01:00:00.000Z'
    const firstPrediction = {
      source: 'backend', predictionId: 'pid-1', issuedAt: '2026-07-16T01:00:01.000Z',
      strategyVersion: 'v98', targetTableId: 'BAG01', targetShoe: 88, targetRound: 21,
      predictedResult: 'banker', confidence: 51,
      probabilities: { banker: 51, player: 44, tie: 5 }, scoreTotals: { banker: 0.51, player: 0.49 },
      sidePredictions: { tie: 1, superSix: 2, bankerPair: 3, playerPair: 4, bankerDragon: 5, playerDragon: 6 },
      sideActions: { tie: false, superSix: false, bankerPair: false, playerPair: false, bankerDragon: false, playerDragon: false },
    }
    const conflictingPrediction = {
      ...firstPrediction, issuedAt: '2026-07-16T01:00:02.000Z', strategyVersion: 'conflict', targetTableId: 'BAG09', targetShoe: 99, targetRound: 999,
      predictedResult: 'player', confidence: 69,
      probabilities: { banker: 1, player: 98, tie: 1 }, scoreTotals: { banker: 0.01, player: 0.99 },
      sidePredictions: { tie: 60, superSix: 50, bankerPair: 40, playerPair: 30, bankerDragon: 20, playerDragon: 10 },
      sideActions: { tie: true, superSix: true, bankerPair: true, playerPair: true, bankerDragon: true, playerDragon: true },
    }
    let tableCalls = 0
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.endsWith('/api/status')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ connected: true, authenticated: true, tableCount: 1, buildVersion: 'v102' }) })
      if (url.endsWith('/api/tables/stream')) return Promise.resolve({ ok: false, status: 503, body: null })
      tableCalls += 1
      const firstPayload = tableCalls === 1
      const prediction = firstPayload ? firstPrediction : conflictingPrediction
      return Promise.resolve({ ok: true, json: () => Promise.resolve([{
        tableId: 'BAG01', tableType: 'BAC', shoe: 88, round: 20, sourceUpdatedAt, prediction,
        bankerCount: firstPayload ? 1 : 999,
        beadPlateRaw: firstPayload ? '0102' : '9999',
        dealerName: firstPayload ? '原始荷官' : '衝突荷官',
      }]) })
    }))

    const client = new LiveRoadClient({ onTables: (tables) => received.push(tables), onStatus: vi.fn() })
    client.connect()
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(5001)
    client.disconnect(false)

    expect(received.at(-1)?.[0].prediction).toEqual(firstPrediction)
    expect(received.at(-1)?.[0].trend.total_round_banker).toBe(1)
    expect(received.at(-1)?.[0].trend.bead_plate2).toBe('0102')
    expect(received.at(-1)?.[0].dealerName).toBe('原始荷官')
  })

  it('prunes omitted tables by each table TTL without clearing fresh peers or changing order', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-16T01:00:00.000Z'))
    const received: any[][] = []
    const makeTable = (id: string, sourceUpdatedAt: string) => ({
      id, table_id: id, table_type: 'BAC', sourceUpdatedAt,
      trend: { bead_plate2: '', big2: '', current_round: 1, current_shoe: 1 },
    })
    const tableA = makeTable('BAG01', '2026-07-16T00:58:30.000Z')
    const tableB = makeTable('BAG02', '2026-07-16T00:59:30.000Z')
    const tableC = makeTable('BAG03', '2026-07-16T01:00:00.000Z')
    const client = new LiveRoadClient({ onTables: (tables) => received.push(tables), onStatus: vi.fn() })
    const publish = (tables: any[]) => (client as any).publishTables(tables, 'test')

    publish([tableA, tableB, tableC])
    expect(received.at(-1)?.map((table) => table.table_id)).toEqual(['BAG01', 'BAG02', 'BAG03'])

    vi.setSystemTime(new Date('2026-07-16T01:00:31.000Z'))
    publish([tableC])
    expect(received.at(-1)?.map((table) => table.table_id)).toEqual(['BAG02', 'BAG03'])

    vi.setSystemTime(new Date('2026-07-16T01:01:31.000Z'))
    publish([tableC])
    expect(received.at(-1)?.map((table) => table.table_id)).toEqual(['BAG03'])
  })

})
