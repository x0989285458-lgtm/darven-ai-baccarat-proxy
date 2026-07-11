import { fileURLToPath } from 'node:url'

const DEFAULT_PROXY_URL = process.env.DRAVEN_PROXY_URL || 'http://127.0.0.1:8787'
const DEFAULT_FRONTEND_URL = process.env.DRAVEN_FRONTEND_URL || 'http://127.0.0.1:5173'
const DEFAULT_WORKER_URL = process.env.DRAVEN_WORKER_URL || process.env.CLOUD_BROWSER_URL || 'http://35.234.3.167:8787/snapshot'

export async function runV094RollbackCheck({
  proxyUrl = DEFAULT_PROXY_URL,
  frontendUrl = DEFAULT_FRONTEND_URL,
  workerUrl = DEFAULT_WORKER_URL,
  workerAdminKey = process.env.WORKER_ADMIN_KEY,
} = {}) {
  const proxyBase = new URL(proxyUrl)
  const frontendBase = new URL(frontendUrl)
  const workerHeaders = workerAdminKey ? { 'x-worker-admin-key': workerAdminKey } : {}
  const checks = []
  checks.push(await safeCheck('前端首頁', () => fetchText(frontendBase)))
  checks.push(await safeCheck('Render proxy /api/status', () => fetchJson(new URL('/api/status', proxyBase))))
  checks.push(await safeCheck('Render proxy /api/tables', () => fetchJson(new URL('/api/tables', proxyBase))))
  checks.push(await safeCheck('Worker snapshot', () => fetchJson(workerUrl, { headers: workerHeaders })))
  return summarize(checks)
}

async function fetchJson(url, { headers = {}, timeoutMs = 10000 } = {}) {
  const response = await fetchWithTimeout(url, { headers, timeoutMs })
  const body = await response.json().catch(() => ({}))
  return { ok: response.ok, status: response.status, body }
}

async function fetchText(url, { timeoutMs = 10000 } = {}) {
  const response = await fetchWithTimeout(url, { timeoutMs })
  const body = await response.text().catch(() => '')
  return { ok: response.ok, status: response.status, body: { bytes: body.length, hasDarvenTitle: /瑞文AI百家|Darven/i.test(body) } }
}

async function fetchWithTimeout(url, { headers = {}, timeoutMs = 10000 } = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { cache: 'no-store', headers, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

async function safeCheck(name, action) {
  try {
    return { name, ...(await action()) }
  } catch (error) {
    return { name, ok: false, status: 0, body: { error: redact(error?.message ?? String(error)) } }
  }
}

function summarize(checks) {
  const lines = ['v094 rollback 本機檢查摘要（不部署、不切版）']
  for (const check of checks) {
    const body = check.body ?? {}
    const tableCount = Array.isArray(body) ? body.length : Number(body.tableCount ?? body.status?.tableCount ?? (Array.isArray(body.tables) ? body.tables.length : 0)) || 0
    const note = body.error || (check.name.includes('tables') || check.name.includes('Worker') ? `桌數:${tableCount}` : `bytes:${body.bytes ?? 'n/a'}`)
    lines.push(`${check.ok ? '✅' : '❌'} ${check.name}｜HTTP ${check.status || '失敗'}｜${note}`)
  }
  lines.push(checks.some((check) => !check.ok) ? '結論：有異常，先不要切回正式流量。' : '結論：本機 rollback 檢查通過，可交由人工確認後再部署/切流量。')
  return lines.join('\n')
}

function redact(message) {
  return String(message)
    .replace(/token=([^\s&]+)/gi, 'token=[redacted]')
    .replace(/secret=([^\s&]+)/gi, 'secret=[redacted]')
    .replace(/(sb_secret_[A-Za-z0-9._-]+)/g, '[redacted]')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runV094RollbackCheck()
    .then((summary) => console.log(summary))
    .catch((error) => {
      console.error(`v094 rollback 檢查失敗：${redact(error.message)}`)
      process.exitCode = 1
    })
}
