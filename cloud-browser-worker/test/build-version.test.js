import test from 'node:test'
import assert from 'node:assert/strict'
import { BUILD_VERSION, publicBuildInfo } from '../src/runtime-config.js'

test('v104 worker exposes only build version 104 as public metadata', () => {
  assert.equal(BUILD_VERSION, '105')
  assert.deepEqual(publicBuildInfo(), { buildVersion: '105' })
})
