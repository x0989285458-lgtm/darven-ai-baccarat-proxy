import { afterEach, describe, expect, it, vi } from 'vitest'
import { getBackendPredictionIssue, LiveRoadClient, type LiveTable } from './liveClient'

const strategyVersion = 'v097_副預測命中校準與門檻降5版'

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
      targetRound: 18,
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
    expect(getBackendPredictionIssue(validTable({ prediction: { ...validTable().prediction!, targetRound: 17 } }))).toMatch(/目標/)
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

  it('uses Authorization polling without EventSource or token-bearing URLs for a member session', async () => {
    vi.useFakeTimers()
    const eventSource = vi.fn()
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      expect(String(url)).not.toContain('opaque-member-token')
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer opaque-member-token')
      if (url.endsWith('/api/status')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ connected: true, authenticated: true, tableCount: 1 }) })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) })
    })
    vi.stubGlobal('EventSource', eventSource)
    vi.stubGlobal('fetch', fetchMock)

    const client = new LiveRoadClient({ memberSessionToken: 'opaque-member-token', onTables: vi.fn(), onStatus: vi.fn() })
    client.connect()
    await vi.advanceTimersByTimeAsync(1)
    client.disconnect(false)

    expect(eventSource).not.toHaveBeenCalled()
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
