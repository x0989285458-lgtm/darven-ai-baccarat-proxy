import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'

test('v098.23 proxy health and status expose the same build version', async () => {
  const app = createApp({ autoConnect: false })
  const health = JSON.parse((await app.inject({ url: '/health' })).body)
  const status = JSON.parse((await app.inject({ url: '/api/status' })).body)
  assert.equal(health.buildVersion, 'v100')
  assert.equal(status.buildVersion, 'v100')
})
