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

    const client = new LiveRoadClient({ token: 'expired-token', onTables: vi.fn(), onStatus: (status) => statuses.push(status) })
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

    const client = new LiveRoadClient({ token: 'valid-token', onTables: vi.fn(), onStatus: (status) => statuses.push(status) })
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

    const client = new LiveRoadClient({ token: 'chrome-mode', onTables: vi.fn(), onStatus: (status) => statuses.push(status) })
    client.connect()
    await vi.runOnlyPendingTimersAsync()
    client.disconnect(false)

    expect(statuses.some((status) => status.message === 'Chrome已連接，等待MT登入驗證')).toBe(true)
  })
})
