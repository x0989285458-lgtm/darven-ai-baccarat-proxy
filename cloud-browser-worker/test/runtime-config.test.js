import test from 'node:test'
import assert from 'node:assert/strict'
import * as runtimeConfig from '../src/runtime-config.js'
import { BUILD_VERSION, publicBuildInfo, validateProductionConfig } from '../src/runtime-config.js'

test('v098 production refuses startup unless all worker security and push settings exist', () => {
  assert.throws(
    () => validateProductionConfig({ NODE_ENV: 'production' }),
    /WORKER_ADMIN_KEY, INGEST_KEY, PUSH_TARGET_URL/,
  )
  assert.throws(
    () => validateProductionConfig({
      NODE_ENV: 'production',
      WORKER_ADMIN_KEY: 'admin',
      PUSH_KEY: 'legacy-does-not-replace-ingest-key',
      PUSH_TARGET_URL: 'https://example.invalid/ingest',
    }),
    /INGEST_KEY/,
  )
  assert.doesNotThrow(() => validateProductionConfig({ NODE_ENV: 'development' }))
  assert.doesNotThrow(() => validateProductionConfig({
    NODE_ENV: 'production',
    WORKER_ADMIN_KEY: 'admin',
    INGEST_KEY: 'ingest',
    PUSH_TARGET_URL: 'https://example.invalid/ingest',
  }))
})

test('v098 exposes only a secret-free public build version', () => {
  assert.equal(BUILD_VERSION, 'v098')
  assert.deepEqual(publicBuildInfo(), { buildVersion: 'v098' })
})

test('capture session id deterministically appends the page generation to its base id', () => {
  assert.equal(runtimeConfig.captureSessionId?.('darven-worker', 3), 'darven-worker-3')
})
