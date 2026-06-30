import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { createProxyState } from './state-store.js'
import { createMtClient } from './mt-client.js'
import { createChromeCaptureClient } from './chrome-capture.js'
import { createCloudCaptureClient } from './cloud-capture.js'
import { loadLocalEnv, maskToken, resolveDeployConfig } from './config.js'
import { createSupabaseIngestionClient } from './supabase-writer.js'
import { createOnlineCoreClient } from './online-core.js'
import { createLicenseAdminClient } from './license-admin.js'
import { chooseCaptureSource, describeCaptureStatus } from './capture-source.js'

const VERSION = '042'
const SERVICE = 'Draven MT資料代理伺服器'

export function createApp({ autoConnect, token = process.env.MT_TOKEN, port = Number(process.env.PORT ?? 8787), captureUrl = process.env.CHROME_CAPTURE_URL, cloudBrowserUrl = process.env.CLOUD_BROWSER_URL, deployMode = process.env.DEPLOY_MODE ?? 'local', captureSource: requestedCaptureSource = process.env.CAPTURE_SOURCE, frontendOrigin = process.env.PUBLIC_FRONTEND_ORIGIN || '*', fetchImpl = globalThis.fetch, supabaseClient = createSupabaseIngestionClient(), onlineCoreClient = createOnlineCoreClient(), licenseAdminClient = createLicenseAdminClient() } = {}) {
  const deployConfig = resolveDeployConfig({
    DEPLOY_MODE: deployMode,
    CAPTURE_SOURCE: requestedCaptureSource,
    PUBLIC_FRONTEND_ORIGIN: frontendOrigin,
    CLOUD_BROWSER_URL: cloudBrowserUrl,
    CHROME_CAPTURE_URL: captureUrl,
    MT_TOKEN: token,
    AUTO_CONNECT: autoConnect === undefined ? undefined : String(autoConnect),
    CLOUD_CAPTURE_POLL_MS: process.env.CLOUD_CAPTURE_POLL_MS,
  })
  const shouldAutoConnect = autoConnect ?? deployConfig.autoConnect
  const state = createProxyState({
    onRoundEvent: async (round, table) => {
      if (!supabaseClient?.configured && !supabaseClient?.persistRound) return
      try {
        await supabaseClient.ensureInitialStrategy?.()
        await supabaseClient.persistRound?.(round, table)
        state.setStatus({ persistenceStatus: 'ok', persistenceError: null })
      } catch (error) {
        state.setStatus({ persistenceStatus: 'error', persistenceError: error?.message ?? String(error) })
      }
    },
  })
  const captureSource = deployConfig.captureSource || chooseCaptureSource({ chromeCaptureUrl: captureUrl, cloudBrowserUrl, token })
  state.setStatus({ deployMode: deployConfig.deployMode, captureSource, captureMode: captureSource, cloudReady: true, statusText: describeCaptureStatus({ captureSource }) })
  const mtClient = createMtClient({ token, state })
  const chromeClient = createChromeCaptureClient({ url: captureUrl, state })
  const cloudCaptureClient = createCloudCaptureClient({ url: cloudBrowserUrl, state, writer: supabaseClient, fetchImpl, pollMs: deployConfig.cloudCapturePollMs })

  async function handle(method, url, rawBody = '') {
    const pathname = new URL(url, 'http://127.0.0.1').pathname
    if (method === 'OPTIONS') return jsonResponse(204, {}, frontendOrigin)
    if (!['GET', 'POST'].includes(method)) return jsonResponse(405, { error: 'Method Not Allowed' }, frontendOrigin)

    async function adminWrite(action) {
      try {
        return jsonResponse(200, await action(), frontendOrigin)
      } catch (error) {
        return jsonResponse(400, { ok: false, error: error?.message ?? String(error) }, frontendOrigin)
      }
    }

    if (pathname === '/') {
      return htmlResponse(200, renderBackendHome({ deployMode: deployConfig.deployMode, captureSource, frontendOrigin }), frontendOrigin)
    }
    if (pathname === '/health') {
      return jsonResponse(200, { ok: true, service: SERVICE, version: VERSION, deployMode: deployConfig.deployMode }, frontendOrigin)
    }
    if (pathname === '/api/status') {
      const status = state.snapshot().status
      await persistCloudStateSnapshot(status)
      const nextStatus = state.snapshot().status
      return jsonResponse(200, { ...nextStatus, deployMode: deployConfig.deployMode, statusText: describeCaptureStatus(nextStatus) }, frontendOrigin)
    }
    if (pathname === '/api/tables') {
      return jsonResponse(200, state.snapshot().tables, frontendOrigin)
    }
    if (pathname === '/api/snapshot') {
      return jsonResponse(200, state.snapshot(), frontendOrigin)
    }
    if (pathname === '/api/cloud-capture/status') {
      return jsonResponse(200, buildCloudCaptureManagementStatus(), frontendOrigin)
    }
    if (method === 'POST' && pathname === '/api/cloud-capture/tick') {
      const parsed = await cloudCaptureClient.tick()
      return jsonResponse(200, { ok: Boolean(parsed), running: cloudCaptureClient.isRunning(), status: state.snapshot().status }, frontendOrigin)
    }
    if (method === 'POST' && pathname === '/api/cloud-capture/start') {
      if (!cloudBrowserUrl) return jsonResponse(400, { ok: false, error: 'CLOUD_BROWSER_URL is required before starting cloud capture' }, frontendOrigin)
      cloudCaptureClient.start()
      return jsonResponse(200, { ok: true, running: cloudCaptureClient.isRunning(), status: state.snapshot().status }, frontendOrigin)
    }
    if (method === 'POST' && pathname === '/api/cloud-capture/stop') {
      cloudCaptureClient.stop()
      return jsonResponse(200, { ok: true, running: cloudCaptureClient.isRunning(), status: state.snapshot().status }, frontendOrigin)
    }
    if (pathname === '/api/online-core/status') {
      try {
        const summary = await onlineCoreClient.getProjectSummary?.('ai-baccarat')
        return jsonResponse(200, { ...summary, connected: Boolean(summary?.connected ?? summary?.project) }, frontendOrigin)
      } catch (error) {
        return jsonResponse(200, { connected: false, configured: Boolean(onlineCoreClient?.configured), error: error?.message ?? String(error) }, frontendOrigin)
      }
    }
    if (pathname === '/api/online-core/memory-center') {
      try {
        const center = await onlineCoreClient.getMemoryCenter?.('ai-baccarat')
        return jsonResponse(200, { ...center, connected: Boolean(center?.connected ?? center?.project) }, frontendOrigin)
      } catch (error) {
        return jsonResponse(200, { connected: false, configured: Boolean(onlineCoreClient?.configured), items: [], reports: [], strategies: [], error: error?.message ?? String(error) }, frontendOrigin)
      }
    }
    if (pathname === '/api/online-core/strategy-analysis') {
      try {
        const analysis = await onlineCoreClient.getStrategyAnalysis?.('ai-baccarat')
        return jsonResponse(200, { ...analysis, connected: Boolean(analysis?.connected ?? analysis?.strategyRows) }, frontendOrigin)
      } catch (error) {
        return jsonResponse(200, { connected: false, configured: Boolean(onlineCoreClient?.configured), strategyRows: [], weakTables: [], strongTables: [], watchTables: [], suggestions: [], error: error?.message ?? String(error) }, frontendOrigin)
      }
    }
    if (method === 'POST' && pathname === '/api/online-core/settings') {
      try {
        const payload = parseJsonBody(rawBody)
        const result = await onlineCoreClient.updateAppSetting?.({ ...payload, updatedBy: payload.updatedBy ?? 'admin-ui' })
        return jsonResponse(200, { ok: true, result }, frontendOrigin)
      } catch (error) {
        return jsonResponse(400, { ok: false, error: error?.message ?? String(error) }, frontendOrigin)
      }
    }
    if (method === 'POST' && pathname === '/api/online-core/feature-flags') {
      try {
        const payload = parseJsonBody(rawBody)
        const result = await onlineCoreClient.updateFeatureFlag?.({ ...payload, updatedBy: payload.updatedBy ?? 'admin-ui' })
        return jsonResponse(200, { ok: true, result }, frontendOrigin)
      } catch (error) {
        return jsonResponse(400, { ok: false, error: error?.message ?? String(error) }, frontendOrigin)
      }
    }
    if (pathname === '/api/online-license/status') {
      try {
        return jsonResponse(200, await licenseAdminClient.getStatus?.(), frontendOrigin)
      } catch (error) {
        return jsonResponse(200, { configured: Boolean(licenseAdminClient?.configured), managers: [], agents: [], plans: [], licenses: [], error: error?.message ?? String(error) }, frontendOrigin)
      }
    }
    if (method === 'POST' && pathname === '/api/online-license/member-login') return adminWrite(() => licenseAdminClient.validateMemberLogin?.(parseJsonBody(rawBody)))
    if (method === 'POST' && pathname === '/api/online-license/agent-login') return adminWrite(() => licenseAdminClient.validateAgentLogin?.(parseJsonBody(rawBody)))
    if (method === 'POST' && pathname === '/api/online-license/bootstrap') return adminWrite(() => licenseAdminClient.bootstrap?.(parseJsonBody(rawBody)))
    if (method === 'POST' && pathname === '/api/online-license/agents') return adminWrite(() => licenseAdminClient.createAgent?.(parseJsonBody(rawBody)))
    if (method === 'POST' && pathname === '/api/online-license/licenses') return adminWrite(() => licenseAdminClient.createLicense?.(parseJsonBody(rawBody)))
    if (method === 'POST' && pathname === '/api/online-license/licenses/status') return adminWrite(() => licenseAdminClient.setLicenseStatus?.(parseJsonBody(rawBody)))
    if (method === 'POST' && pathname === '/api/online-license/licenses/extend') return adminWrite(() => licenseAdminClient.extendLicense?.(parseJsonBody(rawBody)))
    if (method === 'POST' && pathname === '/api/online-license/licenses/delete') return adminWrite(() => licenseAdminClient.deleteLicense?.(parseJsonBody(rawBody)))

    return jsonResponse(404, { error: 'Not Found' }, frontendOrigin)
  }

  async function persistCloudStateSnapshot(status) {
    if (!supabaseClient?.configured || typeof supabaseClient.writeCloudCaptureStatus !== 'function') return
    try {
      const snapshot = state.snapshot()
      const sessionId = status.captureSessionId ?? `${deployConfig.deployMode}-${captureSource}`
      await supabaseClient.writeCloudCaptureStatus({ sessionId, captureSource, status: snapshot.status })
      if (typeof supabaseClient.writeCloudTableSnapshot === 'function') {
        await supabaseClient.writeCloudTableSnapshot({ sessionId, tables: snapshot.tables, status: snapshot.status })
      }
      state.setStatus({ persistenceStatus: 'ok', persistenceError: null })
    } catch (error) {
      state.setStatus({ persistenceStatus: 'error', persistenceError: error?.message ?? String(error) })
    }
  }

  function buildCloudCaptureManagementStatus() {
    const snapshot = state.snapshot()
    return {
      ok: true,
      workerConfigured: Boolean(cloudBrowserUrl),
      running: cloudCaptureClient.isRunning(),
      captureSource,
      deployMode: deployConfig.deployMode,
      pollMs: deployConfig.cloudCapturePollMs,
      status: snapshot.status,
      tableCount: snapshot.tables.length,
    }
  }

  const server = http.createServer(async (req, res) => {
    const rawBody = await readRequestBody(req)
    const result = await handle(req.method ?? 'GET', req.url ?? '/', rawBody)
    res.writeHead(result.statusCode, result.headers)
    res.end(result.body)
  })

  return {
    state,
    server,
    start() {
      if (shouldAutoConnect) {
        if (captureSource === 'cloud_browser' && cloudBrowserUrl) cloudCaptureClient.start()
        else if (captureUrl) chromeClient.start()
        else mtClient.connect()
      }
      const host = process.env.HOST || (deployConfig.deployMode === 'cloud' ? '0.0.0.0' : '127.0.0.1')
      return new Promise((resolve) => server.listen(port, host, () => resolve(server)))
    },
    stop() {
      mtClient.stop()
      chromeClient.stop()
      cloudCaptureClient.stop()
      return new Promise((resolve) => server.close(() => resolve()))
    },
    async inject({ method = 'GET', url = '/', body = '' } = {}) {
      return handle(method, url, body)
    },
    cloudCaptureClient,
  }
}

