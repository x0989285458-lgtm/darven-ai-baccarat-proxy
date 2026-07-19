import { describe, expect, it, vi } from 'vitest'
import { checkSupabaseConnection } from './supabaseClient'

describe('supabaseClient proxy-first status', () => {
  it('uses the public license health endpoint for member pages without an admin session', async () => {
    const fetchImpl = vi.fn((url: string) => {
      if (url.includes('/api/online-license/health')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ configured: true, connected: true }) })
      return Promise.resolve({ ok: false, status: 401 })
    }) as unknown as typeof fetch

    const result = await checkSupabaseConnection(undefined, fetchImpl)
    expect(result).toEqual({ ok: true, message: '授權後端已連線' })
    expect(String((fetchImpl as any).mock.calls[0][0])).toContain('/api/online-license/health')
    expect((fetchImpl as any).mock.calls[0][1]).toEqual({ cache: 'no-store' })
  })

  it('fails through the public health endpoint without attempting a direct Supabase fallback', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve({ ok: false, status: 503 })) as unknown as typeof fetch
    const result = await checkSupabaseConnection(undefined, fetchImpl)

    expect(result).toEqual({ ok: false, message: '授權後端連線失敗 (503)' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(String((fetchImpl as any).mock.calls[0][0])).toContain('/api/online-license/health')
  })

  it('sends the opaque admin session when checking the protected license backend', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ configured: true, error: null }) })) as unknown as typeof fetch

    const result = await checkSupabaseConnection('opaque-admin-session', fetchImpl)

    expect(result).toEqual({ ok: true, message: '授權後端已連線' })
    expect(String((fetchImpl as any).mock.calls[0][0])).toContain('/api/online-license/status')
    expect((fetchImpl as any).mock.calls[0][1]).toEqual({
      cache: 'no-store',
      headers: { Authorization: 'Bearer opaque-admin-session' },
    })
  })
})
