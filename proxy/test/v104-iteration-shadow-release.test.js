import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const readJson = (relative) => JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8'))

test('seven-head shadow release is package-coherent and keeps formal v104 isolated', () => {
  const manifest = readJson('../../release/v104-seven-head-shadow-release-manifest.json')
  const frontend = readJson('../../frontend/package.json')
  const proxy = readJson('../package.json')
  const worker = readJson('../../cloud-browser-worker/package.json')
  assert.equal(manifest.releaseVersion, 'v104.1.0-seven-head-shadow.1')
  assert.equal(manifest.packageVersion, '1.0.13')
  assert.equal(frontend.version, manifest.packageVersion)
  assert.equal(proxy.version, manifest.packageVersion)
  assert.equal(worker.version, manifest.packageVersion)
  assert.equal(manifest.formalStrategyVersion, 'v104')
  assert.equal(manifest.shadowStrategyVersion, 'v104-seven-head-shadow-v1')
  assert.equal(manifest.shadowOnly, true)
  assert.equal(manifest.memberVisible, false)
  assert.equal(manifest.activationEligible, false)
  assert.equal(manifest.iteration.searchMethod, 'exhaustive_5_percent_grid')
  assert.equal(manifest.iteration.autoApply, false)
  assert.equal(manifest.database.gaplessTransactionalCounters, true)
})
