import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))

test('service work scheduler release freezes strategy while bounding proxy work', () => {
  const manifest = readJson('../../release/v105-service-work-scheduler-release-manifest.json')
  assert.equal(manifest.releaseName, 'v105服務工作單工穩定修正版1')
  assert.equal(manifest.releaseVersion, 'v105-service-work-scheduler.1')
  assert.equal(manifest.gitTag, 'v105-service-work-scheduler.1')
  assert.equal(manifest.applicationVersion, '1.0.18')
  assert.equal(manifest.strategyVersion, 'v105')
  assert.equal(manifest.protocolVersion, 'v105')
  assert.equal(manifest.databaseMigrationRequired, false)
  assert.equal(manifest.behavior.formalSettlementConcurrency, 1)
  assert.equal(manifest.behavior.serviceWorkConcurrency, 1)
  assert.equal(manifest.behavior.shadowWorkConcurrency, 1)
  assert.equal(manifest.behavior.formalAckWaitsForShadow, false)
  assert.equal(manifest.behavior.retainFinalBehindTimedOutShadowWork, true)
  assert.equal(manifest.behavior.priorityBurstLimit, 4)
  assert.equal(manifest.behavior.shadowServiceWorkTimeoutMs, 2000)
  assert.equal(manifest.behavior.shadowShutdownDeadlineMs, 5000)
  assert.equal(manifest.behavior.outboxCompletionWaitsForShadowDrain, true)
  assert.equal(manifest.behavior.permanentHangRetainedByDurableOutbox, true)
  assert.equal(manifest.behavior.shadowIsolation, 'child_process_fork')
  assert.equal(manifest.behavior.oneIpcBatchPerOutboxLease, true)
  assert.equal(manifest.behavior.killChildOnTimeoutOrAbort, true)
  assert.equal(manifest.behavior.secretsOverIpc, false)
  assert.equal(manifest.behavior.childEnvironmentAllowlist, true)
  assert.equal(manifest.behavior.exactLeaseAbsoluteDeadlineFence, true)
  assert.equal(manifest.behavior.childExitConfirmedBeforeLeaseFailure, true)
  assert.equal(manifest.behavior.formalEnrichedTablesSentToChild, true)
  assert.equal(manifest.behavior.schedulerRejectsAfterClosing, true)
  assert.equal(manifest.behavior.staleIssuanceReconcilesLatest, true)
  assert.equal(manifest.behavior.coalesceLatestTableObservation, true)
  assert.equal(manifest.behavior.waitForServiceWorkOnShutdown, true)
  assert.equal(manifest.behavior.rejectStaleScreenIssuance, true)
  assert.equal(manifest.behavior.predictionRulesChanged, false)
  assert.equal(manifest.behavior.predictionWeightsChanged, false)
  assert.equal(manifest.behavior.settlementSemanticsChanged, false)
})

test('all deployable packages use application version 1.0.18', () => {
  for (const path of ['../package.json', '../../frontend/package.json', '../../cloud-browser-worker/package.json']) {
    assert.equal(readJson(path).version, '1.0.18')
  }
})
