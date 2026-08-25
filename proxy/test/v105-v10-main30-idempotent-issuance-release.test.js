import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const root = new URL('../../', import.meta.url)
const readJson = (path) => JSON.parse(readFileSync(new URL(path, root), 'utf8'))
const manifest = readJson('release/v105-v10-main30-idempotent-issuance-readback-release-manifest.json')
const report = readJson('release/v105-v10-main30-idempotent-issuance-readback-release-report.json')

const sha256 = (path) => createHash('sha256').update(readFileSync(new URL(path, root))).digest('hex')

test('Main30 binds the exact runtime files and immutable release identity', () => {
  assert.equal(manifest.releaseVersion, 'v105-v10-main.30')
  assert.equal(manifest.gitTag, 'v105-v10-main.30')
  assert.equal(manifest.applicationVersion, '1.0.66')
  assert.equal(manifest.baseCommit, '33f60a58f00726f7cba978f8e9c371257d58359d')
  assert.equal(readJson('proxy/package.json').version, '1.0.66')
  assert.equal(readJson('proxy/package-lock.json').version, '1.0.66')
  const render = readFileSync(new URL('proxy/deploy/render.yaml', root), 'utf8')
  assert.match(render, /darven-ai-baccarat-proxy:v105-v10-main\.30/)
  for (const [path, expected] of Object.entries(manifest.releaseBinding.changedFileSha256)) {
    assert.equal(sha256(path), expected, path)
  }
})

test('Main30 changes only Formal Consumer idempotent issuance resolution', () => {
  assert.equal(manifest.releaseScope.proxyChanged, true)
  assert.equal(manifest.releaseScope.formalConsumerChanged, true)
  assert.equal(manifest.releaseScope.workerChanged, false)
  assert.equal(manifest.releaseScope.frontendChanged, false)
  assert.equal(manifest.releaseScope.databaseChanged, false)
  assert.deepEqual(manifest.safetyContract.exactReadbackIdentity, ['tableId', 'shoe', 'nextRound', 'strategyVersion=v105'])
  assert.equal(manifest.safetyContract.durableValidation, 'isExactScreenPrediction')
  assert.equal(manifest.safetyContract.missingIssuance, 'fail-closed-retain-exact-lease')
  assert.equal(manifest.safetyContract.reconciliationFailure, 'fail-closed-retain-exact-lease')
  assert.equal(manifest.safetyContract.predictionRulesChanged, false)
  assert.equal(manifest.safetyContract.weightsChanged, false)
  assert.equal(manifest.safetyContract.thresholdsChanged, false)
})

test('Main30 production evidence records the reproduced incident without self-approval', () => {
  assert.equal(report.productionEvidence.main29Window, 'BLOCK')
  assert.equal(report.productionEvidence.verifiedDeadIdentities, 19)
  assert.equal(report.productionEvidence.settledFinalIdentities, 19)
  assert.equal(report.productionEvidence.durableNextIssuances, 19)
  assert.equal(report.tests.captureOutboxAck, '43/43 PASS')
  assert.equal(report.tests.proxyFullSerial, '1030/1030 PASS')
  assert.equal(report.productionGates.freshReview, 'PASS')
  assert.equal(report.productionGates.finalVerdict, 'BLOCK')
  for (const key of ['immutableImageBuild', 'formalConsumerDigestReadback', 'queueRecovery', 'tenTableLiveWindow', 'memberAgentBrowserE2E']) {
    assert.notEqual(report.productionGates[key], 'PASS', key)
  }
})
