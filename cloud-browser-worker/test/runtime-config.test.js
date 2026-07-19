import test from 'node:test'
import assert from 'node:assert/strict'
import * as runtimeConfig from '../src/runtime-config.js'
import { BUILD_VERSION, publicBuildInfo, validateProductionConfig } from '../src/runtime-config.js'

test('production refuses startup unless all worker security and push settings exist', () => {
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
    MT_LOGIN_URL: 'https://mt.example.invalid/login',
  }))
})

test('v101 exposes only a secret-free public build version', () => {
  assert.equal(BUILD_VERSION, '101')
  assert.deepEqual(publicBuildInfo(), { buildVersion: '101' })
})

test('production requires an HTTPS MT login URL', () => {
  const base = {
    NODE_ENV: 'production',
    WORKER_ADMIN_KEY: 'admin',
    INGEST_KEY: 'ingest',
    PUSH_TARGET_URL: 'https://example.invalid/ingest',
  }
  assert.throws(() => validateProductionConfig(base), /MT_LOGIN_URL/)
  assert.throws(() => validateProductionConfig({ ...base, MT_LOGIN_URL: 'http://mt.example/login' }), /MT_LOGIN_URL must use HTTPS/)
  assert.doesNotThrow(() => validateProductionConfig({ ...base, MT_LOGIN_URL: 'https://mt.example/login' }))
})

test('MT navigation final URL must retain the configured HTTPS origin', () => {
  assert.doesNotThrow(() => runtimeConfig.assertMtFinalUrl?.('https://mt.example/login', 'https://mt.example/game'))
  assert.throws(() => runtimeConfig.assertMtFinalUrl?.('https://mt.example/login', 'https://evil.example/game'), /origin/)
  assert.throws(() => runtimeConfig.assertMtFinalUrl?.('https://mt.example/login', 'http://mt.example/game'), /HTTPS/)
})

test('MT navigation rejects every redirect chain including same-origin redirects', () => {
  assert.equal(typeof runtimeConfig.assertMtNavigationResponse, 'function')
  assert.doesNotThrow(() => runtimeConfig.assertMtNavigationResponse({ request: () => ({ redirectedFrom: () => null }) }))
  assert.throws(
    () => runtimeConfig.assertMtNavigationResponse({ request: () => ({ redirectedFrom: () => ({ url: () => 'https://mt.example/login' }) }) }),
    /redirect/i,
  )
})

test('capture session id deterministically appends the page generation to its base id', () => {
  assert.equal(runtimeConfig.captureSessionId?.('darven-worker', 3), 'darven-worker-3')
})
