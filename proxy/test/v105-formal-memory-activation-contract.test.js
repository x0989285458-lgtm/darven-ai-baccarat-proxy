import test from 'node:test'
import assert from 'node:assert/strict'

const activationModule = await import('../src/formal-memory-activation.js').catch(() => ({}))

test('formal release memory activation fails closed until live E2E passes all 10 tables', async () => {
  assert.equal(typeof activationModule.activateFormalReleaseMemory, 'function', 'formal release memory activation is not implemented')

  const writes = []
  const onlineCoreClient = {
    async upsertStrategyVersion(input) {
      writes.push(input)
      return { ok: true, row: input }
    },
  }
  const manifest = {
    releaseVersion: 'v105.0.0-formal.14',
    strategyVersion: 'v105',
    candidateMode: 'formal',
    formalActionsEnabled: true,
    memoryActivation: {
      name: '瑞文AI百家正式策略',
      mainWeights: { 路單趨勢訊號: 0.275, 問路訊號: 0.275, 靴局莊閒偏差: 0.35, 中性保留: 0.1 },
      sideThresholds: { 和: 30, 超六: 50, 莊對: 50, 閒對: 50, 莊龍寶: 40, 閒龍寶: 40 },
      notes: '正式E2E通過後啟用',
    },
  }

  await assert.rejects(
    activationModule.activateFormalReleaseMemory({ onlineCoreClient, manifest, e2eEvidence: { passed: false, verifiedTables: 10 } }),
    /live E2E/i,
  )
  await assert.rejects(
    activationModule.activateFormalReleaseMemory({ onlineCoreClient, manifest, e2eEvidence: { passed: true, verifiedTables: 9 } }),
    /10 tables/i,
  )
  assert.equal(writes.length, 0)

  const result = await activationModule.activateFormalReleaseMemory({
    onlineCoreClient,
    manifest,
    e2eEvidence: { passed: true, verifiedTables: 10, completedAt: '2026-07-24T12:00:00.000Z' },
  })

  assert.equal(result.ok, true)
  assert.equal(writes.length, 1)
  assert.deepEqual(writes[0], {
    releaseVersion: 'v105.0.0-formal.14',
    strategyVersion: 'v105',
    name: '瑞文AI百家正式策略',
    status: 'active',
    mainWeights: { 路單趨勢訊號: 0.275, 問路訊號: 0.275, 靴局莊閒偏差: 0.35, 中性保留: 0.1 },
    sideThresholds: { 和: 30, 超六: 50, 莊對: 50, 閒對: 50, 莊龍寶: 40, 閒龍寶: 40 },
    metrics: { verifiedTables: 10, e2ePassed: true },
    notes: '正式E2E通過後啟用',
    activatedAt: '2026-07-24T12:00:00.000Z',
  })
})
