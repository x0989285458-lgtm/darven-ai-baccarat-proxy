import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import App from './App'
import type { LiveTable } from './lib/liveClient'

const live = vi.hoisted(() => ({ publish: (_tables: LiveTable[]) => {} }))
vi.mock('./lib/liveClient', async (original) => ({
  ...await original<typeof import('./lib/liveClient')>(),
  LiveRoadClient: class {
    constructor(options: { onTables: (tables: LiveTable[]) => void }) { live.publish = options.onTables }
    connect() {}
    disconnect() {}
  },
}))

const table = (id = 'BAV01', shoe = 123): LiveTable => ({
  id, name: id, table_type: 'BAC', sourceUpdatedAt: new Date().toISOString(),
  trend: { bead_plate2: '', big2: '', current_shoe: shoe, current_round: 3 },
})
const history = (id = 'BAV01', shoe = 123) => ({
  ok: true, buildVersion: 'v105', tableId: id, shoe,
  settledPredictions: [{ round: 3, predictedResult: 'banker', actualResult: 'banker', isHit: true }],
  realCardRounds: [{ round: 3, result: 'banker', bankerPoint: 8, playerPoint: 1 }],
  realCardHistoryCompleteThroughRound: 3,
})
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

beforeEach(() => {
  vi.useFakeTimers()
  window.history.pushState({}, '', '/')
  window.sessionStorage.setItem('darven-member-session-token', 'offline-test-session')
})
afterEach(() => {
  cleanup()
  window.sessionStorage.clear()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function mount(historyFetch: (url: string, init?: RequestInit) => Promise<unknown>, tables = [table()]) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes('/ui-history')) return historyFetch(String(url), init)
    return ok({ ok: true, configured: true, connected: true, maintenanceMode: false,
      sessionExpiresAt: new Date(Date.now() + 600000).toISOString() })
  }))
  await act(async () => { render(<App />) })
  await act(async () => { live.publish(tables) })
}

it('recovers history after one transport failure without changing table or round', async () => {
  let calls = 0
  await mount(async () => {
    if (++calls === 1) throw new TypeError('offline transport fixture')
    return ok(history())
  })
  expect(calls).toBe(1)
  await act(async () => { await vi.advanceTimersByTimeAsync(150) })
  expect(calls).toBe(2)
  expect(document.querySelectorAll('.prediction-history tbody tr')).toHaveLength(1)
  expect(window.sessionStorage.getItem('darven-member-session-token')).toBe('offline-test-session')
})

it.each([408, 429, 500, 502, 503, 504])('recovers retryable HTTP %s with the same immutable identity', async (status) => {
  let calls = 0
  await mount(async () => ++calls === 1 ? { ok: false, status } : ok(history()))
  await act(async () => { await vi.advanceTimersByTimeAsync(150) })
  expect(calls).toBe(2)
  expect(document.querySelectorAll('.prediction-history tbody tr')).toHaveLength(1)
})

it('recovers a rejected JSON body', async () => {
  let calls = 0
  await mount(async () => ++calls === 1
    ? { ok: true, status: 200, json: async () => { throw new SyntaxError('offline JSON fixture') } }
    : ok(history()))
  await act(async () => { await vi.advanceTimersByTimeAsync(150) })
  expect(calls).toBe(2)
  expect(document.querySelectorAll('.prediction-history tbody tr')).toHaveLength(1)
})

it('caps persistent transport failures at the initial read plus two retries', async () => {
  let calls = 0
  await mount(async () => { calls++; throw new TypeError('offline fixture') })
  await act(async () => { await vi.advanceTimersByTimeAsync(149) })
  expect(calls).toBe(1)
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  expect(calls).toBe(2)
  await act(async () => { await vi.advanceTimersByTimeAsync(399) })
  expect(calls).toBe(2)
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  expect(calls).toBe(3)
  await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
  expect(calls).toBe(3)
})

it.each([400, 403, 404])('does not retry non-transient HTTP %s', async (status) => {
  let calls = 0
  await mount(async () => { calls++; return { ok: false, status } })
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(calls).toBe(1)
})

it('clears the member session on 401 without retrying', async () => {
  let calls = 0
  await mount(async () => { calls++; return { ok: false, status: 401 } })
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(calls).toBe(1)
  expect(window.sessionStorage.getItem('darven-member-session-token')).toBeNull()
})

it('cancels a scheduled retry when switching tables', async () => {
  const calls: string[] = []
  await mount(async (url) => {
    calls.push(url)
    if (url.includes('/BAV01/')) throw new TypeError('offline fixture')
    return ok(history('BAV02'))
  }, [table(), table('BAV02')])
  await act(async () => { fireEvent.click(document.querySelector('button[data-table-id="BAV02"]')!) })
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(calls.filter(url => url.includes('/BAV01/'))).toHaveLength(1)
  expect(calls.filter(url => url.includes('/BAV02/'))).toHaveLength(1)
  expect(document.querySelector('button.active[data-table-id]')).toHaveAttribute('data-table-id', 'BAV02')
  expect(document.querySelectorAll('.prediction-history tbody tr')).toHaveLength(1)
})

it('cancels a scheduled retry on unmount', async () => {
  let calls = 0
  await mount(async () => { calls++; throw new TypeError('offline fixture') })
  cleanup()
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(calls).toBe(1)
})

it.each(['table', 'shoe', 'duplicates'])('rejects a retry response with invalid %s identity', async (kind) => {
  let calls = 0
  const wrong = history()
  if (kind === 'table') wrong.tableId = 'BAV02'
  if (kind === 'shoe') wrong.shoe = 124
  if (kind === 'duplicates') wrong.settledPredictions.push({ ...wrong.settledPredictions[0] })
  await mount(async () => { if (++calls === 1) throw new TypeError('offline fixture'); return ok(wrong) })
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(calls).toBe(2)
  expect(document.querySelectorAll('.prediction-history tbody tr')).toHaveLength(0)
})

it('ignores an in-flight retry completing after a table switch', async () => {
  let calls = 0
  let resolveOld!: (value: unknown) => void
  let oldSignal: AbortSignal | undefined | null
  await mount(async (url, init) => {
    if (url.includes('/BAV02/')) return ok(history('BAV02'))
    if (++calls === 1) throw new TypeError('offline fixture')
    oldSignal = init?.signal
    return new Promise(resolve => { resolveOld = resolve })
  }, [table(), table('BAV02')])
  await act(async () => { await vi.advanceTimersByTimeAsync(150) })
  expect(calls).toBe(2)
  await act(async () => { fireEvent.click(document.querySelector('button[data-table-id="BAV02"]')!) })
  expect(oldSignal?.aborted).toBe(true)
  await act(async () => { resolveOld(ok(history('BAV01'))) })
  expect(document.querySelector('button.active[data-table-id]')).toHaveAttribute('data-table-id', 'BAV02')
  expect(document.querySelectorAll('.prediction-history tbody tr')).toHaveLength(1)
})

it('shares the retry budget between incomplete history and transport errors', async () => {
  let calls = 0
  await mount(async () => {
    calls++
    if (calls === 2) throw new TypeError('offline fixture')
    return ok({ ...history(), realCardHistoryCompleteThroughRound: 1 })
  })
  await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
  expect(calls).toBe(3)
})
