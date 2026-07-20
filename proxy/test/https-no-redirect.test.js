import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'
import { createCloudCaptureClient } from '../src/cloud-capture.js'

test('production rejects HTTP and outbound capture forbids redirects', async () => {
  const app = createApp({ autoConnect: false, production: true, memberAuthRequired: false })
  const response = await app.inject({ url: '/health', headers: { 'x-forwarded-proto': 'http' } })
  assert.equal(response.statusCode, 426)
  assert.equal(response.headers.location, undefined)
  let init
  const client = createCloudCaptureClient({ url: 'https://worker.example/snapshot', state: { setStatus() {}, setTables() {}, upsertRoundEvent() {} }, requestRetries: 1,
    fetchImpl: async (_url, options) => { init = options; return { ok: true, json: async () => ({ buildVersion: '102', tables: [], rounds: [] }) } },
  })
  await client.tick()
  assert.equal(init.redirect, 'error')
})
