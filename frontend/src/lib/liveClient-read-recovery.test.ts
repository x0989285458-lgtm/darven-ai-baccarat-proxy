import { afterEach, describe, expect, it, vi } from 'vitest'
import { LiveRoadClient } from './liveClient'

// Only the network boundary is inert; use the public lifecycle and real client.
describe('live read recovery', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('releases a hung table read and retries without a page reload', async () => {
    vi.useFakeTimers()
    let tableReads = 0
    let heldSignal: AbortSignal | undefined
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith('/stream')) return Promise.reject(new TypeError('offline stream'))
      if (url.endsWith('/status')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ connected: true, authenticated: true, tableCount: 0, buildVersion: 'v105' }) })
      tableReads++
      if (tableReads === 1) {
        heldSignal = init?.signal ?? undefined
        // Deliberately non-cooperative transport: cancellation alone is insufficient.
        return new Promise<Response>(() => {})
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => [] })
    })
    vi.stubGlobal('fetch', fetchMock)
    const statuses = vi.fn()
    const client = new LiveRoadClient({ memberSessionToken: 'test-only', onTables: vi.fn(), onStatus: statuses })
    client.connect()
    try {
      await vi.advanceTimersByTimeAsync(1)
      expect(tableReads).toBe(1)
      await vi.advanceTimersByTimeAsync(12_000)
      expect(tableReads).toBeGreaterThan(1)
      expect(heldSignal?.aborted).toBe(true)
    } finally { client.disconnect(false) }
    expect(vi.getTimerCount()).toBe(0)
  })
  it('aborts and releases a pending poll immediately on disconnect', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith('/stream')) return Promise.reject(new Error('stream unavailable'))
      signal = init?.signal ?? undefined
      return new Promise<Response>(() => {})
    }))
    const client = new LiveRoadClient({ onTables: vi.fn(), onStatus: vi.fn() })
    client.connect()
    await vi.advanceTimersByTimeAsync(1)
    expect(signal?.aborted).toBe(false)
    client.disconnect(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['status', 'body'])('bounds a hung %s phase and ignores its late completion', async (phase) => {
    vi.useFakeTimers()
    let release!: (value: any) => void
    const hung = new Promise<any>(resolve => { release = resolve })
    let reads = 0
    let statusReads = 0
    const snapshot = () => [{ tableId: 'BAV01', tableType: 'BAC', shoe: 123, round: 1, sourceUpdatedAt: new Date().toISOString(), buildVersion: 'v105', beadPlateRaw: '', bigRoadRaw: '' }]
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.endsWith('/stream')) return Promise.reject(new Error('stream unavailable'))
      if (url.endsWith('/status')) {
        statusReads++
        return Promise.resolve({ ok: true, status: 200, json: () => phase === 'status' && statusReads === 1 ? hung : Promise.resolve({ connected: true, authenticated: true, tableCount: 1, buildVersion: 'v105' }) })
      }
      reads++
      const first = reads === 1
      return Promise.resolve({ ok: true, status: 200, json: () => phase === 'body' && first ? hung : Promise.resolve(snapshot()) })
    }))
    const tables = vi.fn()
    const statuses = vi.fn()
    const client = new LiveRoadClient({ memberSessionToken: 'test-only', onTables: tables, onStatus: statuses })
    client.connect()
    try {
      await vi.advanceTimersByTimeAsync(4999)
      expect(reads).toBe(1)
      await vi.advanceTimersByTimeAsync(3001)
      expect(reads).toBeGreaterThan(1)
      expect(tables.mock.calls.at(-1)?.[0]?.[0]?.table_id).toBe('BAV01')
      const before = tables.mock.calls.length
      release(phase === 'status' ? { buildVersion: 'WRONG' } : [{ ...snapshot()[0], shoe: 999 }])
      await vi.advanceTimersByTimeAsync(0)
      expect(tables).toHaveBeenCalledTimes(before)
      expect(statuses.mock.calls.at(-1)?.[0]?.state).toBe('connected')
    } finally { client.disconnect(false) }
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not cancel a healthy slower read before the total deadline', async () => {
    vi.useFakeTimers()
    let reads = 0
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.endsWith('/stream')) return Promise.reject(new Error('stream unavailable'))
      reads++
      return new Promise(resolve => window.setTimeout(() => resolve({ ok: true, status: 200, json: async () => [{ tableId: 'BAV01', shoe: 123, round: 1, sourceUpdatedAt: new Date().toISOString() }] }), 4000))
    }))
    const tables = vi.fn()
    const client = new LiveRoadClient({ onTables: tables, onStatus: vi.fn() })
    client.connect()
    try {
      await vi.advanceTimersByTimeAsync(4001)
      expect(reads).toBe(1)
      expect(tables.mock.calls.at(-1)?.[0]?.[0]?.table_id).toBe('BAV01')
    } finally { client.disconnect(false) }
    expect(vi.getTimerCount()).toBe(0)
  })

})
