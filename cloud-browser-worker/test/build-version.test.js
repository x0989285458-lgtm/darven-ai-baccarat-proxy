import test from 'node:test'
import assert from 'node:assert/strict'
import { BUILD_VERSION, publicBuildInfo } from '../src/runtime-config.js'

test('v101 worker exposes only build version 101 as public metadata', () => {
  assert.equal(BUILD_VERSION, '101')
  assert.deepEqual(publicBuildInfo(), { buildVersion: '101' })
})
