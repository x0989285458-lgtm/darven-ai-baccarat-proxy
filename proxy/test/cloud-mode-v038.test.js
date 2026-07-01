import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'
import { resolveDeployConfig } from '../src/config.js'

test('v038 resolveDeployConfig enables cloud mode without local chrome dependency', () => {
  const config = resolveDeployConfig({
    DEPLOY_MODE: 'cloud',
    CAPTURE_SOURCE: 'cloud_browser',
    PUBLIC_FRONTEND_ORIGIN: 'https://app.darvenai.example',
    CLOUD_BROWSER_URL: 'https://browser-worker.example/session/1',
  })

  assert.equal(config.deployMode, 'cloud')
  assert.equal(config.captureSource, 'cloud_browser')
  assert.equal(config.autoConnect, false)
  assert.equal(config.frontendOrigin, 'https://app.darvenai.example')
})

test('v038 cloud API status and empty tables are cloud-ready before worker is attached', async () => {
  const app = createApp({
    autoConnect: true,
    deployMode: 'cloud',
    captureSource: 'cloud_browser',
    frontendOrigin: 'https://app.darvenai.example',
    supabaseClient: { configured: false },
  })

  const status = await app.inject({ method: 'GET', url: '/api/status' })
  const statusBody = JSON.parse(status.body)
  assert.equal(status.headers['access-control-allow-origin'], 'https://app.darvenai.example')
  assert.equal(statusBody.deployMode, 'cloud')
  assert.equal(statusBody.captureSource, 'cloud_browser')
  assert.equal(statusBody.cloudReady, true)
  assert.match(statusBody.statusText, /雲端/)

  const tables = await app.inject({ method: 'GET', url: '/api/tables' })
  assert.deepEqual(JSON.parse(tables.body), [])
})
