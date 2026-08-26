import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createApp } from '../src/server.js'

test('Main33 server has no isolated shadow process import, env switch, route, or injectable startup path', async () => {
  const server = await readFile(new URL('../src/server.js', import.meta.url), 'utf8')
  for (const token of [
    'shadow-process-client', 'SHADOW_PROCESS_ENABLED', 'V103_SHADOW_ENABLED',
    'V104_SHADOW_ENABLED', 'V104_ITERATION_SHADOW_ENABLED',
    'V105_SHADOW_V9_ENABLED', 'V105_SHADOW_V10_ENABLED',
    '/api/v103-shadow/', '/api/v104-shadow/', '/api/v104-iteration-shadow/',
  ]) assert.equal(server.includes(token), false, token)

  let shadowCalls = 0
  const retiredProcessClient = new Proxy({}, {
    get() {
      shadowCalls += 1
      return () => { shadowCalls += 1 }
    },
  })
  const app = createApp({
    autoConnect: false,
    production: false,
    memberAuthRequired: false,
    requireVerifiedStrategy: false,
    isolateShadowProcess: true,
    shadowProcessClient: retiredProcessClient,
    supabaseClient: {
      configured: true,
      async claimCaptureOutbox() { return [] },
      async readIssuedPrediction() { return null },
    },
    v100FormalRuntime: { enabled: false },
  })

  assert.deepEqual(await app.drainCaptureOutbox(), { processed: 0, failed: 0 })
  assert.equal(shadowCalls, 0)
  assert.equal((await app.inject({ url: '/api/v103-shadow/status' })).statusCode, 404)
  assert.equal((await app.inject({ url: '/api/v104-shadow/status' })).statusCode, 404)
  assert.equal((await app.inject({ url: '/api/v104-iteration-shadow/admin/status' })).statusCode, 404)
  await app.stop()
  assert.equal(shadowCalls, 0)
})
