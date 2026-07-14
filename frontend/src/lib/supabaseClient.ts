import { dravenApiBaseUrl } from './apiBase'
const proxyApiUrl = dravenApiBaseUrl

export const supabaseConfig = {
  url: '',
  anonKey: '',
  projectRef: 'backend-only',
}

export const isSupabaseConfigured = Boolean(proxyApiUrl)
export const supabase = null

export async function checkSupabaseConnection(adminSessionToken?: string, fetchImpl = fetch) {
  try {
    const requestOptions: RequestInit = { cache: 'no-store' }
    if (adminSessionToken) requestOptions.headers = { Authorization: `Bearer ${adminSessionToken}` }
    const backendResponse = await fetchImpl(`${proxyApiUrl}/api/online-license/status`, requestOptions)
    if (backendResponse.ok) {
      const backendStatus = await backendResponse.json().catch(() => ({}))
      if (backendStatus.error) return { ok: false, message: `授權後端連線失敗：${backendStatus.error}` }
      return { ok: true, message: '授權後端已連線' }
    }
    return { ok: false, message: `授權後端連線失敗 (${backendResponse.status})` }
  } catch {
    return { ok: false, message: '授權後端連線失敗' }
  }
}
