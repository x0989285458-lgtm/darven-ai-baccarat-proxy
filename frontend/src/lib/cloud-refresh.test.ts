import { afterEach, expect, it, vi } from 'vitest'
import { getCloudDataStatus } from './onlineLicenseClient'
afterEach(() => vi.useRealTimers())
it.each([null, '1000', -1, 1.5, undefined, NaN, Infinity])('rejects invalid count %s without inventing a count', async (todayRoundCount) => {
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, todayRoundCount }) })
  await expect(getCloudDataStatus(fetcher)).resolves.toMatchObject({ ok: false, state: 'error' })
})
it('bounds a stalled GET at 60000ms and clears its timer', async () => {
  vi.useFakeTimers()
  let signal!: AbortSignal
  const fetcher = vi.fn((_url, init) => new Promise((_resolve, reject) => {
    signal = init.signal
    signal.addEventListener('abort', () => reject(new Error('abort')), { once: true })
  })) as unknown as typeof fetch
  const result = getCloudDataStatus(fetcher)
  await vi.advanceTimersByTimeAsync(59999)
  expect(signal.aborted).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  await expect(result).resolves.toMatchObject({ ok: false, state: 'error' })
  expect(signal.aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})
it('accepts real zero and clears deadline after success', async () => {
  vi.useFakeTimers()
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, todayRoundCount: 0 }) })
  await expect(getCloudDataStatus(fetcher)).resolves.toMatchObject({ state: 'ready', todayRoundCount: 0 })
  expect(vi.getTimerCount()).toBe(0)
})
it('does not accept JSON that resolves after the request deadline', async () => {
  vi.useFakeTimers()
  let finish!: (value: unknown) => void
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: () => new Promise(resolve => { finish = resolve }) })
  const pending = getCloudDataStatus(fetcher)
  await vi.advanceTimersByTimeAsync(60000)
  finish({ ok: true, todayRoundCount: 1000 })
  await expect(pending).resolves.toMatchObject({ state: 'error', ok: false })
  expect(vi.getTimerCount()).toBe(0)
})
it('contains asynchronous JSON rejection', async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.reject(new Error('bad JSON')) })
  await expect(getCloudDataStatus(fetcher)).resolves.toMatchObject({ ok: false })
})
