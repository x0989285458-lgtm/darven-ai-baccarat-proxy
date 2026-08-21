import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'

test('proxy health and status expose the same build version', async () => {
  const app = createApp({ autoConnect: false })
  const health = JSON.parse((await app.inject({ url: '/health' })).body)
  const status = JSON.parse((await app.inject({ url: '/api/status' })).body)
  assert.equal(health.buildVersion, 'v106')
  assert.equal(status.buildVersion, 'v106')
  assert.equal(health.releaseVersion, 'v106.0.0-formal.34')
  assert.equal(status.releaseVersion, 'v106.0.0-formal.34')
  assert.equal(health.packageVersion, '1.0.91')
  assert.equal(status.packageVersion, '1.0.91')
  assert.equal(health.commit, null)
  assert.equal(status.commit, null)
})