function parseJsonBody(rawBody) {
  if (!rawBody) return {}
  return JSON.parse(rawBody)
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function jsonResponse(statusCode, payload, frontendOrigin = '*') {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': frontendOrigin,
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'Content-Type,Authorization',
    },
    body: JSON.stringify(payload),
  }
}

function htmlResponse(statusCode, body, frontendOrigin = '*') {
  return {
    statusCode,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'access-control-allow-origin': frontendOrigin,
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'Content-Type,Authorization',
    },
    body,
  }
}

function renderBackendHome({ deployMode, captureSource, frontendOrigin }) {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Darven AI 後端 API</title>
  <style>
    body{margin:0;background:#0b1020;color:#e5ecff;font-family:"Microsoft JhengHei",system-ui,sans-serif}
    main{max-width:920px;margin:0 auto;padding:48px 20px}
    .card{background:linear-gradient(135deg,#121a33,#0f172a);border:1px solid #263756;border-radius:20px;padding:28px;box-shadow:0 18px 60px #0008}
    h1{margin:0 0 8px;font-size:32px} .ok{color:#22c55e;font-weight:700}.muted{color:#9fb0d0}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin:24px 0}
    .box{background:#0b1226;border:1px solid #23324d;border-radius:14px;padding:16px}
    a{color:#7dd3fc;text-decoration:none} code{background:#020617;border:1px solid #1f2a44;padding:2px 6px;border-radius:6px}
  </style>
</head>
<body>
  <main>
    <section class="card">
      <div class="ok">● 後端 API 已上線</div>
      <h1>Darven AI 百家後端</h1>
      <p class="muted">這裡是 Render 後端，不是前台畫面。前台請開 Cloudflare Pages。</p>
      <div class="grid">
        <div class="box"><b>版本</b><br><code>042</code></div>
        <div class="box"><b>部署模式</b><br><code>${escapeHtml(deployMode)}</code></div>
        <div class="box"><b>抓取模式</b><br><code>${escapeHtml(captureSource)}</code></div>
        <div class="box"><b>允許前台</b><br><code>${escapeHtml(frontendOrigin)}</code></div>
      </div>
      <p><b>前台網址：</b> <a href="https://darven-ai-baccarat.pages.dev/">https://darven-ai-baccarat.pages.dev/</a></p>
      <p><b>API 檢查：</b> <a href="/health">/health</a>　<a href="/api/status">/api/status</a>　<a href="/api/tables">/api/tables</a></p>
    </section>
  </main>
</body>
</html>`
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  loadLocalEnv()
  const port = Number(process.env.PORT ?? 8787)
  const app = createApp({ port })
  app.start().then(() => {
    console.log(`${SERVICE} v${VERSION} 已啟動`)
    console.log(`本機 API: http://127.0.0.1:${port}`)
    console.log('健康檢查: /health')
    if (!process.env.MT_TOKEN && !process.env.CHROME_CAPTURE_URL) console.log('未設定 MT_TOKEN / CHROME_CAPTURE_URL，目前為測試/離線模式')
    if (process.env.MT_TOKEN) console.log(`MT_TOKEN 已載入：${maskToken(process.env.MT_TOKEN)}`)
    if (process.env.CHROME_CAPTURE_URL) console.log('Chrome背景抓取模式已啟用：CHROME_CAPTURE_URL 已載入')
  })
}
