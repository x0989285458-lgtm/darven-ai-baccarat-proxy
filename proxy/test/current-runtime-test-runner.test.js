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

test('canonical current-runtime discovery accounts for every proxy test and excludes only audited exact-release identities', () => {
  const discovered = discoverProxyTests(proxyRoot)
  const { currentRuntime, historicalExactRelease } = classifyProxyTests(discovered)

  assert.deepEqual(historicalExactRelease, [...HISTORICAL_EXACT_RELEASE_TESTS])
  assert.equal(currentRuntime.length + historicalExactRelease.length, discovered.length)
  assert.equal(new Set([...currentRuntime, ...historicalExactRelease]).size, discovered.length)
  assert.ok(currentRuntime.includes('test/current-runtime-test-runner.test.js'))
  assert.ok(currentRuntime.includes('test/security-contract.test.js'))
  assert.ok(currentRuntime.includes('test/v105-durable-source-fence.test.js'))
  assert.ok(!currentRuntime.includes('test/v105-v10-main60-formal-batch30-release.test.js'))
  assert.ok(!discovered.includes('test/v102-release-integrity.test.js'))
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

test('audited historical classifier contains only immutable exact-release identity tests', () => {
  for (const relativePath of HISTORICAL_EXACT_RELEASE_TESTS) {
    assert.match(relativePath, /^test\/v105-v10-main\d+-.+-release\.test\.js$/)
  }
})
