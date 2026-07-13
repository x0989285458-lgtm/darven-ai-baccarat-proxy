import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'

test('v098 production fails closed when the ingest key is missing', async () => {
  const app = createApp({ autoConnect: false, production: true, ingestKey: '', memberAuthRequired: false })
  const headers = { 'x-forwarded-proto': 'https' }
  const ingest = await app.inject({ method: 'POST', url: '/api/cloud-ingest/snapshot', headers, body: '{}' })
  const health = await app.inject({ url: '/health', headers })
  assert.equal(ingest.statusCode, 503)
  assert.equal(health.statusCode, 503)
  assert.equal(JSON.parse(health.body).reason, 'ingest_key_missing')
})
