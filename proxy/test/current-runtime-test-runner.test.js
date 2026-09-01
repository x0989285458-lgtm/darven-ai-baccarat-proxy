import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  HISTORICAL_EXACT_RELEASE_TESTS,
  classifyProxyTests,
  discoverProxyTests,
} from '../scripts/test-classifier.mjs'
import { buildCurrentRuntimeTestArgs } from '../scripts/run-tests.mjs'

const proxyRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('canonical current-runtime discovery includes every present proxy test and no obsolete exact-release identity', () => {
  const discovered = discoverProxyTests(proxyRoot)
  const { currentRuntime, historicalExactRelease } = classifyProxyTests(discovered)

  assert.deepEqual(HISTORICAL_EXACT_RELEASE_TESTS, [])
  assert.deepEqual(historicalExactRelease, [])
  assert.deepEqual(currentRuntime, discovered)
  assert.equal(new Set(currentRuntime).size, discovered.length)
  assert.ok(currentRuntime.includes('test/current-runtime-test-runner.test.js'))
  assert.ok(currentRuntime.includes('test/security-contract.test.js'))
  assert.ok(currentRuntime.includes('test/v105-durable-source-fence.test.js'))
  const exactReleaseIdentityTests = currentRuntime.filter((relativePath) => (
    /^test\/v105-v10-main(?:\d+)?(?:-.+)?-release\.test\.js$/.test(relativePath)
  ))
  assert.deepEqual(exactReleaseIdentityTests, ['test/v105-v10-main91-current-runtime-isolation-release.test.js'])
})

test('runner places caller filters before discovered files and narrows explicit test paths', () => {
  const discovered = ['test/a.test.js', 'test/b.test.js']
  assert.deepEqual(
    buildCurrentRuntimeTestArgs(discovered, ['--test-name-pattern=canonical']),
    ['--test', '--test-name-pattern=canonical', ...discovered],
  )
  assert.deepEqual(
    buildCurrentRuntimeTestArgs(discovered, ['--test-name-pattern', 'canonical', 'test/b.test.js']),
    ['--test', '--test-name-pattern', 'canonical', 'test/b.test.js'],
  )
})

test('historical exact-release identity tests remain in immutable Git tags, not the current runtime tree', () => {
  assert.deepEqual(HISTORICAL_EXACT_RELEASE_TESTS, [])
})
