import { describe, expect, it, vi } from 'vitest'
import { getOnlineLicenseStatus, validateMemberSession } from './onlineLicenseClient'

describe('authorization contract', () => {
  it('sends the member session only through the Authorization header', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ ok: true, sessionExpiresAt: '2026-07-13T20:30:00.000Z' }),
    })) as unknown as typeof fetch

    await validateMemberSession('opaque-member-token', fetchImpl)

    const [url, init] = (fetchImpl as any).mock.calls[0]
    expect(String(url)).not.toContain('opaque-member-token')
    expect((init as RequestInit).headers).toEqual({ Authorization: 'Bearer opaque-member-token' })
  })

  it('never places the admin session token in the status URL query', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ configured: true }),
    })) as unknown as typeof fetch

    await getOnlineLicenseStatus({ adminAccount: 'dv1788', adminSessionToken: 'opaque-admin-token' }, fetchImpl)

    const [url, init] = (fetchImpl as any).mock.calls[0]
    expect(String(url)).toContain('adminAccount=dv1788')
    expect(String(url)).not.toContain('opaque-admin-token')
    expect((init as RequestInit).headers).toEqual({ Authorization: 'Bearer opaque-admin-token' })
  })
})
