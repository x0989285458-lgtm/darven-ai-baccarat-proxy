import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'

test('v042 health endpoint reports version 042', async () => {
  const app = createApp({ autoConnect: false })
  const response = await app.inject({ url: '/health' })
  assert.equal(response.statusCode, 200)
  assert.equal(JSON.parse(response.body).version, '042')
})

test('root endpoint renders backend landing page', async () => {
  const app = createApp({ autoConnect: false, deployMode: 'cloud', captureSource: 'offline', frontendOrigin: 'https://darven-ai-baccarat.pages.dev' })
  const response = await app.inject({ url: '/' })
  assert.equal(response.statusCode, 200)
  assert.match(response.headers['content-type'], /text\/html/)
  assert.match(response.body, /Darven AI 百家後端/)
  assert.match(response.body, /後端 API 已上線/)
})
