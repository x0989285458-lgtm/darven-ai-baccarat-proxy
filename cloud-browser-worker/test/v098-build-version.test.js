import test from 'node:test'
import assert from 'node:assert/strict'
import { BUILD_VERSION, publicBuildInfo } from '../src/runtime-config.js'

test('v100 worker exposes only build version 100 as public metadata', () => {
  assert.equal(BUILD_VERSION, '100')
  assert.deepEqual(publicBuildInfo(), { buildVersion: '100' })
})
