import { afterEach, expect, it, vi } from 'vitest'
import { LiveRoadClient } from './liveClient'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

function fixture() {
  vi.useFakeTimers()
  const streams: { controller: ReadableStreamDefaultController<Uint8Array>; signal: AbortSignal }[] = []
  const onTables = vi.fn()
  const onUnauthorized = vi.fn()
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith('/stream')) {
      const body = new ReadableStream<Uint8Array>({ start(controller) { streams.push({ controller, signal: init!.signal! }) } })
      return Promise.resolve({ ok: true, status: 200, body })
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => url.endsWith('/status')
      ? { connected: true, authenticated: true, tableCount: 1, buildVersion: 'v105' }
      : [{ tableId: 'BAV01', shoe: 1, round: 1, sourceUpdatedAt: new Date().toISOString() }] })
  })
  vi.stubGlobal('fetch', fetchMock)
  const client = new LiveRoadClient({ onTables, onStatus: vi.fn(), onUnauthorized })
  const emit = (index: number, event: string, data: unknown) => streams[index].controller.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
  client.connect()
  return { client, streams, emit, fetchMock, onTables, onUnauthorized }
}

it.each(['tables', 'unauthorized', 'heartbeat', 'eof'])('ignores old-generation %s after reconnect', async event => {
  const f = fixture()
  try {
    await vi.advanceTimersByTimeAsync(0)
    f.client.connect()
    await vi.advanceTimersByTimeAsync(0)
    const calls = f.fetchMock.mock.calls.length
    if (event === 'eof') f.streams[0].controller.close()
    else f.emit(0, event, { tables: [{ tableId: 'BAV01', shoe: 999, round: 1, sourceUpdatedAt: new Date().toISOString() }] })
    await vi.advanceTimersByTimeAsync(2001)
    expect(f.onTables).not.toHaveBeenCalled()
    expect(f.onUnauthorized).not.toHaveBeenCalled()
    expect(f.fetchMock).toHaveBeenCalledTimes(calls)
  } finally { f.client.disconnect(false) }
  expect(vi.getTimerCount()).toBe(0)
})

it.each(['online', 'pageshow', 'visibilitychange'])('recovers promptly on %s and removes listeners on disconnect', async event => {
  const f = fixture()
  const target = event === 'visibilitychange' ? document : window
  try {
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1000)
    target.dispatchEvent(new Event(event))
    target.dispatchEvent(new Event(event))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.streams.length).toBe(2)
    expect(f.streams[0].signal.aborted).toBe(true)
    expect(f.onTables.mock.calls.at(-1)?.[0]?.[0]?.table_id).toBe('BAV01')
    const calls = f.fetchMock.mock.calls.length
    f.client.disconnect(false)
    target.dispatchEvent(new Event(event))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.fetchMock).toHaveBeenCalledTimes(calls)
  } finally { f.client.disconnect(false) }
  expect(vi.getTimerCount()).toBe(0)
})

it('stays fail-closed after stream unauthorized even across recovery events', async () => {
  const f = fixture()
  try {
    await vi.advanceTimersByTimeAsync(0)
    f.emit(0, 'unauthorized', {})
    await vi.advanceTimersByTimeAsync(0)
    const calls = f.fetchMock.mock.calls.length
    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(20000)
    expect(f.fetchMock).toHaveBeenCalledTimes(calls)
    expect(f.onUnauthorized).toHaveBeenCalledTimes(1)
    expect(f.onTables.mock.calls.at(-1)?.[0]).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  } finally { f.client.disconnect(false) }
})

it('replaces a silent stream even while successful polls keep tables fresh', async () => {
  const f = fixture()
  try {
    await vi.advanceTimersByTimeAsync(0)
    f.emit(0, 'heartbeat', {})
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(10000)
    // A poll just before the watchdog deadline must not renew SSE liveness.
    f.emit(0, 'heartbeat', {})
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(15000)
    expect(f.streams.length).toBe(2)
    expect(f.streams[0].signal.aborted).toBe(true)
  } finally { f.client.disconnect(false); f.streams.forEach(s => s.controller.close()) }
  await vi.advanceTimersByTimeAsync(0)
  expect(vi.getTimerCount()).toBe(0)
})
