import { afterEach, describe, expect, it, vi } from 'vitest'
import { LiveRoadClient } from './liveClient'

describe('LiveRoadClient v032 status messages', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('reports proxy running but MT not connected when status endpoint has no tables', async () => {
    vi.useFakeTimers()
    const statuses: Array<{ state: string; message: string }> = []
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.endsWith('/api/status')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ connected: false, authenticated: null, tables: [] }) })
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
      if (url.endsWith('/api/status')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ connected: true, authenticated: true, tables: [] }) })
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
    }))

    const client = new LiveRoadClient({ onTables: vi.fn(), onStatus: (status) => statuses.push(status) })
    client.connect()
    await vi.runOnlyPendingTimersAsync()
    client.disconnect(false)

    expect(statuses.some((status) => status.message === 'MT已驗證，等待桌況資料…')).toBe(true)
  })

  it('surfaces proxy v033 capture source statusText when available', async () => {
    vi.useFakeTimers()
    const statuses: Array<{ state: string; message: string }> = []
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.endsWith('/api/status')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ connected: true, statusText: 'Chrome已連接，等待MT登入驗證' }) })
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
      if (url.endsWith('/api/status')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ connected: true, authenticated: true, tableCount: 1 }) })
      return Promise.resolve({ ok: true, json: () => Promise.resolve([{
        tableId: 'BAG01', displayName: 'MT百家樂第1桌', tableType: 'BAC', shoe: 12, round: 34,
        bankerCount: 11, playerCount: 10, tieCount: 2, bankerPairCount: 3, playerPairCount: 4,
        beadPlateRaw: '0102#0201', bigRoadRaw: '0102,0201', bigEyeRaw: '1,2', smallRoadRaw: '2,1', cockroachRaw: '1,1',
        nextBankerRaw: { big: 'ask banker' }, nextPlayerRaw: { big: 'ask player' },
        dealerName: '小旻', totalPlayers: 123, roomId: '29', state: 0, orderState: 1, sourceUpdatedAt: '2026-07-05T00:00:00.000Z',
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
    expect(received[0].sourceUpdatedAt).toBe('2026-07-05T00:00:00.000Z')
  })

})
