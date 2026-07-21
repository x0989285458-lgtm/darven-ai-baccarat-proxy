import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'

test('proxy health and status expose the same build version', async () => {
  const app = createApp({ autoConnect: false })
  const health = JSON.parse((await app.inject({ url: '/health' })).body)
  const status = JSON.parse((await app.inject({ url: '/api/status' })).body)
  assert.equal(health.buildVersion, 'v104')
  assert.equal(status.buildVersion, 'v104')
})
