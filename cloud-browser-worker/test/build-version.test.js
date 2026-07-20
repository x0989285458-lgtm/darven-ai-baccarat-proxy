import test from 'node:test'
import assert from 'node:assert/strict'
import { BUILD_VERSION, publicBuildInfo } from '../src/runtime-config.js'

test('v102 worker exposes only build version 102 as public metadata', () => {
  assert.equal(BUILD_VERSION, '102')
  assert.deepEqual(publicBuildInfo(), { buildVersion: '102' })
})
