import test from 'node:test'
import assert from 'node:assert/strict'
import { validateProductionConfig } from '../src/runtime-config.js'

test('v098 production worker refuses startup without every required secret and HTTPS target', () => {
  assert.throws(() => validateProductionConfig({ NODE_ENV: 'production' }), /WORKER_ADMIN_KEY, INGEST_KEY, PUSH_TARGET_URL/)
  assert.throws(() => validateProductionConfig({ NODE_ENV: 'production', WORKER_ADMIN_KEY: 'admin', INGEST_KEY: 'ingest', PUSH_TARGET_URL: 'http://proxy.example/ingest', MT_LOGIN_URL: 'https://mt.example/login' }), /HTTPS/)
})
