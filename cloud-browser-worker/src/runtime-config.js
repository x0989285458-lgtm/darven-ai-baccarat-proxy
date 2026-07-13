export const BUILD_VERSION = 'v098'

const REQUIRED_PRODUCTION_SETTINGS = ['WORKER_ADMIN_KEY', 'INGEST_KEY', 'PUSH_TARGET_URL']

export function validateProductionConfig(env = process.env) {
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
}

export function publicBuildInfo() {
  return { buildVersion: BUILD_VERSION }
}

export function captureSessionId(baseSessionId, pageGeneration) {
  return `${baseSessionId}-${pageGeneration}`
}
