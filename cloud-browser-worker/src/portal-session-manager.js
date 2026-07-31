import { readFile } from 'node:fs/promises'

const SESSION_KEY = /^(?:mt_?)?(?:token|session|ticket|auth(?:orization)?)$/i

export function createPersistedPortalSessionManager({ sessionPath, refresh = null } = {}) {
  const target = String(sessionPath ?? '').trim()
  let cached = null
  let loaded = false
  let refreshes = 0
  let lastError = null
  let refreshTail = Promise.resolve()

  async function getSessionToken() {
    if (cached) return cached
    try {
      const persisted = JSON.parse(await readFile(target, 'utf8'))
      cached = extractSessionValue(persisted)
      if (!cached) throw new Error('portal_session_token_unavailable')
      loaded = true
      lastError = null
      return cached
    } catch {
      loaded = false
      lastError = 'portal_session_token_unavailable'
      throw new Error(lastError)
    }
  }

  function runRefresh(context = {}) {
    const operation = refreshTail.then(async () => {
      if (typeof refresh !== 'function') throw new Error('portal_session_refresh_unavailable')
      cached = null
      loaded = false
      try {
        await refresh({ reason: String(context?.reason ?? 'session_refresh') })
        refreshes += 1
        await getSessionToken()
      } catch (error) {
        lastError = 'portal_session_refresh_failed'
        throw new Error(lastError, { cause: error })
      }
    })
    refreshTail = operation.catch(() => {})
    return operation
  }

  return {
    getSessionToken,
    refresh: runRefresh,
    invalidate() { cached = null; loaded = false },
    snapshot: () => ({ configured: Boolean(target), loaded, refreshes, lastError }),
  }
}

export function extractSessionValue(persisted = {}) {
  try {
    const url = new URL(String(persisted?.url ?? ''))
    for (const [name, value] of url.searchParams.entries()) {
      if (SESSION_KEY.test(name) && value) return value
    }
  } catch {}
  for (const origin of persisted?.storageState?.origins ?? []) {
    for (const item of origin?.localStorage ?? []) {
      if (SESSION_KEY.test(String(item?.name ?? '')) && String(item?.value ?? '')) return String(item.value)
    }
  }
  for (const cookie of persisted?.storageState?.cookies ?? []) {
    if (SESSION_KEY.test(String(cookie?.name ?? '')) && String(cookie?.value ?? '')) return String(cookie.value)
  }
  return null
}
