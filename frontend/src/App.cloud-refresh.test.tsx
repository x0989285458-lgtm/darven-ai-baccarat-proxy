import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import App from './App'
const response = (body: unknown) => ({ ok: true, status: 200, json: async () => body })
let cloud = vi.fn<(url: string, init?: RequestInit) => Promise<any>>()
let other = vi.fn<(url: string, init?: RequestInit) => Promise<any>>()
beforeEach(() => {
  vi.useFakeTimers()
  window.history.pushState({}, '', '/admin')
  window.sessionStorage.setItem('darven-admin-account', 'DV1788')
  window.sessionStorage.setItem('darven-admin-session-token', 'fixture')
  window.sessionStorage.setItem('darven-admin-role', 'super')
  cloud = vi.fn().mockResolvedValue(response({ ok: true, todayRoundCount: 42 }))
  other = vi.fn().mockResolvedValue(response({ connected: true, items: [], reports: [], strategies: [] }))
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    if (url.includes('/api/cloud-data/status')) return cloud(url, init)
    if (url.includes('/api/tables')) return Promise.resolve(response([]))
    return other(url, init)
  }))
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); window.sessionStorage.clear() })
it('backs off 5/10/20/30 seconds, caps retries and resets after recovery', async () => {
  cloud.mockRejectedValue(new TypeError('offline'))
  const view = render(<App />); await flush()
  expect(screen.getByText('更新暫停／尚無資料')).toBeInTheDocument()
  let calls = 1
  for (const delay of [5000, 10000, 20000, 30000, 30000]) {
    await advance(delay - 1); expect(cloud).toHaveBeenCalledTimes(calls)
    await advance(1); expect(cloud).toHaveBeenCalledTimes(++calls)
  }
  cloud.mockResolvedValue(response({ ok: true, todayRoundCount: 0 }))
  await advance(30000)
  expect(screen.getByText('已抓 0 局')).toBeInTheDocument()
  cloud.mockRejectedValueOnce(new Error('again'))
  await advance(300000)
  const before = cloud.mock.calls.length
  await advance(5000); expect(cloud).toHaveBeenCalledTimes(before + 1)
  view.unmount()
  const stopped = cloud.mock.calls.length
  await advance(300000); expect(cloud).toHaveBeenCalledTimes(stopped)
})
it('cloud progresses while unrelated memory and strategy reads remain pending', async () => {
  other.mockImplementation(() => new Promise(() => {}))
  render(<App />); await flush()
  expect(screen.getByText('已抓 42 局')).toBeInTheDocument()
  cloud.mockResolvedValue(response({ ok: true, todayRoundCount: 43 }))
  await advance(300000)
  expect(screen.getByText('已抓 43 局')).toBeInTheDocument()
})
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0) })
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
it('does not overlap an initially slow cloud request or repeat unrelated reports', async () => {
  let resolve!: (value: unknown) => void
  cloud.mockImplementationOnce(() => new Promise(r => { resolve = r }))
  render(<App />)
  await flush()
  await advance(20000)
  expect(cloud).toHaveBeenCalledTimes(1)
  expect(screen.getByText('讀取中')).toBeInTheDocument()
  await act(async () => { resolve(response({ ok: true, todayRoundCount: 81 })) })
  expect(screen.getByText('已抓 81 局')).toBeInTheDocument()
})
it('marks stale data after transport failure and recovers five seconds later without retrying reports', async () => {
  render(<App />); await flush()
  expect(screen.getByText('已抓 42 局')).toBeInTheDocument()
  cloud.mockRejectedValueOnce(new TypeError('transport')).mockResolvedValue(response({ ok: true, todayRoundCount: 99 }))
  await advance(300000)
  expect(screen.getByText('更新暫停／上次42局')).toBeInTheDocument()
  const reports = () => other.mock.calls.filter(([url]) => /memory-center|strategy-analysis/.test(url)).length
  const before = reports()
  await advance(4999); expect(cloud).toHaveBeenCalledTimes(2)
  await advance(1); expect(screen.getByText('已抓 99 局')).toBeInTheDocument()
  expect(reports()).toBe(before)
})
it('aborts on unmount and ignores old response after a new mount succeeds', async () => {
  let resolve!: (value: unknown) => void
  cloud.mockImplementationOnce(() => new Promise(r => { resolve = r }))
  const first = render(<App />); await flush()
  const signal = cloud.mock.calls[0][1]!.signal!
  first.unmount()
  render(<App />); await flush()
  expect(signal.aborted).toBe(true)
  expect(screen.getByText('已抓 42 局')).toBeInTheDocument()
  await act(async () => { resolve(response({ ok: true, todayRoundCount: 7 })) })
  expect(screen.queryByText('已抓 7 局')).not.toBeInTheDocument()
  expect(screen.getByText('已抓 42 局')).toBeInTheDocument()
})
