import { readdirSync } from 'node:fs'
import path from 'node:path'

// Exact release-identity tests belong only to their immutable tags. They are
// deleted from the next current tree, so old releases cannot gate new runtime.
export const HISTORICAL_EXACT_RELEASE_TESTS = Object.freeze([])

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
  return { currentRuntime: [...discovered], historicalExactRelease: [] }
}
