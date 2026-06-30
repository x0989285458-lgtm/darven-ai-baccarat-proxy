import { describe, expect, it, vi } from 'vitest'
import { checkSupabaseConnection } from './supabaseClient'

describe('supabaseClient v032 proxy-first status', () => {
  it('uses backend online-license status so frontend does not fail only because anon key is test key', async () => {
    const fetchImpl = vi.fn((url: string) => {
      if (url.includes('/api/online-license/status')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ configured: true, error: null }) })
      return Promise.resolve({ ok: false, status: 401 })
    }) as unknown as typeof fetch

    const result = await checkSupabaseConnection(fetchImpl)
    expect(result).toEqual({ ok: true, message: '授權後端已連線' })
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:8787/api/online-license/status', { cache: 'no-store' })
  })
})
