import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { V105_FORMAL_RELEASE_VERSION } from '../src/v105-formal-strategy.js'
import { SIDE_PREDICTION_THRESHOLDS } from '../src/supabase-writer.js'

const manifest = JSON.parse(readFileSync(new URL('../../release/v105-formal-release-manifest.json', import.meta.url), 'utf8'))

test('formal.13 manifest activates memory only after live E2E with the exact formal parameters', () => {
  assert.equal(manifest.releaseVersion, 'v105.0.0-formal.13')
  assert.equal(V105_FORMAL_RELEASE_VERSION, 'v105.0.0-formal.13')
  assert.deepEqual(SIDE_PREDICTION_THRESHOLDS, {
    tie: 30,
    superSix: 50,
    bankerPair: 50,
    playerPair: 50,
    bankerDragon: 40,
    playerDragon: 40,
  })
  assert.deepEqual(manifest.memoryActivation, {
    handler: 'proxy/src/formal-memory-activation.js',
    name: '瑞文AI百家正式策略',
    requires: { liveE2EPassed: true, verifiedTables: 10 },
    mainWeights: { 路單趨勢訊號: 0.275, 問路訊號: 0.275, 靴局莊閒偏差: 0.35, 中性保留: 0.1 },
    sideThresholds: { 和: 30, 超六: 50, 莊對: 50, 閒對: 50, 莊龍寶: 40, 閒龍寶: 40 },
    notes: '正式E2E通過後啟用',
  })
  assert.equal(manifest.databaseMemoryAdditive, 'frontend/supabase/migrate_v105_formal_memory_daily_summary.sql')
  const databaseAdditiveIndex = manifest.deploymentOrder.indexOf('database-additive')
  const databaseMemoryIndex = manifest.deploymentOrder.indexOf('database-memory-additive')
  const proxyIndex = manifest.deploymentOrder.indexOf('proxy')
  assert.equal(databaseMemoryIndex, databaseAdditiveIndex + 1)
  assert.ok(databaseMemoryIndex < proxyIndex)
  const liveE2EIndex = manifest.deploymentOrder.indexOf('live-e2e')
  const memoryActivationIndex = manifest.deploymentOrder.indexOf('memory-activation')
  assert.ok(liveE2EIndex >= 0)
  assert.equal(memoryActivationIndex, liveE2EIndex + 1)
  assert.equal(JSON.stringify(manifest.memoryActivation).match(/token|password|cookie|secret|rawPayload/gi), null)
})
