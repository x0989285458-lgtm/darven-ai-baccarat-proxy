import test from 'node:test'
import assert from 'node:assert/strict'
import { createOnlineCoreClient } from '../src/online-core.js'
import { createApp } from '../src/server.js'

test('v025 online core client updates app settings through backend-only writer', async () => {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : null })
    if (String(url).includes('/memory_projects')) return jsonResponse([{ id: 'project-1', slug: 'ai-baccarat' }])
    if (String(url).includes('/online_app_settings')) return jsonResponse([{ id: 'setting-1' }])
    return jsonResponse([])
  }
  const client = createOnlineCoreClient({ url: 'https://example.supabase.co', serviceKey: 'secret-key', dbConnectionString: '', fetchImpl })
  const result = await client.updateAppSetting({ scope: 'frontend', key: 'ui_defaults', value: { maintenanceMode: true }, isPublic: true, updatedBy: 'Faker' })
  assert.equal(result.ok, true)
  const upsert = calls.find((call) => call.url.includes('/online_app_settings'))
  assert.equal(upsert.method, 'POST')
  assert.equal(upsert.body.project_id, 'project-1')
  assert.equal(upsert.body.scope, 'frontend')
  assert.equal(upsert.body.key, 'ui_defaults')
  assert.equal(upsert.body.value.maintenanceMode, true)
  assert.equal(upsert.body.is_public, true)
})

test('v025 online core client toggles feature flags through backend-only writer', async () => {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : null })
    if (String(url).includes('/memory_projects')) return jsonResponse([{ id: 'project-1', slug: 'ai-baccarat' }])
    if (String(url).includes('/feature_flags')) return jsonResponse([{ id: 'flag-1' }])
    return jsonResponse([])
  }
  const client = createOnlineCoreClient({ url: 'https://example.supabase.co', serviceKey: 'secret-key', dbConnectionString: '', fetchImpl })
  const result = await client.updateFeatureFlag({ flagKey: 'cloud_capture', enabled: true, updatedBy: 'Faker' })
  assert.equal(result.ok, true)
  const upsert = calls.find((call) => call.url.includes('/feature_flags'))
  assert.equal(upsert.method, 'POST')
  assert.equal(upsert.body.project_id, 'project-1')
  assert.equal(upsert.body.flag_key, 'cloud_capture')
  assert.equal(upsert.body.enabled, true)
})

test('v025 server accepts admin setting and feature flag updates', async () => {
  const writes = []
  const onlineCoreClient = {
    configured: true,
    async updateAppSetting(input) { writes.push({ kind: 'setting', input }); return { ok: true, row: input } },
    async updateFeatureFlag(input) { writes.push({ kind: 'flag', input }); return { ok: true, row: input } },
  }
  const app = createApp({ autoConnect: false, onlineCoreClient })
  const setting = await app.inject({ method: 'POST', url: '/api/online-core/settings', body: JSON.stringify({ scope: 'frontend', key: 'ui_defaults', value: { maintenanceMode: true }, isPublic: true }) })
  const flag = await app.inject({ method: 'POST', url: '/api/online-core/feature-flags', body: JSON.stringify({ flagKey: 'cloud_capture', enabled: true }) })
  assert.equal(setting.statusCode, 200)
  assert.equal(flag.statusCode, 200)
  assert.deepEqual(writes.map((write) => write.kind), ['setting', 'flag'])
})

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload },
    async text() { return JSON.stringify(payload) },
  }
}
