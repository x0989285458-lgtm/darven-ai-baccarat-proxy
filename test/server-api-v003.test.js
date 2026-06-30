import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'

test('v042 health endpoint reports version 042', async () => {
  const app = createApp({ autoConnect: false })
  const health = await app.inject({ method: 'GET', url: '/health' })
  assert.equal(JSON.parse(health.body).version, '042')
})
