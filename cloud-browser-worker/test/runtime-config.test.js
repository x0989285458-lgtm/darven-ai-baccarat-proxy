import test from 'node:test'
import assert from 'node:assert/strict'
import * as runtimeConfig from '../src/runtime-config.js'
import { BUILD_VERSION, publicBuildInfo, validateProductionConfig, validateReleaseRuntimeScope } from '../src/runtime-config.js'

test('Reviewer P1 runtime scope: release 1.0.26 permits only API canonical with empty backup environment', () => {
  assert.doesNotThrow(() => validateReleaseRuntimeScope({ MT_SOURCE_MODE: 'api', MT_CAPTURE_ROLE: 'canonical' }))
  assert.throws(() => validateReleaseRuntimeScope({ MT_SOURCE_MODE: 'browser', MT_CAPTURE_ROLE: 'canonical' }), /release_runtime_source_mode_must_be_api/)
  assert.throws(() => validateReleaseRuntimeScope({ MT_SOURCE_MODE: 'api', MT_CAPTURE_ROLE: 'backup-journal' }), /release_runtime_capture_role_must_be_canonical/)
  assert.throws(() => validateReleaseRuntimeScope({
    MT_SOURCE_MODE: 'api', MT_CAPTURE_ROLE: 'canonical', MT_BACKUP_FINAL_JOURNAL_PATH: 'stale.jsonl',
  }), /release_runtime_backup_environment_must_be_empty/)
  assert.throws(() => validateReleaseRuntimeScope({
    MT_SOURCE_MODE: 'api', MT_CAPTURE_ROLE: 'canonical', MT_BACKUP_SESSION_TOKEN_FILE: 'stale-token-file',
  }), /release_runtime_backup_environment_must_be_empty/)
})

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

test('v104 exposes only the secret-free public build version 104', () => {
  assert.equal(BUILD_VERSION, '105')
  assert.deepEqual(publicBuildInfo(), { buildVersion: '105' })
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
