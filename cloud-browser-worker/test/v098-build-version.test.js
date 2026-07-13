import test from 'node:test'
import assert from 'node:assert/strict'
import { BUILD_VERSION, publicBuildInfo } from '../src/runtime-config.js'

test('v098 worker exposes only build version 098 as public metadata', () => {
  assert.equal(BUILD_VERSION, '098')
  assert.deepEqual(publicBuildInfo(), { buildVersion: '098' })
})
