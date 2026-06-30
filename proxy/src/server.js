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
    if (pathname === '/api/cloud-data/status') {
      const snapshot = state.snapshot()
      try {
        const formalStatus = await licenseAdminClient.getCloudDataStatus?.()
        return jsonResponse(200, { ok: true, mtAutoLoginEnabled: false, ...formalStatus, captureSource, deployMode: deployConfig.deployMode, tableCount: snapshot.tables.length, status: snapshot.status }, frontendOrigin)
      } catch (error) {
        return jsonResponse(200, { ok: true, mtAutoLoginEnabled: false, captureSource, deployMode: deployConfig.deployMode, tableCount: snapshot.tables.length, status: snapshot.status, error: error?.message ?? String(error) }, frontendOrigin)
      }
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
    if (method === 'POST' && pathname === '/api/online-license/agents/delete') return adminWrite(() => licenseAdminClient.deleteAgents?.(parseJsonBody(rawBody)))
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
      return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
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
