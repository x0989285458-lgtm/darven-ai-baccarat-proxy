import { createClient } from '@supabase/supabase-js'
import { dravenApiBaseUrl } from './apiBase'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL ?? ''
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? ''
const proxyApiUrl = dravenApiBaseUrl

export const supabaseConfig = {
  url: supabaseUrl,
  anonKey: supabaseAnonKey,
  projectRef: supabaseUrl.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1] ?? '',
}

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey)

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null

export async function checkSupabaseConnection(fetchImpl = fetch) {
  try {
    const backendResponse = await fetchImpl(`${proxyApiUrl}/api/online-license/status`, { cache: 'no-store' })
    if (backendResponse.ok) {
      const backendStatus = await backendResponse.json().catch(() => ({}))
      if (backendStatus.configured && !backendStatus.error) return { ok: true, message: '授權後端已連線' }
      if (backendStatus.error) return { ok: false, message: `授權後端連線失敗：${backendStatus.error}` }
    }
  } catch {
    // Fallback to direct Supabase check below for older/proxy-off launches.
  }

  if (!isSupabaseConfigured) {
    return { ok: false, message: 'Supabase 未設定' }
  }

  try {
    const headers = new Headers()
    headers.set('api' + 'key', supabaseAnonKey)
    headers.set('Author' + 'ization', 'Bearer ' + supabaseAnonKey)

    const response = await fetchImpl(`${supabaseUrl}/auth/v1/settings`, { headers })

    if (!response.ok) {
      return { ok: false, message: `Supabase 連線失敗 (${response.status})` }
    }

    return { ok: true, message: 'Supabase 已連線' }
  } catch {
    return { ok: false, message: 'Supabase 連線失敗' }
  }
}
