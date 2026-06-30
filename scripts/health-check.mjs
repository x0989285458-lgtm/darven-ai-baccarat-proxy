import { fileURLToPath } from 'node:url'

const DEFAULT_BASE_URL = process.env.DRAVEN_PROXY_URL || 'http://127.0.0.1:8787'

export function summarizeHealth({ health = {}, status = {} } = {}) {
  const version = health.version ? `v${health.version}` : 'v未知'
  const connected = status.connected ? '已連線' : '未連線'
  const authenticated = status.authenticated ? '已驗證' : '未驗證'
  const tableCount = status.tableCount ?? 0
  const reconnectCount = status.reconnectCount ?? 0
  const lastMessageAt = status.lastMessageAt ?? '尚無資料'
  const error = status.errorMessage ? `，錯誤: ${status.errorMessage}` : ''
  return `Draven MT代理 ${version}｜${connected}｜${authenticated}｜桌數: ${tableCount}｜重連: ${reconnectCount}｜最後訊息: ${lastMessageAt}${error}`
}

export async function fetchJson(pathname, baseUrl = DEFAULT_BASE_URL) {
  const response = await fetch(new URL(pathname, baseUrl))
  if (!response.ok) throw new Error(`${pathname} HTTP ${response.status}`)
  return response.json()
}

export async function runHealthCheck(baseUrl = DEFAULT_BASE_URL) {
  const [health, status] = await Promise.all([
    fetchJson('/health', baseUrl),
    fetchJson('/api/status', baseUrl),
  ])
  return summarizeHealth({ health, status })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runHealthCheck()
    .then((summary) => {
      console.log(summary)
    })
    .catch((error) => {
      console.error(`Draven MT代理健康檢查失敗：${error.message}`)
      process.exitCode = 1
    })
}
