import test from 'node:test'
import assert from 'node:assert/strict'
import { createOnlineCoreClient, buildMemoryReportRow } from '../src/online-core.js'
import { createApp } from '../src/server.js'

test('v024 online core client reads project settings and feature flags from Supabase REST', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options })
    if (String(url).includes('/memory_projects')) {
      return jsonResponse([{ id: 'project-1', slug: 'ai-baccarat', name: 'AI百家', status: 'active' }])
    }
    if (String(url).includes('/online_app_settings')) {
      return jsonResponse([{ scope: 'frontend', key: 'ui_defaults', is_public: true, value: { siteTitle: 'AI預測百家' } }])
    }
    if (String(url).includes('/feature_flags')) {
      return jsonResponse([{ flag_key: 'memory_center', enabled: true }])
    }
    return jsonResponse([])
  }

  const client = createOnlineCoreClient({ url: 'https://example.supabase.co', serviceKey: 'secret-key', dbConnectionString: '', fetchImpl })
  const summary = await client.getProjectSummary('ai-baccarat')

  assert.equal(summary.configured, true)
  assert.equal(summary.project.slug, 'ai-baccarat')
  assert.equal(summary.settings.frontend.ui_defaults.siteTitle, 'AI預測百家')
  assert.equal(summary.featureFlags.memory_center, true)
  assert.ok(calls.every((call) => call.options.headers.apikey === 'secret-key'))
})

test('v024 online core client writes stable report summaries to memory_test_reports', async () => {
  const requests = []
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null, method: options.method })
    if (String(url).includes('/memory_projects')) {
      return jsonResponse([{ id: 'project-1', slug: 'ai-baccarat' }])
    }
    if (String(url).includes('/memory_test_reports')) return jsonResponse([])
    return jsonResponse([])
  }
  const client = createOnlineCoreClient({ url: 'https://example.supabase.co', serviceKey: 'secret-key', dbConnectionString: '', fetchImpl })
  const result = await client.persistTestReport({
    strategyVersion: 'v023',
    reportType: 'live_300',
    total: { rounds: 300, hits: 144, misses: 140, pushes: 16, mainEvaluated: 284, hitRate: 50.7, sideActions: 246, sideHits: 18, sideHitRate: 7.3 },
    reportPath: 'reports/draven-v023-300-round-report.png',
  })

  assert.equal(result.ok, true)
  const insert = requests.find((request) => request.url.includes('/memory_test_reports'))
  assert.equal(insert.method, 'POST')
  assert.equal(insert.body.project_id, 'project-1')
  assert.equal(insert.body.rounds, 300)
  assert.equal(insert.body.main_hit_rate, 50.7)
})

test('v024 server exposes online core status endpoint', async () => {
  const onlineCoreClient = {
    configured: true,
    async getProjectSummary() {
      return {
        configured: true,
        project: { slug: 'ai-baccarat', name: 'AI百家', status: 'active' },
        settings: { frontend: { ui_defaults: { siteTitle: 'AI預測百家' } } },
        featureFlags: { memory_center: true },
      }
    },
  }
  const app = createApp({ autoConnect: false, onlineCoreClient })
  const response = await app.inject({ method: 'GET', url: '/api/online-core/status' })
  const body = JSON.parse(response.body)

  assert.equal(response.statusCode, 200)
  assert.equal(body.connected, true)
  assert.equal(body.project.slug, 'ai-baccarat')
  assert.equal(body.featureFlags.memory_center, true)
})

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload },
    async text() { return JSON.stringify(payload) },
  }
}
