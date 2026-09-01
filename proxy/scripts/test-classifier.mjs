import { readdirSync } from 'node:fs'
import path from 'node:path'

// Audited release-identity tests. Each entry binds an obsolete candidate to an
// exact parent/delta and is intentionally separate from current runtime gates.
export const HISTORICAL_EXACT_RELEASE_TESTS = Object.freeze([
  'test/v105-v10-main31-trusted-workflow-release.test.js',
  'test/v105-v10-main50-lifecycle-hotpath-release.test.js',
  'test/v105-v10-main54-batch100-release.test.js',
  'test/v105-v10-main56-adaptive-batch-release.test.js',
  'test/v105-v10-main57-migration-ci-release.test.js',
  'test/v105-v10-main58-node24-migration-release.test.js',
  'test/v105-v10-main59-formal-lifecycle-priority-release.test.js',
  'test/v105-v10-main60-formal-batch30-release.test.js',
  'test/v105-v10-main61-three-tier-adaptive-batch-release.test.js',
  'test/v105-v10-main62-typed-migration-harness-release.test.js',
])

const historicalExactReleaseSet = new Set(HISTORICAL_EXACT_RELEASE_TESTS)
const normalize = (value) => value.split(path.sep).join('/')

export function discoverProxyTests(proxyRoot) {
  const testRoot = path.join(proxyRoot, 'test')
  const discovered = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(absolutePath)
      else if (entry.isFile() && entry.name.endsWith('.test.js')) {
        discovered.push(normalize(path.relative(proxyRoot, absolutePath)))
      }
    }
  }
  visit(testRoot)
  return discovered.sort()
}

export function classifyProxyTests(discovered) {
  const currentRuntime = []
  const historicalExactRelease = []
  for (const relativePath of discovered) {
    if (historicalExactReleaseSet.has(relativePath)) historicalExactRelease.push(relativePath)
    else currentRuntime.push(relativePath)
  }
  return { currentRuntime, historicalExactRelease }
}
