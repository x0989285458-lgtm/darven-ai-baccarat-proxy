import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ALL_MT_EQUAL_STRATEGY_VERSION } from '../src/supabase-writer.js'

const readJson = (relative) => JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8'))

test('outbox service continuity hotfix is package coherent and changes no prediction contract', () => {
  const manifest = readJson('../../release/v105-outbox-service-continuity-hotfix-release-manifest.json')
  const proxy = readJson('../package.json')
  const frontend = readJson('../../frontend/package.json')
  const worker = readJson('../../cloud-browser-worker/package.json')

  assert.equal(manifest.releaseName, 'v105抓牌Outbox服務不中斷修正版1')
  assert.equal(manifest.releaseVersion, 'v105-outbox-service-continuity.1')
  assert.equal(manifest.gitTag, 'v105-outbox-service-continuity.1')
  assert.equal(manifest.applicationVersion, '1.0.17')
  assert.equal(proxy.version, manifest.applicationVersion)
  assert.equal(frontend.version, manifest.applicationVersion)
  assert.equal(worker.version, manifest.applicationVersion)
  assert.equal(manifest.strategyVersion, ALL_MT_EQUAL_STRATEGY_VERSION)
  assert.equal(manifest.behavior.outboxClaimLimit, 1)
  assert.equal(manifest.behavior.formalIdentityConcurrency, 1)
  assert.equal(manifest.behavior.eventLoopYieldBetweenRows, true)
  assert.equal(manifest.behavior.eventLoopYieldBetweenIdentities, true)
  assert.equal(manifest.behavior.predictionRulesChanged, false)
  assert.equal(manifest.behavior.predictionWeightsChanged, false)
  assert.equal(manifest.behavior.settlementSemanticsChanged, false)
  assert.equal(manifest.databaseMigrationRequired, false)
  assert.deepEqual(manifest.deploymentOrder, [
    'proxy-render-exact-commit',
    'worker-vm-exact-commit',
    'frontend-pages-exact-commit',
    'watchdog-health-readback',
    'live-five-minute-e2e',
  ])
  assert.equal(manifest.rollback.preserveQueueCursorJournal, true)
  assert.equal(manifest.rollback.preserveOutboxHistory, true)
})

test('prior capture-liveness release manifest remains immutable historical evidence', () => {
  const prior = readJson('../../release/v105-capture-liveness-release-manifest.json')
  assert.equal(prior.applicationVersion, '1.0.16')
  assert.equal(prior.gitTag, 'v105-capture-liveness.1')
})
