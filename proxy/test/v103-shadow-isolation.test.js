import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createApp } from '../src/server.js'

test('Main33 retires the V103 shadow server import, env switch, injection and route', async () => {
  const server = await readFile(new URL('../src/server.js', import.meta.url), 'utf8')
  for (const token of ['v103-shadow-runtime', 'V103_SHADOW_ENABLED', 'v103ShadowRuntime', '/api/v103-shadow/']) {
    assert.equal(server.includes(token), false, token)
  }
  let starts = 0
  const app = createApp({
    autoConnect: false, production: false, requireVerifiedStrategy: false, memberAuthRequired: false,
    v103ShadowRuntime: { enabled: true, start() { starts += 1 } },
  })
  assert.equal((await app.inject({ url: '/api/v103-shadow/status' })).statusCode, 404)
  await app.stop()
  assert.equal(starts, 0)
})
