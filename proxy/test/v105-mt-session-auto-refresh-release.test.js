import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import manifest from '../../release/v105-mt-session-auto-refresh-release-manifest.json' with { type: 'json' }
import { computeGitTreePathSetDigest } from '../../scripts/verify-v105-mt-api-release.mjs'

const repoRoot = new URL('../../', import.meta.url)
const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))

test('MT session auto-refresh release freezes the two production incident fixes', () => {
  assert.equal(manifest.releaseVersion, 'v105-mt-session-auto-refresh.1')
  assert.equal(manifest.gitTag, manifest.releaseVersion)
  assert.equal(manifest.applicationVersion, '1.0.62')
  assert.equal(manifest.formalStrategyVersion, 'v105')
  assert.deepEqual(manifest.releaseScope, {
    workerOnlyBehaviorChange: true,
    canonicalSource: 'api',
    singleWriterRequired: true,
    databaseMigrationRequired: false,
    predictionRulesChanged: false,
    predictionWeightsChanged: false,
    frontendBehaviorChanged: false,
    proxyBehaviorChanged: false,
  })
  assert.equal(manifest.behavior.sessionRefreshFailureStopsWorker, false)
  assert.equal(manifest.behavior.sessionRefreshRetries, true)
  assert.equal(manifest.behavior.refreshRetryBackoff, 'bounded-exponential-capped')
  assert.equal(manifest.behavior.singleRefreshCycle, true)
  assert.equal(manifest.behavior.singleSocketGeneration, true)
  assert.equal(manifest.behavior.stopCancelsRefreshRetry, true)
  assert.equal(manifest.behavior.transientPopupNavigationFallback, 'bounded-https-url-poll')
  assert.equal(manifest.behavior.fallbackOnlyForExplicitAbortOrDetachedFrame, true)
  assert.equal(manifest.behavior.httpsRequired, true)
  assert.equal(manifest.behavior.mtHostAllowlistRequired, true)
  assert.equal(manifest.behavior.formalTenTableValidationRequired, true)
  assert.equal(manifest.behavior.atomicSessionPersistBeforeActivation, true)
  assert.equal(manifest.durability.preserveQueue, true)
  assert.equal(manifest.durability.preserveCursor, true)
  assert.equal(manifest.durability.preserveFinalJournal, true)
  assert.equal(manifest.durability.exactAckRequired, true)
  assert.deepEqual(manifest.deploymentOrder.slice(-4), [
    'new-final-exact-ack-db-readback',
    'v105-v9-v10-settlement-readback',
    'session-expiry-auto-refresh-soak',
    'member-session-frontend-e2e',
  ])
})

test('historical v105 worker release binding stays immutable after the v106 worker hotfix', async () => {
  assert.equal(readJson('../package.json').version, '1.0.97')
  assert.equal(readJson('../../frontend/package.json').version, '1.0.63')
  assert.equal(readJson('../../cloud-browser-worker/package.json').version, '1.0.63')
  const historicalTree = execFileSync('git', ['rev-parse', `${manifest.gitTag}^{tree}`], { cwd: repoRoot, encoding: 'utf8' }).trim()
  for (const key of ['implementationTree', 'workerBuildInput']) {
    const result = await computeGitTreePathSetDigest(repoRoot, historicalTree, manifest.releaseBinding[key])
    assert.equal(result.sha256, manifest.releaseBinding[key].sha256)
  }
})
