import { afterEach, expect, it, vi } from 'vitest'
import { getOnlineLicenseStatus } from './onlineLicenseClient'

afterEach(() => vi.useRealTimers())

async function deniedStatus(error: string, status = 401) {
  vi.useFakeTimers()
  const send = vi.fn(async () => ({ ok: false, status, json: async () => ({ configured: true, managers: [], agents: [], plans: [], licenses: [], error }) }) as Response)
  const result = getOnlineLicenseStatus({ adminSessionToken: 'synthetic-session' }, send)
  await vi.runAllTimersAsync()
  return { result: await result, calls: send.mock.calls.length }
}

it('D01 preserves session on production-shaped status DB timeout returned as 401', async () => {
  const { result, calls } = await deniedStatus('canceling statement due to statement timeout')
  expect(result.state).toBe('error')
  expect(result.licenseRows).toEqual([])
  expect(calls).toBe(3)
})

it('D01 retains explicit expired or revoked session invalidation', async () => {
  expect((await deniedStatus('admin session is required')).result.state).toBe('invalid')
})

it('D01 does not invalidate an authenticated session for insufficient super-admin privilege', async () => {
  expect((await deniedStatus('super admin session is required', 403)).result.state).toBe('error')
})
