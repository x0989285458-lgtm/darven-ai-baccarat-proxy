import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createApp } from '../src/server.js'

test('Main33 retires V104 iteration shadow routes, env activation and writer calls', async () => {
  const server = await readFile(new URL('../src/server.js', import.meta.url), 'utf8')
  for (const token of [
    'v104-iteration-shadow-runtime', 'V104_ITERATION_SHADOW_ENABLED', 'v104IterationShadowRuntime',
    '/api/v104-iteration-shadow/', 'reviewV104IterationShadowSuggestion',
  ]) assert.equal(server.includes(token), false, token)
  const app = createApp({ autoConnect: false, production: false, requireVerifiedStrategy: false, memberAuthRequired: false })
  for (const url of [
    '/api/v104-iteration-shadow/control/status',
    '/api/v104-iteration-shadow/admin/status',
    '/api/v104-iteration-shadow/admin/reports/1/image.svg',
  ]) assert.equal((await app.inject({ url })).statusCode, 404, url)
  await app.stop()
})
