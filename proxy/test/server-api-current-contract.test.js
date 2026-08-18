import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'

test('health endpoint reports current v106 version', async () => {
  const app = createApp({ autoConnect: false })
  const health = await app.inject({ method: 'GET', url: '/health' })
  assert.equal(JSON.parse(health.body).version, 'v106')
})

test('cloud deployment listens on all interfaces unless HOST is overridden', async () => {
  const app = createApp({ autoConnect: false, deployMode: 'cloud', port: 0 })
  const server = await app.start()
  assert.equal(server.address().address, '0.0.0.0')
  await app.stop()
})

test('local deployment keeps loopback binding by default', async () => {
  const app = createApp({ autoConnect: false, deployMode: 'local', port: 0 })
  const server = await app.start()
  assert.equal(server.address().address, '127.0.0.1')
  await app.stop()
})
