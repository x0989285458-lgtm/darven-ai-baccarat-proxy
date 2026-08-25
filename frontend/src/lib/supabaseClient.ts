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
    const endpoint = adminSessionToken ? '/api/online-license/status' : '/api/online-license/health'
    const request = () => fetchImpl(`${proxyApiUrl}${endpoint}`, requestOptions)
    let backendResponse = await request()
    for (let retry = 0; adminSessionToken && [401, 403].includes(backendResponse.status) && retry < 2; retry += 1) {
      await new Promise((resolve) => setTimeout(resolve, 750))
      backendResponse = await request()
    }
    if (backendResponse.ok) {
      const backendStatus = await backendResponse.json().catch(() => ({}))
      if (backendStatus.error) return { ok: false, message: `授權後端連線失敗：${backendStatus.error}` }
      if (!adminSessionToken && (backendStatus.configured !== true || backendStatus.connected !== true)) return { ok: false, message: '授權後端未連線' }
      return { ok: true, message: '授權後端已連線' }
    }
    return { ok: false, message: `授權後端連線失敗 (${backendResponse.status})` }
  } catch {
    return { ok: false, message: '授權後端連線失敗' }
  }
}
