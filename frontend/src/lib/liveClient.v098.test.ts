import { afterEach, describe, expect, it, vi } from 'vitest'
import { getBackendPredictionIssue, LiveRoadClient, type LiveTable } from './liveClient'
// @ts-expect-error Proxy is JavaScript and intentionally exercised as a real integration boundary.
import { createApp } from '../../../proxy/src/server.js'

const strategyVersion = 'v098_主信心實際命中校準版'

function validTable(overrides: Partial<LiveTable> = {}): LiveTable {
  return {
    id: 'BAG01',
    table_id: 'BAG01',
    table_type: 'BAC',
    buildVersion: '098',
    sourceUpdatedAt: new Date().toISOString(),
    trend: {
      bead_plate2: '0102',
      big2: '0102',
      current_shoe: '123',
      current_round: 18,
    },
    prediction: {
      source: 'backend',
      strategyVersion,
      buildVersion: '098',
      targetTableId: 'BAG01',
      targetShoe: '123',
      targetRound: 19,
      predictedResult: 'banker',
      confidence: 61,
      probabilities: { banker: 61, player: 30, tie: 9 },
      sidePredictions: { tie: 11, superSix: 22, bankerPair: 33, playerPair: 44, bankerDragon: 55, playerDragon: 66 },
      sideActions: { tie: false, superSix: false, bankerPair: false, playerPair: false, bankerDragon: true, playerDragon: false },
    },
    ...overrides,
  }
}

