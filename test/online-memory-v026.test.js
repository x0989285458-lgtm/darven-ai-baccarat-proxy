import test from 'node:test'
import assert from 'node:assert/strict'
import { createOnlineCoreClient } from '../src/online-core.js'
import { createApp } from '../src/server.js'

test('v026 online core client lists memory center items reports and strategies', async () => {
  const fetchImpl = async (url) => {
    const text = String(url)
    if (text.includes('/memory_projects')) return jsonResponse([{ id: 'project-1', slug: 'ai-baccarat', name: 'AI百家' }])
    if (text.includes('/memory_items')) return jsonResponse([{ title: 'AI百家線上化方向', item_type: 'decision', content: { mode: 'online-first' }, updated_at: '2026-06-29T00:00:00Z' }])
    if (text.includes('/memory_test_reports')) return jsonResponse([{ strategy_version: 'v023', rounds: 300, main_hit_rate: 50.7, side_hit_rate: 7.3, created_at: '2026-06-29T00:00:00Z' }])
    if (text.includes('/memory_strategy_versions')) return jsonResponse([{ version: 'v023', status: 'active', weights: { roadTrend: 1 }, created_at: '2026-06-29T00:00:00Z' }])
    return jsonResponse([])
  }
  const client = createOnlineCoreClient({ url: 'https://example.supabase.co', serviceKey: 'secret-key', dbConnectionString: '', fetchImpl })
  const center = await client.getMemoryCenter()
  assert.equal(center.project.slug, 'ai-baccarat')
  assert.equal(center.items[0].title, 'AI百家線上化方向')
  assert.equal(center.reports[0].rounds, 300)
  assert.equal(center.strategies[0].version, 'v023')
})

test('v026 server exposes memory center list endpoint', async () => {
  const onlineCoreClient = {
    configured: true,
    async getMemoryCenter() {
      return {
        project: { slug: 'ai-baccarat', name: 'AI百家' },
        items: [{ title: '線上化方向', item_type: 'decision' }],
        reports: [{ strategy_version: 'v023', rounds: 300, main_hit_rate: 50.7 }],
        strategies: [{ version: 'v023', status: 'active' }],
      }
    },
  }
  const app = createApp({ autoConnect: false, onlineCoreClient })
  const response = await app.inject({ method: 'GET', url: '/api/online-core/memory-center' })
  const body = JSON.parse(response.body)
  assert.equal(response.statusCode, 200)
  assert.equal(body.project.slug, 'ai-baccarat')
  assert.equal(body.items.length, 1)
  assert.equal(body.reports.length, 1)
  assert.equal(body.strategies.length, 1)
})

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload },
    async text() { return JSON.stringify(payload) },
  }
}
