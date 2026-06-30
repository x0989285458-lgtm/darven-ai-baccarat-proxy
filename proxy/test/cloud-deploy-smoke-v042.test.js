import test from 'node:test'
import assert from 'node:assert/strict'
import { runCloudDeploySmoke } from '../src/cloud-deploy-smoke.js'

test('v042 cloud deployment smoke checks health, worker status, tick, and worker payload', async () => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET' })
    if (String(url).endsWith('/health')) return json(200, { ok: true, version: '042' })
    if (String(url).endsWith('/api/cloud-capture/status')) return json(200, { workerConfigured: true, running: false })
    if (String(url).endsWith('/api/cloud-capture/tick')) return json(200, { ok: true, status: { connected: true, authenticated: true, tableCount: 1 } })
    if (String(url).endsWith('/snapshot')) return json(200, { connected: true, authenticated: true, sessionId: 'worker-smoke', tables: [{ tableId: 'BAG01' }], rounds: [] })
    return json(404, { error: 'not found' })
  }

  const result = await runCloudDeploySmoke({
    apiBaseUrl: 'https://api.example.com/',
    workerUrl: 'https://worker.example.com/snapshot',
    expectedVersion: '042',
    fetchImpl,
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.failures, [])
  assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), [
    'GET https://api.example.com/health',
    'GET https://api.example.com/api/cloud-capture/status',
    'POST https://api.example.com/api/cloud-capture/tick',
    'GET https://worker.example.com/snapshot',
  ])
})

test('v042 cloud deployment smoke reports failures without throwing', async () => {
  const result = await runCloudDeploySmoke({
    apiBaseUrl: 'https://api.example.com',
    expectedVersion: '042',
    fetchImpl: async (url) => String(url).endsWith('/health') ? json(200, { ok: true, version: '041' }) : json(500, { error: 'bad' }),
  })

  assert.equal(result.ok, false)
  assert.match(result.failures.join('\n'), /version/)
  assert.match(result.failures.join('\n'), /cloud-capture status/)
})

function json(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}
