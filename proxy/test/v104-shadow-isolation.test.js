import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createApp } from '../src/server.js'

test('Main33 retires the V104 shadow server import, env switch, injection and route', async () => {
  const server = await readFile(new URL('../src/server.js', import.meta.url), 'utf8')
  for (const token of ['v104-shadow-runtime', 'V104_SHADOW_ENABLED', 'v104ShadowRuntime', '/api/v104-shadow/']) {
    assert.equal(server.includes(token), false, token)
  }
  let starts = 0
  const app = createApp({
    autoConnect: false, production: false, requireVerifiedStrategy: false, memberAuthRequired: false,
    v104ShadowRuntime: { enabled: true, start() { starts += 1 } },
  })
  assert.equal((await app.inject({ url: '/api/v104-shadow/status' })).statusCode, 404)
  await app.stop()
  assert.equal(starts, 0)
})
