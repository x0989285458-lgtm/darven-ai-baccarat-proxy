import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('v042 package exposes cloud deployment smoke and mock worker commands', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.version, '0.42.0')
  assert.equal(pkg.scripts['smoke:cloud'], 'node scripts/smoke-cloud-deploy.mjs')
  assert.equal(pkg.scripts['mock:cloud-worker'], 'node scripts/mock-cloud-worker.mjs')
})
