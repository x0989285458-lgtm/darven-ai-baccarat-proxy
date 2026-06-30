export async function runCloudDeploySmoke({ apiBaseUrl, workerUrl, expectedVersion = '042', fetchImpl = globalThis.fetch } = {}) {
  const checks = []
  const failures = []
  const base = normalizeBaseUrl(apiBaseUrl)

  await check('health', async () => {
    if (!base) throw new Error('apiBaseUrl is required')
    const body = await fetchJson(fetchImpl, `${base}/health`)
    if (!body.ok) throw new Error('health ok=false')
    if (expectedVersion && String(body.version) !== String(expectedVersion)) throw new Error(`health version ${body.version} !== ${expectedVersion}`)
    return { version: body.version }
  })

  await check('cloud-capture status', async () => {
    const body = await fetchJson(fetchImpl, `${base}/api/cloud-capture/status`)
    if (!body.workerConfigured) throw new Error('workerConfigured=false')
    return { workerConfigured: body.workerConfigured, running: body.running }
  })

  await check('cloud-capture tick', async () => {
    const body = await fetchJson(fetchImpl, `${base}/api/cloud-capture/tick`, { method: 'POST' })
    if (!body.ok) throw new Error('tick ok=false')
    return { connected: body.status?.connected, authenticated: body.status?.authenticated, tableCount: body.status?.tableCount }
  })

  if (workerUrl) {
    await check('worker snapshot', async () => {
      const body = await fetchJson(fetchImpl, workerUrl)
      if (!body.connected) throw new Error('worker connected=false')
      if (!body.authenticated) throw new Error('worker authenticated=false')
      if (!Array.isArray(body.tables)) throw new Error('worker tables is not array')
      return { sessionId: body.sessionId ?? null, tableCount: body.tables.length, roundCount: Array.isArray(body.rounds) ? body.rounds.length : 0 }
    })
  }

  return { ok: failures.length === 0, checks, failures }

  async function check(name, fn) {
    try {
      const details = await fn()
      checks.push({ name, ok: true, ...details })
    } catch (error) {
      const message = `${name}: ${error?.message ?? String(error)}`
      failures.push(message)
      checks.push({ name, ok: false, error: message })
    }
  }
}

async function fetchJson(fetchImpl, url, init) {
  const response = await fetchImpl(url, init)
  const text = typeof response.text === 'function' ? await response.text() : ''
  let body = null
  if (text) {
    try { body = JSON.parse(text) } catch { body = { raw: text } }
  } else if (typeof response.json === 'function') {
    body = await response.json()
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text || JSON.stringify(body)}`)
  return body ?? {}
}

function normalizeBaseUrl(apiBaseUrl) {
  if (!apiBaseUrl) return ''
  return String(apiBaseUrl).replace(/\/+$/, '')
}
