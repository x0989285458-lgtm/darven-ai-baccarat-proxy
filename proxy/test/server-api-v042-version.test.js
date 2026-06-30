import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'

test('v042 health endpoint reports version 042', async () => {
  const app = createApp({ autoConnect: false })
  const response = await app.inject({ url: '/health' })
  assert.equal(response.statusCode, 200)
  assert.equal(JSON.parse(response.body).version, '042')
})
