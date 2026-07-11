import { fileURLToPath } from 'node:url'

const DEFAULT_PROXY_URL = process.env.DRAVEN_PROXY_URL || 'http://127.0.0.1:8787'
const DEFAULT_WORKER_URL = process.env.DRAVEN_WORKER_URL || process.env.CLOUD_BROWSER_URL || 'http://35.234.3.167:8787/snapshot'

export async function fetchJson(url, { headers = {}, timeoutMs = 10000 } = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { cache: 'no-store', headers, signal: controller.signal })
    const body = await response.json().catch(() => ({}))
    return { ok: response.ok, status: response.status, body }
  } finally {
    clearTimeout(timeout)
  }
}

export async function runV093Monitor({ proxyUrl = DEFAULT_PROXY_URL, workerUrl = DEFAULT_WORKER_URL, workerAdminKey = process.env.WORKER_ADMIN_KEY } = {}) {
  const checks = []
  const proxyBase = new URL(proxyUrl)
  const workerHeaders = workerAdminKey ? { 'x-worker-admin-key': workerAdminKey } : {}

  const status = await safeCheck('後端狀態', () => fetchJson(new URL('/api/status', proxyBase)))
  checks.push(status)

  const tables = await safeCheck('桌況資料', () => fetchJson(new URL('/api/tables', proxyBase)))
  checks.push(tables)

  const cloudData = await safeCheck('DB寫入狀態', () => fetchJson(new URL('/api/cloud-data/status', proxyBase)))
  checks.push(cloudData)

  const worker = await safeCheck('Worker snapshot', () => fetchJson(workerUrl, { headers: workerHeaders }))
  checks.push(worker)

  return summarizeChecks(checks)
}

async function safeCheck(name, action) {
  try {
    const result = await action()
    return { name, ...result }
  } catch (error) {
    return { name, ok: false, status: 0, body: { error: error?.message ?? String(error) } }
  }
}

export function summarizeChecks(checks = []) {
  const lines = ['v093 健康/穩定性監控摘要']
  for (const check of checks) {
    const body = check.body ?? {}
    const tableCount = Array.isArray(body) ? body.length : Number(body.tableCount ?? body.status?.tableCount ?? (Array.isArray(body.tables) ? body.tables.length : 0)) || 0
    const persistence = body.persistenceStatus ?? body.status?.persistenceStatus ?? body.status?.cloudWriteStatus ?? body.message ?? body.error ?? '未回報'
    const stale = body.stale || /過期|stale/i.test(String(body.statusText ?? body.message ?? body.errorMessage ?? body.error ?? ''))
    const note = check.name === 'DB寫入狀態'
      ? `DB:${persistence}`
      : check.name.includes('Worker')
        ? `桌數:${tableCount}｜snapshot:${body.snapshotAt ?? body.snapshot_at ?? '未回報'}`
        : `桌數:${tableCount}`
    lines.push(`${check.ok ? '✅' : '❌'} ${check.name}｜HTTP ${check.status || '失敗'}｜${stale ? '資料過期｜' : ''}${note}`)
  }
  const failed = checks.filter((check) => !check.ok).length
  lines.push(failed ? `結論：有 ${failed} 項異常，請先檢查 worker/proxy/DB 寫入。` : '結論：監控檢查完成，未發現 HTTP 異常。')
  return lines.join('\n')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runV093Monitor()
    .then((summary) => console.log(summary))
    .catch((error) => {
      console.error(`v093 監控檢查失敗：${error.message}`)
      process.exitCode = 1
    })
}
