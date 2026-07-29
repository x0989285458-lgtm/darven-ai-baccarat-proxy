import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { V105_FORMAL_RELEASE_VERSION } from '../src/v105-formal-strategy.js'

const readJson = (relative) => JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8'))

test('capture liveness release remains immutable historical evidence and changes no formal strategy', () => {
  const manifest = readJson('../../release/v105-capture-liveness-release-manifest.json')

  assert.equal(manifest.releaseName, 'v105抓牌終局同步與假活根治版1')
  assert.equal(manifest.releaseVersion, 'v105-capture-liveness.1')
  assert.equal(manifest.gitTag, 'v105-capture-liveness.1')
  assert.equal(manifest.applicationVersion, '1.0.16')
  assert.equal(manifest.strategyVersion, 'v105')
  assert.equal(manifest.formalStrategyReleaseVersion, V105_FORMAL_RELEASE_VERSION)
  assert.equal(manifest.qualityGates.formalStrategyChanged, false)
  assert.equal(manifest.qualityGates.predictionWeightsChanged, false)
  assert.equal(manifest.qualityGates.databaseMigrationRequired, false)
  assert.equal(manifest.rollback.preserveQueueCursorJournal, true)
  assert.equal(manifest.rollback.neverDeleteDurableQueue, true)
  assert.deepEqual(manifest.deploymentOrder, [
    'worker-vm-exact-commit',
    'proxy-render-exact-commit',
    'frontend-pages-exact-commit',
    'watchdog-health-readback',
    'live-five-minute-e2e',
  ])
})
