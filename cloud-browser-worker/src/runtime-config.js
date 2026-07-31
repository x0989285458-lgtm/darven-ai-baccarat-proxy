export const BUILD_VERSION = '105'

const REQUIRED_PRODUCTION_SETTINGS = ['WORKER_ADMIN_KEY', 'INGEST_KEY', 'PUSH_TARGET_URL', 'MT_LOGIN_URL']

export function validateProductionConfig(env = process.env) {
  validateReleaseRuntimeScope(env)
  if (env.NODE_ENV !== 'production') return
  const missing = REQUIRED_PRODUCTION_SETTINGS.filter((name) => !String(env[name] ?? '').trim())
  if (missing.length > 0) {
    throw new Error(`Missing required production settings: ${missing.join(', ')}`)
  }
  let pushTarget
  try {
    pushTarget = new URL(String(env.PUSH_TARGET_URL))
  } catch {
    throw new Error('Production PUSH_TARGET_URL must be a valid HTTPS URL')
  }
  if (pushTarget.protocol !== 'https:') {
    throw new Error('Production PUSH_TARGET_URL must use HTTPS')
  }
  let loginUrl
  try {
    loginUrl = new URL(String(env.MT_LOGIN_URL))
  } catch {
    throw new Error('Production MT_LOGIN_URL must be a valid HTTPS URL')
  }
  if (loginUrl.protocol !== 'https:') {
    throw new Error('Production MT_LOGIN_URL must use HTTPS')
  }
}

export function validateReleaseRuntimeScope(env = process.env) {
  const sourceMode = String(env.MT_SOURCE_MODE ?? 'api').trim()
  const captureRole = String(env.MT_CAPTURE_ROLE ?? 'canonical').trim()
  if (sourceMode !== 'api') throw new Error('release_runtime_source_mode_must_be_api')
  if (captureRole !== 'canonical') throw new Error('release_runtime_capture_role_must_be_canonical')
  if (String(env.MT_BACKUP_FINAL_JOURNAL_PATH ?? '').trim()
    || String(env.MT_BACKUP_SESSION_TOKEN_FILE ?? '').trim()) {
    throw new Error('release_runtime_backup_environment_must_be_empty')
  }
}

export function assertMtFinalUrl(configuredUrl, finalUrl) {
  const configured = new URL(String(configuredUrl))
  const final = new URL(String(finalUrl))
  if (final.protocol !== 'https:') throw new Error('MT final URL must use HTTPS')
  if (final.origin !== configured.origin) throw new Error('MT final URL origin does not match configured origin')
}

export function assertMtNavigationResponse(response) {
  const redirectedFrom = response?.request?.()?.redirectedFrom?.()
  if (redirectedFrom) throw new Error('MT navigation redirect is not allowed')
}

export function publicBuildInfo() {
  return { buildVersion: BUILD_VERSION }
}

export function captureSessionId(baseSessionId, pageGeneration) {
  return `${baseSessionId}-${pageGeneration}`
}
