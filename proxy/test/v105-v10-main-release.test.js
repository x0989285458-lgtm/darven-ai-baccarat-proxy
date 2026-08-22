import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync(new URL('../../release/v105-v10-main-release-manifest.json', import.meta.url)))

test('V105 V10 main release changes prediction main only', () => {
  assert.equal(manifest.releaseVersion, 'v105-v10-main.3')
  assert.equal(manifest.formalStrategyVersion, 'v105')
  assert.deepEqual(manifest.releaseScope, {
    predictionMainOnly: true,
    productRuntimeChanged: true,
    databaseMigrationRequired: false,
    captureWorkerChanged: false,
    frontendChanged: false,
    sidePredictionChanged: false,
    formalIdentityChanged: false,
    zeroFinalHeartbeatFastAck: true,
  })
  assert.equal(manifest.prediction.mainSource, 'v105-shadow-v10-big-road-uncommon-structure-rank-synchronized')
  assert.equal(manifest.prediction.beadPlateUsed, false)
  assert.equal(manifest.prediction.sideOutputs, 'exact-existing-v105')
})

test('V105 V10 main release binding covers the exact prediction implementation', () => {
  assert.match(manifest.releaseBinding.implementationTree.sha256, /^[a-f0-9]{64}$/)
  for (const required of ['proxy/src/server.js', 'proxy/src/v105-formal-runtime.js', 'proxy/src/v105-v10-main-strategy.js', 'proxy/src/v105-shadow-v10-contract.js', 'proxy/src/v105-shadow-v10-structure.js']) {
    assert.ok(manifest.releaseBinding.implementationTree.paths.includes(required), required)
  }
})

test('V105 restore uses the immutable reviewed V106 terminalizer and rollback artifacts', () => {
  const root = new URL('../..', import.meta.url)
  const tag = manifest.rollbackFromCurrentV106.authorityTag
  for (const [pathKey, blobKey] of [['terminalizerPath', 'terminalizerBlob'], ['rollbackPath', 'rollbackBlob']]) {
    const actual = execFileSync('git', ['rev-parse', `${tag}:${manifest.rollbackFromCurrentV106[pathKey]}`], { cwd: root, encoding: 'utf8' }).trim()
    assert.equal(actual, manifest.rollbackFromCurrentV106[blobKey])
  }
  assert.deepEqual(manifest.deploymentOrder.slice(0, 6), [
    'verify-producer-stopped', 'archive-v106-backlog-evidence', 'run-bound-v106-terminalizer',
    'run-bound-v106-to-v105-rollback', 'verify-v105-sole-active', 'deploy-exact-v105-v10-main-proxy',
  ])
})
