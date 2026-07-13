type DravenApiEnv = Record<string, string | boolean | undefined>

const DEFAULT_LOCAL_API_URL = 'http://127.0.0.1:8787'

export function resolveDravenApiBaseUrl(env: DravenApiEnv = import.meta.env): string {
  const mode = normalizeMode(env.VITE_DRAVEN_API_MODE)
  const production = env.PROD === true || String(env.MODE ?? '').trim().toLowerCase() === 'production'
  const legacyLocalUrl = asString(env.VITE_DRAVEN_PROXY_API_URL)
  const localUrl = asString(env.VITE_DRAVEN_LOCAL_API_URL) ?? legacyLocalUrl ?? DEFAULT_LOCAL_API_URL
  const cloudUrl = asString(env.VITE_DRAVEN_CLOUD_API_URL)

  if (production && mode !== 'cloud') throw new Error('正式環境 API 設定錯誤：必須使用 cloud 模式')
  if (mode === 'cloud') {
    if (!cloudUrl?.trim()) throw new Error('Cloud API 設定錯誤：缺少 VITE_DRAVEN_CLOUD_API_URL')
    if (!cloudUrl.trim().toLowerCase().startsWith('https://')) throw new Error('Cloud API 設定錯誤：正式鏈路必須使用 HTTPS')
    return stripTrailingSlash(cloudUrl)
  }
  return stripTrailingSlash(localUrl)
}

export const dravenApiBaseUrl = resolveDravenApiBaseUrl()

function normalizeMode(mode?: string | boolean) {
  return String(mode ?? 'local').trim().toLowerCase() === 'cloud' ? 'cloud' : 'local'
}

function asString(value?: string | boolean) {
  return typeof value === 'string' ? value : undefined
}

function stripTrailingSlash(url: string) {
  return String(url || DEFAULT_LOCAL_API_URL).replace(/\/$/, '')
}
