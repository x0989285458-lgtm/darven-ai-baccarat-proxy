type DravenApiEnv = Record<string, string | undefined>

const DEFAULT_LOCAL_API_URL = 'http://127.0.0.1:8787'

export function resolveDravenApiBaseUrl(env: DravenApiEnv = import.meta.env): string {
  const mode = normalizeMode(env.VITE_DRAVEN_API_MODE)
  const legacyLocalUrl = env.VITE_DRAVEN_PROXY_API_URL
  const localUrl = env.VITE_DRAVEN_LOCAL_API_URL ?? legacyLocalUrl ?? DEFAULT_LOCAL_API_URL
  const cloudUrl = env.VITE_DRAVEN_CLOUD_API_URL

  if (mode === 'cloud' && cloudUrl) return stripTrailingSlash(cloudUrl)
  return stripTrailingSlash(localUrl)
}

export const dravenApiBaseUrl = resolveDravenApiBaseUrl()

function normalizeMode(mode?: string) {
  return String(mode ?? 'local').trim().toLowerCase() === 'cloud' ? 'cloud' : 'local'
}

function stripTrailingSlash(url: string) {
  return String(url || DEFAULT_LOCAL_API_URL).replace(/\/$/, '')
}
