import { existsSync, readFileSync } from 'node:fs'

export function parseEnvText(text = '') {
  const env = {}
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const index = trimmed.indexOf('=')
    if (index <= 0) continue
    const key = trimmed.slice(0, index).trim()
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, '')
    env[key] = value
  }
  return env
}

export function loadLocalEnv({ file = '.env', target = process.env } = {}) {
  if (!existsSync(file)) return {}
  const parsed = parseEnvText(readFileSync(file, 'utf8'))
  for (const [key, value] of Object.entries(parsed)) {
    if (target[key] === undefined) target[key] = value
  }
  return parsed
}

export function maskToken(token = '') {
  const text = String(token)
  if (text.length <= 8) return '[redacted]'
  return `${text.slice(0, 4)}…${text.slice(-4)}`
}

export function resolveDeployConfig(env = process.env) {
  const deployMode = String(env.DEPLOY_MODE ?? 'local').trim().toLowerCase() === 'cloud' ? 'cloud' : 'local'
  const requestedCaptureSource = String(env.CAPTURE_SOURCE ?? '').trim()
  const captureSource = requestedCaptureSource || (env.CLOUD_BROWSER_URL ? 'cloud_browser' : env.CHROME_CAPTURE_URL ? 'local_chrome' : env.MT_TOKEN ? 'node_ws' : 'offline')
  return {
    deployMode,
    captureSource,
    frontendOrigin: env.PUBLIC_FRONTEND_ORIGIN || '*',
    cloudBrowserUrl: env.CLOUD_BROWSER_URL ?? '',
    cloudCapturePollMs: Number(env.CLOUD_CAPTURE_POLL_MS ?? 2000),
    chromeCaptureUrl: env.CHROME_CAPTURE_URL ?? '',
    token: env.MT_TOKEN ?? '',
    autoConnect: deployMode === 'cloud' ? false : env.AUTO_CONNECT !== 'false',
  }
}
