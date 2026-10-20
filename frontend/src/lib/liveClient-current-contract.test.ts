import { afterEach, describe, expect, it, vi } from 'vitest'
import { getBackendPredictionIssue, LiveRoadClient, type LiveTable } from './liveClient'
// @ts-expect-error Proxy is JavaScript and intentionally exercised as a real integration boundary.
import { createApp } from '../../../proxy/src/server.js'

const strategyVersion = 'v105'

function validTable(overrides: Partial<LiveTable> = {}): LiveTable {
  return {
    id: 'BAG01',
    table_id: 'BAG01',
    table_type: 'BAC',
    buildVersion: 'v105',
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
      buildVersion: 'v105',
      targetTableId: 'BAG01',
      targetShoe: '123',
      targetRound: 18,
      predictionId: 'pid-round-18',
      issuedAt: '2026-07-17T01:00:00.000Z',
      predictedResult: 'banker',
      confidence: 61,
      probabilities: { banker: 61, player: 30, tie: 9 },
      sidePredictions: { tie: 11, superSix: 22, bankerPair: 33, playerPair: 44, bankerDragon: 55, playerDragon: 66 },
      sideActions: { tie: false, superSix: false, bankerPair: false, playerPair: false, bankerDragon: true, playerDragon: false },
    },
    ...overrides,
  }
}