describe('v098 live frontend contract', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('accepts only a complete current backend snapshot matching table, shoe, round and build', () => {
    expect(getBackendPredictionIssue(validTable())).toBeNull()
    expect(getBackendPredictionIssue(validTable({ buildVersion: '097' }))).toMatch(/版本/)
    expect(getBackendPredictionIssue(validTable({ sourceUpdatedAt: null }))).toMatch(/過期/)
    expect(getBackendPredictionIssue(validTable({ prediction: { ...validTable().prediction!, strategyVersion: 'v096' } }))).toMatch(/策略/)
    expect(getBackendPredictionIssue(validTable({ prediction: { ...validTable().prediction!, targetRound: 18 } }))).toMatch(/目標/)
    expect(getBackendPredictionIssue(validTable({ prediction: { ...validTable().prediction!, probabilities: undefined } }))).toMatch(/主預測/)
    expect(getBackendPredictionIssue(validTable({ prediction: {
      ...validTable().prediction!,
      sidePredictions: { ...validTable().prediction!.sidePredictions!, extra: 99 } as any,
    } }))).toMatch(/六項/)
    expect(getBackendPredictionIssue(validTable({ prediction: {
      ...validTable().prediction!,
      sideActions: { tie: false, superSix: false, bankerPair: false, playerPair: false, bankerDragon: true } as any,
    } }))).toMatch(/六項/)
  })

  it('accepts a real Proxy table payload only when targetRound is current_round plus one', async () => {
    vi.useFakeTimers()
    const app = createApp({ autoConnect: false, memberAuthRequired: false })
    app.state.setTables([{
      tableId: 'BAG01', shoe: 123, round: 18,
      tableType: 'BAC', beadPlateRaw: '0102', bigRoadRaw: '0102',
      sourceUpdatedAt: new Date().toISOString(),
    }])
    const proxyTables = JSON.parse((await app.inject({ url: '/api/tables' })).body)
    const sse = `event: tables\ndata: ${JSON.stringify({ tables: proxyTables })}\n\n`
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/api/tables/stream')) {
        return Promise.resolve({
          ok: true, status: 200,
          body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(sse)); controller.close() } }),
        })
      }
      if (url.endsWith('/api/status')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ connected: true, authenticated: true, tableCount: 1, buildVersion: '098' }) })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(proxyTables) })
    }))
    const received: LiveTable[][] = []
    const client = new LiveRoadClient({ memberSessionToken: 'member-token', onTables: (tables) => received.push(tables), onStatus: vi.fn() })

    client.connect()
    await vi.advanceTimersByTimeAsync(1)
    client.disconnect(false)

    expect(proxyTables[0].prediction.targetRound).toBe(proxyTables[0].round + 1)
    expect(getBackendPredictionIssue(received[0]?.[0])).toBeNull()
  })

  it('uses fetch SSE streaming with Authorization header for a member session', async () => {
    vi.useFakeTimers()
    const eventSource = vi.fn()
    const table = validTable()
    const proxyTable = {
      tableId: table.table_id,
      tableType: table.table_type,
      shoe: table.trend.current_shoe,
      round: table.trend.current_round,
      beadPlateRaw: table.trend.bead_plate2,
      bigRoadRaw: table.trend.big2,
      sourceUpdatedAt: table.sourceUpdatedAt,
      buildVersion: table.buildVersion,
      prediction: table.prediction,
    }
    const sse = `event: tables\ndata: ${JSON.stringify({ tables: [proxyTable] })}\n\nevent: heartbeat\ndata: {}\n\n`
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      expect(String(url)).not.toContain('opaque-member-token')
      if (!url.includes('/api/tables/stream')) throw new Error(`unexpected fallback request: ${url}`)
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer opaque-member-token')
      return Promise.resolve({
        ok: true, status: 200,
        body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(sse)); controller.close() } }),
      })
    })
    vi.stubGlobal('EventSource', eventSource)
    vi.stubGlobal('fetch', fetchMock)
    const received: LiveTable[][] = []
    const client = new LiveRoadClient({ memberSessionToken: 'opaque-member-token', onTables: (value) => received.push(value), onStatus: vi.fn() })

    client.connect()
    await vi.advanceTimersByTimeAsync(1)
    client.disconnect(false)

    expect(eventSource).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(received[0]?.[0].prediction?.targetRound).toBe(19)
  })

  it('uses Authorization for the polling fallback without token-bearing URLs', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      expect(String(url)).not.toContain('opaque-member-token')
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer opaque-member-token')
      if (url.endsWith('/api/status')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ connected: true, authenticated: true, tableCount: 1 }) })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) })
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = new LiveRoadClient({ memberSessionToken: 'opaque-member-token', onTables: vi.fn(), onStatus: vi.fn() })
    client.connect()
    await vi.advanceTimersByTimeAsync(1)
    client.disconnect(false)

    expect(fetchMock).toHaveBeenCalled()
  })

  it('immediately clears protected data and reports authorization loss on 401', async () => {
    vi.useFakeTimers()
    const tables = vi.fn()
    const unauthorized = vi.fn()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) })))

    const client = new LiveRoadClient({
      memberSessionToken: 'revoked-token',
      onTables: tables,
      onStatus: vi.fn(),
      onUnauthorized: unauthorized,
    })
    client.connect()
    await vi.advanceTimersByTimeAsync(1)
    client.disconnect(false)

    expect(tables).toHaveBeenCalledWith([])
    expect(unauthorized).toHaveBeenCalledTimes(1)
  })

  it('immediately clears protected data when an established SSE stream emits 401', async () => {
    vi.useFakeTimers()
    const tables = vi.fn()
    const unauthorized = vi.fn()
    const sse = 'event: unauthorized\ndata: {"status":401,"error":"member session is required"}\n\n'
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(sse)); controller.close() } }),
    })))

    const client = new LiveRoadClient({
      memberSessionToken: 'revoked-token',
      onTables: tables,
      onStatus: vi.fn(),
      onUnauthorized: unauthorized,
    })
    client.connect()
    await vi.advanceTimersByTimeAsync(1)
    client.disconnect(false)

    expect(tables).toHaveBeenCalledWith([])
    expect(unauthorized).toHaveBeenCalledTimes(1)
  })

  it('fails closed when backend status reports a non-098 build', async () => {
    vi.useFakeTimers()
    const tables = vi.fn()
    const statuses: Array<{ message: string }> = []
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.endsWith('/api/status')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ connected: true, authenticated: true, tableCount: 1, buildVersion: '097' }) })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([{
        tableId: 'BAG01', tableType: 'BAC', sourceUpdatedAt: new Date().toISOString(),
        beadPlateRaw: '0102', bigRoadRaw: '0102',
      }]) })
    }))

    const client = new LiveRoadClient({ memberSessionToken: 'opaque-member-token', onTables: tables, onStatus: (status) => statuses.push(status) })
    client.connect()
    await vi.advanceTimersByTimeAsync(1)
    client.disconnect(false)

    expect(tables).toHaveBeenLastCalledWith([])
    expect(statuses.at(-1)?.message).toMatch(/建置版本不符/)
  })
})
