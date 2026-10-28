// Best-effort wake only: publication durability never depends on this request.
export function createPublicationNotifier({ url, token, tableIds = [], fetchImpl = globalThis.fetch, timeoutMs = 500 } = {}) {
  const endpoint = new URL(url)
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.port !== '8792' || endpoint.pathname !== '/internal/publication-ready' || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) throw new Error('publication hint requires the exact loopback endpoint')
  if (typeof token !== 'string' || !token || typeof fetchImpl !== 'function') throw new Error('publication hint configuration missing')
  const allowed = new Set(tableIds), seen = new Map()
  let stopped = false, timer = null, active = null, dirty = false, sent = 0, failed = 0
  const schedule = () => { if (!stopped && dirty && !active && !timer) timer = setTimeout(send, 10) }
  async function send() {
    timer = null
    if (stopped || active || !dirty) return
    dirty = false
    const controller = new AbortController()
    active = controller
    const abortTimer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(endpoint.href, { method: 'POST', headers: { 'content-type': 'application/json', 'x-control-token': token, 'x-forwarded-proto': 'https' }, body: '{}', signal: controller.signal, redirect: 'error' })
      if (!response.ok) throw new Error('publication hint rejected')
      sent++
    } catch { failed++ }
    finally { clearTimeout(abortTimer); active = null; schedule() }
  }
  return {
    notify(receipt) {
      if (stopped || !['published', 'duplicate'].includes(receipt?.disposition) || !allowed.has(receipt.table_id) || !Number.isSafeInteger(receipt.publication_revision) || receipt.publication_revision < 1) return false
      if ((seen.get(receipt.table_id) ?? 0) >= receipt.publication_revision) return false
      seen.set(receipt.table_id, receipt.publication_revision)
      dirty = true; schedule(); return true
    },
    status() { return { sent, failed, pending: dirty, inFlight: Boolean(active) } },
    stop() { stopped = true; dirty = false; if (timer) clearTimeout(timer); timer = null; active?.abort(); seen.clear() },
  }
}