describe('live frontend contract', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('accepts only a complete current backend snapshot matching table, shoe, round and build', () => {
    expect(getBackendPredictionIssue(validTable())).toBeNull()
    expect(getBackendPredictionIssue(validTable({ buildVersion: '097' }))).toMatch(/版本/)
    expect(getBackendPredictionIssue(validTable({ buildVersion: undefined }))).toMatch(/版本/)
    expect(getBackendPredictionIssue(validTable({ prediction: { ...validTable().prediction!, buildVersion: 'v104' } }))).toMatch(/版本/)
    expect(getBackendPredictionIssue(validTable({ prediction: { ...validTable().prediction!, buildVersion: undefined } }))).toMatch(/版本/)
    expect(getBackendPredictionIssue(validTable({ sourceUpdatedAt: null }))).toMatch(/過期/)
    expect(getBackendPredictionIssue(validTable({ prediction: { ...validTable().prediction!, strategyVersion: 'v096' } }))).toMatch(/策略/)
    expect(getBackendPredictionIssue(validTable({ prediction: { ...validTable().prediction!, targetRound: 19 } }))).toMatch(/目標/)
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

  it('accepts a real Proxy table payload only when targetRound is the exact visible current_round', async () => {
    vi.useFakeTimers()
    const exact = validTable().prediction!
    const app = createApp({
      autoConnect: false,
      memberAuthRequired: false,
      supabaseClient: {
        configured: true,
        issuePrediction: async (candidate: any) => ({ ...candidate, predictionId: `pid-${candidate.targetRound}`, issuedAt: '2026-07-17T01:00:00.000Z' }),
        readIssuedPrediction: async () => exact,
      },
    })
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
      if (url.endsWith('/api/status')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ connected: true, authenticated: true, tableCount: 1, buildVersion: 'v105' }) })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(proxyTables) })
    }))
    const received: LiveTable[][] = []
    const client = new LiveRoadClient({ memberSessionToken: 'member-token', onTables: (tables) => received.push(tables), onStatus: vi.fn() })

    client.connect()
    await vi.advanceTimersByTimeAsync(1)
    client.disconnect(false)

    expect(proxyTables[0].prediction.targetRound).toBe(proxyTables[0].round)
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
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer opaque-member-token')
      if (url.includes('/api/tables/stream')) {
        return Promise.resolve({
          ok: true, status: 200,
          body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(sse)); controller.close() } }),
        })
      }
      if (url.endsWith('/api/status')) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ connected: true, authenticated: true, tableCount: 1, buildVersion: 'v105' }) })
      }
      if (url.endsWith('/api/tables')) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([proxyTable]) })
      }
      throw new Error(`unexpected heartbeat refresh request: ${url}`)
    })
    vi.stubGlobal('EventSource', eventSource)
    vi.stubGlobal('fetch', fetchMock)
    const received: LiveTable[][] = []
    const client = new LiveRoadClient({ memberSessionToken: 'opaque-member-token', onTables: (value) => received.push(value), onStatus: vi.fn() })

    client.connect()
    await vi.advanceTimersByTimeAsync(1)
    client.disconnect(false)

    expect(eventSource).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(received[0]?.[0].prediction?.targetRound).toBe(18)
  })

  it('atomically enriches exact prediction and table build version for the same visible screen', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-30T10:40:30.000Z'))
    const received: LiveTable[][] = []
    const client = new LiveRoadClient({ onTables: (tables) => received.push(tables), onStatus: vi.fn() })
    const screenOnly = validTable({
      sourceUpdatedAt: '2026-08-30T10:40:29.000Z',
      buildVersion: null,
      prediction: undefined,
    })
    const exact = validTable({ sourceUpdatedAt: screenOnly.sourceUpdatedAt })

    ;(client as any).publishTables([screenOnly], 'screen')
    ;(client as any).publishTables([exact], 'exact')

    const accepted = received.at(-1)?.[0]
    expect(accepted?.buildVersion).toBe('v105')
    expect(accepted?.prediction?.predictionId).toBe(exact.prediction?.predictionId)
    expect(getBackendPredictionIssue(accepted)).toBeNull()
  })

  it('self-heals a missing current-round prediction from public tables without waiting for an SSE heartbeat', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-30T10:40:30.000Z'))
    const initial = validTable({ sourceUpdatedAt: '2026-08-30T10:40:29.000Z', prediction: undefined })
    const exact = validTable({
      sourceUpdatedAt: '2026-08-30T10:40:29.000Z',
      prediction: { ...validTable().prediction!, predictionId: 'bounded-self-heal' },
    })
    const toProxy = (item: LiveTable) => ({
      tableId: item.table_id,
      tableType: item.table_type,
      shoe: item.trend.current_shoe,
      round: item.trend.current_round,
      beadPlateRaw: item.trend.bead_plate2,
      bigRoadRaw: item.trend.big2,
      sourceUpdatedAt: item.sourceUpdatedAt,
      buildVersion: item.buildVersion,
      prediction: item.prediction,
    })
    let tableReads = 0
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/api/tables/stream')) {
        const sse = `event: tables\ndata: ${JSON.stringify({ tables: [toProxy(initial)] })}\n\n`
        return Promise.resolve({ ok: true, status: 200, body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(sse)) } }) })
      }
      if (url.endsWith('/api/status')) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ connected: true, authenticated: true, tableCount: 1, buildVersion: 'v105' }) })
      }
      if (url.endsWith('/api/tables')) {
        tableReads += 1
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([toProxy(exact)]) })
      }
      throw new Error(`unexpected request: ${url}`)
    }))
    const received: LiveTable[][] = []
    const client = new LiveRoadClient({ memberSessionToken: 'opaque-member-token', onTables: (tables) => received.push(tables), onStatus: vi.fn() })

    client.connect()
    await vi.advanceTimersByTimeAsync(749)
    expect(tableReads).toBe(0)
    await vi.advanceTimersByTimeAsync(2)
    client.disconnect(false)

    expect(tableReads).toBe(1)
    expect(received.at(-1)?.[0]?.prediction?.predictionId).toBe('bounded-self-heal')
  })

  it('cancels a queued self-heal poll when exact prediction arrives before the timer', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-30T10:40:30.000Z'))
    const client = new LiveRoadClient({ onTables: vi.fn(), onStatus: vi.fn() })
    const initial = validTable({ sourceUpdatedAt: '2026-08-30T10:40:29.000Z', prediction: undefined })
    const exact = validTable({ sourceUpdatedAt: initial.sourceUpdatedAt })
    ;(client as any).stopped = false
    const poll = vi.spyOn(client as any, 'poll').mockResolvedValue(undefined)

    ;(client as any).publishTables([initial], 'missing')
    ;(client as any).publishTables([exact], 'exact')
    await vi.advanceTimersByTimeAsync(751)
    client.disconnect(false)

    expect(poll).not.toHaveBeenCalled()
  })

  it('caps missing-prediction self-heal attempts per table, shoe and round', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-30T10:40:30.000Z'))
    const client = new LiveRoadClient({ onTables: vi.fn(), onStatus: vi.fn() })
    const table = validTable({ sourceUpdatedAt: '2026-08-30T10:40:29.000Z', prediction: undefined })
    ;(client as any).stopped = false
    ;(client as any).acceptedTableById.set('BAG01', table)
    const poll = vi.spyOn(client as any, 'poll').mockResolvedValue(undefined)

    for (let attempt = 0; attempt < 25; attempt += 1) {
      ;(client as any).scheduleMissingPredictionRefresh()
      await vi.advanceTimersByTimeAsync(751)
    }
    client.disconnect(false)

    expect(poll).toHaveBeenCalledTimes(20)
  })

  it('refreshes durable public tables on heartbeat so a cross-process DB update is not delayed until stream timeout', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-27T16:00:30.000Z'))
    const initial = validTable({ sourceUpdatedAt: '2026-08-27T16:00:00.000Z' })
    const advanced = validTable({
      sourceUpdatedAt: '2026-08-27T16:00:01.000Z',
      trend: { ...initial.trend, current_round: Number(initial.trend.current_round) + 1 },
      prediction: { ...initial.prediction!, targetRound: Number(initial.trend.current_round) + 1, predictionId: 'cross-process-ready' },
    })
    const toProxy = (item: LiveTable) => ({
      tableId: item.table_id,
      tableType: item.table_type,
      shoe: item.trend.current_shoe,
      round: item.trend.current_round,
      beadPlateRaw: item.trend.bead_plate2,
      bigRoadRaw: item.trend.big2,
      sourceUpdatedAt: item.sourceUpdatedAt,
      buildVersion: item.buildVersion,
      prediction: item.prediction,
    })
    const sse = `event: tables\ndata: ${JSON.stringify({ tables: [toProxy(initial)] })}\n\nevent: heartbeat\ndata: {}\n\n`
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes('/api/tables/stream')) {
        expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer opaque-member-token')
        return Promise.resolve({
          ok: true,
          status: 200,
          body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(sse)) } }),
        })
      }
      if (url.endsWith('/api/status')) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ connected: true, authenticated: true, tableCount: 1, buildVersion: 'v105' }) })
      }
      if (url.endsWith('/api/tables')) {
        expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer opaque-member-token')
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([toProxy(advanced)]) })
      }
      throw new Error(`unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const received: LiveTable[][] = []
    const client = new LiveRoadClient({ memberSessionToken: 'opaque-member-token', onTables: (tables) => received.push(tables), onStatus: vi.fn() })

    client.connect()
    await vi.advanceTimersByTimeAsync(1)
    client.disconnect(false)

    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/api/tables'))).toBe(true)
    expect(received.at(-1)?.[0].trend.current_round).toBe(advanced.trend.current_round)
    expect(received.at(-1)?.[0].prediction?.predictionId).toBe('cross-process-ready')
  })

  it('coalesces repeated heartbeats while the durable public table refresh is still in flight', async () => {
    vi.useFakeTimers()
    let tableReads = 0
    let releaseTableRead!: () => void
    const tableGate = new Promise<void>((resolve) => { releaseTableRead = resolve })
    const heartbeats = 'event: heartbeat\ndata: {}\n\n'.repeat(3)
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/api/tables/stream')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(heartbeats)) } }),
        })
      }
      if (url.endsWith('/api/status')) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ connected: true, authenticated: true, tableCount: 0, buildVersion: 'v105' }) })
      }
      if (url.endsWith('/api/tables')) {
        tableReads += 1
        return tableGate.then(() => ({ ok: true, status: 200, json: () => Promise.resolve([]) }))
      }
      throw new Error(`unexpected request: ${url}`)
    }))
    const client = new LiveRoadClient({ memberSessionToken: 'opaque-member-token', onTables: vi.fn(), onStatus: vi.fn() })

    client.connect()
    await vi.advanceTimersByTimeAsync(1)
    expect(tableReads).toBe(1)
    releaseTableRead()
    await vi.advanceTimersByTimeAsync(1)
    client.disconnect(false)
  })

  it('does not reuse or publish an in-flight heartbeat refresh across a disconnect and reconnect generation', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-27T16:00:30.000Z'))
    let tableReads = 0
    let releaseOldRead!: () => void
    const oldReadGate = new Promise<void>((resolve) => { releaseOldRead = resolve })
    const advanced = validTable({
      sourceUpdatedAt: '2026-08-27T16:00:02.000Z',
      trend: { ...validTable().trend, current_round: 19 },
      prediction: { ...validTable().prediction!, targetRound: 19, predictionId: 'new-generation-ready' },
    })
    const toProxy = (item: LiveTable) => ({
      tableId: item.table_id,
      tableType: item.table_type,
      shoe: item.trend.current_shoe,
      round: item.trend.current_round,
      beadPlateRaw: item.trend.bead_plate2,
      bigRoadRaw: item.trend.big2,
      sourceUpdatedAt: item.sourceUpdatedAt,
      buildVersion: item.buildVersion,
      prediction: item.prediction,
    })
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/api/tables/stream')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('event: heartbeat\ndata: {}\n\n')) } }),
        })
      }
      if (url.endsWith('/api/status')) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ connected: true, authenticated: true, tableCount: 1, buildVersion: 'v105' }) })
      }
      if (url.endsWith('/api/tables')) {
        tableReads += 1
        if (tableReads === 1) return oldReadGate.then(() => ({ ok: false, status: 401, json: () => Promise.resolve({}) }))
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([toProxy(advanced)]) })
      }
      throw new Error(`unexpected request: ${url}`)
    }))
    const received: LiveTable[][] = []
    const unauthorized = vi.fn()
    const client = new LiveRoadClient({
      memberSessionToken: 'opaque-member-token',
      onTables: (tables) => received.push(tables),
      onStatus: vi.fn(),
      onUnauthorized: unauthorized,
    })

    client.connect()
    await vi.advanceTimersByTimeAsync(1)
    client.disconnect(false)
    client.connect()
    await vi.advanceTimersByTimeAsync(1)
    expect(tableReads).toBe(2)
    expect(received.at(-1)?.[0].prediction?.predictionId).toBe('new-generation-ready')
    releaseOldRead()
    await vi.advanceTimersByTimeAsync(1)
    client.disconnect(false)

    expect(unauthorized).not.toHaveBeenCalled()
    expect(received.at(-1)?.[0].prediction?.predictionId).toBe('new-generation-ready')
  })

  it('recovers the same durable snapshot after a transient heartbeat refresh failure clears the screen', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-27T16:00:30.000Z'))
    let streamController!: ReadableStreamDefaultController<Uint8Array>
    let tableReads = 0
    const table = validTable({ sourceUpdatedAt: '2026-08-27T16:00:00.000Z' })
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
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/api/tables/stream')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          body: new ReadableStream({ start(controller) {
            streamController = controller
            controller.enqueue(new TextEncoder().encode(`event: tables\ndata: ${JSON.stringify({ tables: [proxyTable] })}\n\n`))
          } }),
        })
      }
      if (url.endsWith('/api/status')) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ connected: true, authenticated: true, tableCount: 1, buildVersion: 'v105' }) })
      }
      if (url.endsWith('/api/tables')) {
        tableReads += 1
        if (tableReads === 1) return Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) })
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([proxyTable]) })
      }
      throw new Error(`unexpected request: ${url}`)
    }))
    const received: LiveTable[][] = []
    const client = new LiveRoadClient({ memberSessionToken: 'opaque-member-token', onTables: (tables) => received.push(tables), onStatus: vi.fn() })

    client.connect()
    await vi.advanceTimersByTimeAsync(1)
    streamController.enqueue(new TextEncoder().encode('event: heartbeat\ndata: {}\n\n'))
    await vi.advanceTimersByTimeAsync(1)
    expect(received.at(-1)).toEqual([])
    streamController.enqueue(new TextEncoder().encode('event: heartbeat\ndata: {}\n\n'))
    await vi.advanceTimersByTimeAsync(1)
    client.disconnect(false)

    expect(tableReads).toBe(2)
    expect(received.at(-1)?.[0]?.prediction?.predictionId).toBe(table.prediction?.predictionId)
  })

  it('accepts a numerically newer shoe and round with exact prediction while preserving the source timestamp high-water mark', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-30T09:40:30.000Z'))
    const received: LiveTable[][] = []
    const client = new LiveRoadClient({ onTables: (tables) => received.push(tables), onStatus: vi.fn() })
    const oldShoe = validTable({
      sourceUpdatedAt: '2026-08-30T09:40:02.000Z',
      trend: { ...validTable().trend, current_shoe: '123', current_round: 60 },
      prediction: undefined,
    })
    const newShoe = validTable({
      sourceUpdatedAt: '2026-08-30T09:40:01.000Z',
      trend: { ...validTable().trend, current_shoe: '124', current_round: 2 },
      prediction: {
        ...validTable().prediction!,
        targetShoe: '124',
        targetRound: 2,
        predictionId: 'new-shoe-durable-ready',
      },
    })

    ;(client as any).publishTables([oldShoe], 'old shoe')
    ;(client as any).publishTables([newShoe], 'new shoe')

    const accepted = received.at(-1)?.[0]
    expect(accepted?.trend.current_shoe).toBe('124')
    expect(accepted?.trend.current_round).toBe(2)
    expect(accepted?.prediction?.predictionId).toBe('new-shoe-durable-ready')
    expect(accepted?.sourceUpdatedAt).toBe(oldShoe.sourceUpdatedAt)
  })

  it('accepts exact durable prediction enrichment from an older same-screen snapshot without rolling back screen time', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-30T09:40:30.000Z'))
    const screenOnly = validTable({ sourceUpdatedAt: '2026-08-30T09:40:02.000Z', prediction: undefined })
    const durableLate = validTable({
      sourceUpdatedAt: '2026-08-30T09:40:01.000Z',
      prediction: { ...validTable().prediction!, predictionId: 'durable-late-same-screen' },
    })
    const toProxy = (table: LiveTable) => ({
      tableId: table.table_id,
      tableType: table.table_type,
      shoe: table.trend.current_shoe,
      round: table.trend.current_round,
      beadPlateRaw: table.trend.bead_plate2,
      bigRoadRaw: table.trend.big2,
      sourceUpdatedAt: table.sourceUpdatedAt,
      buildVersion: table.buildVersion,
      prediction: table.prediction,
    })
    const events = [screenOnly, durableLate]
      .map((table) => `event: tables\ndata: ${JSON.stringify({ tables: [toProxy(table)] })}\n\n`)
      .join('')
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(events)); controller.close() } }),
    })))
    const received: LiveTable[][] = []
    const client = new LiveRoadClient({ onTables: (tables) => received.push(tables), onStatus: vi.fn() })

    client.connect()
    await vi.advanceTimersByTimeAsync(1)
    client.disconnect(false)

    expect(received.at(-1)?.[0]?.prediction?.predictionId).toBe('durable-late-same-screen')
    expect(received.at(-1)?.[0]?.sourceUpdatedAt).toBe(screenOnly.sourceUpdatedAt)
  })

  it('keeps the source timestamp high-water mark when recovery returns an older but still fresh snapshot', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-27T16:00:30.000Z'))
    let streamController!: ReadableStreamDefaultController<Uint8Array>
    let tableReads = 0
    const newer = validTable({
      sourceUpdatedAt: '2026-08-27T16:00:02.000Z',
      prediction: { ...validTable().prediction!, predictionId: 'newer-durable' },
    })
    const older = validTable({
      sourceUpdatedAt: '2026-08-27T16:00:01.000Z',
      prediction: { ...validTable().prediction!, predictionId: 'older-replay' },
    })
    const toProxy = (table: LiveTable) => ({
      tableId: table.table_id,
      tableType: table.table_type,
      shoe: table.trend.current_shoe,
      round: table.trend.current_round,
      beadPlateRaw: table.trend.bead_plate2,
      bigRoadRaw: table.trend.big2,
      sourceUpdatedAt: table.sourceUpdatedAt,
      buildVersion: table.buildVersion,
      prediction: table.prediction,
    })
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/api/tables/stream')) {
        return Promise.resolve({ ok: true, status: 200, body: new ReadableStream({ start(controller) {
          streamController = controller
          controller.enqueue(new TextEncoder().encode(`event: tables\ndata: ${JSON.stringify({ tables: [toProxy(newer)] })}\n\n`))
        } }) })
      }
      if (url.endsWith('/api/status')) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ connected: true, authenticated: true, tableCount: 1, buildVersion: 'v105' }) })
      }
      if (url.endsWith('/api/tables')) {
        tableReads += 1
        if (tableReads === 1) return Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) })
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([toProxy(older)]) })
      }
      throw new Error(`unexpected request: ${url}`)
    }))
    const received: LiveTable[][] = []
    const client = new LiveRoadClient({ memberSessionToken: 'opaque-member-token', onTables: (tables) => received.push(tables), onStatus: vi.fn() })

    client.connect()
    await vi.advanceTimersByTimeAsync(1)
    streamController.enqueue(new TextEncoder().encode('event: heartbeat\ndata: {}\n\n'))
    await vi.advanceTimersByTimeAsync(1)
    expect(received.at(-1)).toEqual([])
    streamController.enqueue(new TextEncoder().encode('event: heartbeat\ndata: {}\n\n'))
    await vi.advanceTimersByTimeAsync(1)
    client.disconnect(false)

    expect(received.at(-1)?.[0]?.prediction?.predictionId).toBe('newer-durable')
    expect(received.at(-1)?.[0]?.sourceUpdatedAt).toBe(newer.sourceUpdatedAt)
  })

  it('rejects per-table sourceUpdatedAt rollback from SSE while keeping other tables and allows a newer shoe', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-16T02:00:30.000Z'))
    const newer = validTable({ sourceUpdatedAt: '2026-07-16T02:00:00.000Z' })
    const older = validTable({ sourceUpdatedAt: '2026-07-16T01:59:00.000Z' })
    const other = validTable({ id: 'BAG02', table_id: 'BAG02', sourceUpdatedAt: '2026-07-16T01:59:30.000Z', prediction: { ...validTable().prediction!, targetTableId: 'BAG02' } })
    const nextShoe = validTable({ sourceUpdatedAt: '2026-07-16T02:01:00.000Z', trend: { ...validTable().trend, current_shoe: '124', current_round: 1 }, prediction: { ...validTable().prediction!, targetShoe: '124', targetRound: 2 } })
    const toProxy = (item: LiveTable) => ({ tableId: item.table_id, tableType: item.table_type, shoe: item.trend.current_shoe, round: item.trend.current_round, beadPlateRaw: item.trend.bead_plate2, bigRoadRaw: item.trend.big2, sourceUpdatedAt: item.sourceUpdatedAt, buildVersion: item.buildVersion, prediction: item.prediction })
    const events = [newer, older, other, nextShoe].map((item) => `event: tables\ndata: ${JSON.stringify({ tables: [toProxy(item)] })}\n\n`).join('')
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 200, body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(events)); controller.close() } }) })))
    const received: LiveTable[][] = []
    const client = new LiveRoadClient({ onTables: (tables) => received.push(tables), onStatus: vi.fn() })
    client.connect()
    await vi.advanceTimersByTimeAsync(1)
    client.disconnect(false)
    expect(received).toHaveLength(3)
    expect(received[0].map((item) => item.table_id)).toEqual(['BAG01'])
    expect(received[1].map((item) => item.table_id)).toEqual(['BAG01', 'BAG02'])
    expect(received[2].map((item) => item.table_id)).toEqual(['BAG01', 'BAG02'])
    expect(received.at(-1)?.find((item) => item.table_id === 'BAG01')?.trend.current_shoe).toBe('124')
  })

  it('keeps the timestamp high-water after an all-stale payload and rejects an older fresh replay', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-27T16:00:30.000Z'))
    const received: LiveTable[][] = []
    const client = new LiveRoadClient({ onTables: (tables) => received.push(tables), onStatus: vi.fn() })
    const newest = validTable({
      sourceUpdatedAt: '2026-08-27T16:00:29.000Z',
      prediction: { ...validTable().prediction!, predictionId: 'newest-accepted' },
    })
    const stale = validTable({
      sourceUpdatedAt: '2026-08-27T15:55:00.000Z',
      prediction: { ...validTable().prediction!, predictionId: 'stale-payload' },
    })
    const olderFreshReplay = validTable({
      sourceUpdatedAt: '2026-08-27T16:00:28.000Z',
      prediction: { ...validTable().prediction!, predictionId: 'older-fresh-replay' },
    })
    const advanced = validTable({
      sourceUpdatedAt: '2026-08-27T16:00:30.000Z',
      prediction: { ...validTable().prediction!, predictionId: 'advanced-after-stale' },
    })

    ;(client as any).publishTables([newest], 'newest')
    ;(client as any).publishTables([stale], 'all stale')
    ;(client as any).publishTables([olderFreshReplay], 'older replay')

    expect(received).toHaveLength(2)
    expect(received[0][0].prediction?.predictionId).toBe('newest-accepted')
    expect(received[1]).toEqual([])

    ;(client as any).publishTables([advanced], 'advanced')
    expect(received.at(-1)?.[0]?.prediction?.predictionId).toBe('advanced-after-stale')
  })

  it('rejects polling rollback but a reconstructed client accepts its own first payload', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-16T02:00:30.000Z'))
    const proxy = (stamp: string) => ({ tableId: 'BAG01', tableType: 'BAC', shoe: 123, round: 18, beadPlateRaw: '0102', bigRoadRaw: '0102', sourceUpdatedAt: stamp, buildVersion: 'v105', prediction: validTable().prediction })
    let streamCall = 0
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('/stream')) {
        streamCall += 1
        const body = streamCall === 1 ? `event: tables\ndata: ${JSON.stringify({ tables: [proxy('2026-07-16T02:00:00.000Z')] })}\n\n` : `event: tables\ndata: ${JSON.stringify({ tables: [proxy('2026-07-16T01:59:00.000Z')] })}\n\n`
        return Promise.resolve({ ok: true, status: 200, body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(body)); controller.close() } }) })
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([proxy('2026-07-16T01:59:00.000Z')]) })
    })
    vi.stubGlobal('fetch', fetchMock)
    const firstReceived: LiveTable[][] = []
    const first = new LiveRoadClient({ onTables: (tables) => firstReceived.push(tables), onStatus: vi.fn() })
    first.connect()
    await vi.advanceTimersByTimeAsync(1)
    first.disconnect(false)
    expect(firstReceived).toHaveLength(1)
    const rebuiltReceived: LiveTable[][] = []
    const rebuilt = new LiveRoadClient({ onTables: (tables) => rebuiltReceived.push(tables), onStatus: vi.fn() })
    rebuilt.connect()
    await vi.advanceTimersByTimeAsync(1)
    rebuilt.disconnect(false)
    expect(rebuiltReceived).toHaveLength(1)
  })

  it('retains the accepted table when only that table regresses inside a mixed response', () => {
    const received: LiveTable[][] = []
    const client = new LiveRoadClient({ onTables: (tables) => received.push(tables), onStatus: vi.fn() })
    const firstA = validTable({ sourceUpdatedAt: new Date(Date.now() - 1_000).toISOString() })
    const firstB = validTable({ id: 'BAG02', table_id: 'BAG02', sourceUpdatedAt: new Date(Date.now() - 1_000).toISOString() })
    const olderA = { ...firstA, sourceUpdatedAt: new Date(Date.now() - 2_000).toISOString() }
    const newerB = { ...firstB, sourceUpdatedAt: new Date().toISOString() }
    ;(client as any).publishTables([firstA, firstB], 'first')
    ;(client as any).publishTables([olderA, newerB], 'mixed')
    expect(received[1]).toHaveLength(2)
    expect(received[1].find((item) => item.table_id === 'BAG01')?.sourceUpdatedAt).toBe(firstA.sourceUpdatedAt)
    expect(received[1].find((item) => item.table_id === 'BAG02')?.sourceUpdatedAt).toBe(newerB.sourceUpdatedAt)
  })

  it('requires durable prediction identity and fails old tabs closed', () => {
    const modern = validTable()
    expect(getBackendPredictionIssue(modern)).toBeNull()
    expect(getBackendPredictionIssue({ ...modern, prediction: { ...modern.prediction!, predictionId: undefined } })).toMatch(/識別/)
    expect(getBackendPredictionIssue({ ...modern, prediction: { ...modern.prediction!, issuedAt: undefined } })).toMatch(/識別/)
    expect(getBackendPredictionIssue({ ...modern, buildVersion: '098.22', prediction: { ...modern.prediction!, buildVersion: '098.22' } })).toMatch(/版本/)
  })

  it('uses Authorization for the polling fallback without token-bearing URLs', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      expect(String(url)).not.toContain('opaque-member-token')
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer opaque-member-token')
      if (url.endsWith('/api/status')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ connected: true, authenticated: true, tableCount: 1, buildVersion: 'v105' }) })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) })
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = new LiveRoadClient({ memberSessionToken: 'opaque-member-token', onTables: vi.fn(), onStatus: vi.fn() })
    client.connect()
    await vi.advanceTimersByTimeAsync(1)
    client.disconnect(false)

    expect(fetchMock).toHaveBeenCalled()
  })

  it('treats an authenticated status 401 as authorization loss even when tables returns 200', async () => {
    vi.useFakeTimers()
    const table = validTable({ sourceUpdatedAt: new Date().toISOString() })
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
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/api/tables/stream')) {
        return Promise.resolve({ ok: true, status: 200, body: new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode(sse))
          controller.close()
        } }) })
      }
      if (url.endsWith('/api/status')) return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) })
      if (url.endsWith('/api/tables')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([proxyTable]) })
      throw new Error(`unexpected request: ${url}`)
    }))
    const received: LiveTable[][] = []
    const unauthorized = vi.fn()
    const client = new LiveRoadClient({
      memberSessionToken: 'opaque-member-token',
      onTables: (tables) => received.push(tables),
      onStatus: vi.fn(),
      onUnauthorized: unauthorized,
    })

    client.connect()
    await vi.advanceTimersByTimeAsync(1)
    client.disconnect(false)

    expect(received[0]?.[0]?.prediction?.predictionId).toBe(table.prediction?.predictionId)
    expect(received.at(-1)).toEqual([])
    expect(unauthorized).toHaveBeenCalledTimes(1)
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

  it('merges partial table payloads, ignores one stale table, and preserves accepted order', () => {
    const received: LiveTable[][] = []
    const client = new LiveRoadClient({ onTables: (tables) => received.push(tables), onStatus: vi.fn() })
    const stamp = new Date(Date.now() - 1_000).toISOString()
    const a = validTable({ id: 'BAG01', table_id: 'BAG01', sourceUpdatedAt: stamp })
    const b = validTable({ id: 'BAG02', table_id: 'BAG02', sourceUpdatedAt: stamp, prediction: { ...validTable().prediction!, targetTableId: 'BAG02' } })
    const c = validTable({ id: 'BAG03', table_id: 'BAG03', sourceUpdatedAt: stamp, prediction: { ...validTable().prediction!, targetTableId: 'BAG03' } })
    ;(client as any).publishTables([a, b, c], 'all')
    ;(client as any).publishTables([{ ...b, sourceUpdatedAt: new Date(Date.now() - 500).toISOString() }], 'partial')
    ;(client as any).publishTables([{ ...a, sourceUpdatedAt: new Date(Date.now() - 300_000).toISOString() }, { ...c, sourceUpdatedAt: new Date().toISOString() }], 'mixed')
    expect(received[1].map((item) => item.table_id)).toEqual(['BAG01', 'BAG02', 'BAG03'])
    expect(received[2].map((item) => item.table_id)).toEqual(['BAG02', 'BAG03'])
    expect(received[2].find((item) => item.table_id === 'BAG01')).toBeUndefined()
  })

  it('equal timestamp cannot replace durable prediction, while higher round may advance', () => {
    const received: LiveTable[][] = []
    const client = new LiveRoadClient({ onTables: (tables) => received.push(tables), onStatus: vi.fn() })
    const stamp = new Date(Date.now() - 1_000).toISOString()
    const durable = validTable({ sourceUpdatedAt: stamp, prediction: { ...validTable().prediction!, predictionId: 'pid-accepted', issuedAt: stamp } })
    ;(client as any).publishTables([durable], 'issued')
    ;(client as any).publishTables([{ ...durable, prediction: null }], 'null replay')
    ;(client as any).publishTables([{ ...durable, prediction: { ...durable.prediction!, predictionId: 'pid-other' } }], 'different replay')
    const other = validTable({ id: 'BAG02', table_id: 'BAG02', sourceUpdatedAt: stamp, prediction: { ...validTable().prediction!, targetTableId: 'BAG02' } })
    ;(client as any).publishTables([other], 'partial trigger')
    const advancedRound = Number(durable.trend.current_round) + 1
    const advanced = { ...durable, trend: { ...durable.trend, current_round: advancedRound }, prediction: null }
    ;(client as any).publishTables([advanced], 'advanced')
    expect(received).toHaveLength(3)
    expect(received[1].find((item) => item.table_id === 'BAG01')?.prediction?.predictionId).toBe('pid-accepted')
    expect(received[2].find((item) => item.table_id === 'BAG01')?.trend.current_round).toBe(advancedRound)
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

  it('fails closed when backend status omits the v100 build identity', async () => {
    vi.useFakeTimers()
    const tables = vi.fn()
    const statuses: Array<{ message: string }> = []
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.endsWith('/api/status')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ connected: true, authenticated: true, tableCount: 1 }) })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([validTable()]) })
    }))

    const client = new LiveRoadClient({ memberSessionToken: 'opaque-member-token', onTables: tables, onStatus: (status) => statuses.push(status) })
    client.connect()
    await vi.advanceTimersByTimeAsync(1)
    client.disconnect(false)

    expect(tables).toHaveBeenLastCalledWith([])
    expect(statuses.at(-1)?.message).toMatch(/建置版本不符/)
  })
})
