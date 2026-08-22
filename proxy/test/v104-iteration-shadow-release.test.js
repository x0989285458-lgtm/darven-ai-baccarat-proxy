import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

const readJson = (relative) => JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8'))

test('seven-head shadow release is package-coherent and keeps formal v104 isolated', () => {
  const manifest = readJson('../../release/v104-seven-head-shadow-release-manifest.json')
  assert.equal(manifest.releaseVersion, 'v104.1.0-seven-head-shadow.1')
  assert.equal(manifest.packageVersion, '1.0.13')
  assert.equal(manifest.formalStrategyVersion, 'v104')
  assert.equal(manifest.shadowStrategyVersion, 'v104-seven-head-shadow-v1')
  assert.equal(manifest.shadowOnly, true)
  assert.equal(manifest.memberVisible, false)
  assert.equal(manifest.activationEligible, false)
  assert.equal(manifest.iteration.searchMethod, 'exhaustive_5_percent_grid')
  assert.equal(manifest.iteration.autoApply, false)
  assert.equal(manifest.database.gaplessTransactionalCounters, true)
})

test('v2 threshold-only shadow release manifest is isolated and exact', () => {
  const url = new URL('../../release/v104-seven-head-shadow-v2-release-manifest.json', import.meta.url)
  assert.equal(existsSync(url), true)
  const manifest = readJson('../../release/v104-seven-head-shadow-v2-release-manifest.json')
  const proxy = readJson('../package.json')
  const frontend = readJson('../../frontend/package.json')
  const worker = readJson('../../cloud-browser-worker/package.json')
  assert.equal(manifest.releaseVersion, 'v104.2.0-seven-head-shadow.2')
  assert.equal(manifest.shadowStrategyVersion, 'v104-seven-head-shadow-v2-player-pair-threshold-41')
  assert.equal(manifest.formalStrategyVersion, 'v104')
  assert.equal(manifest.shadowOnly, true)
  assert.equal(manifest.memberVisible, false)
  assert.equal(manifest.activationEligible, false)
  assert.equal(manifest.autoApply, false)
  assert.equal(manifest.finalSettlementLimit, null)
  assert.equal(manifest.manualStopOnly, true)
  assert.deepEqual(manifest.deployment.order, ['database-additive', 'catalog-acl-readback', 'proxy-render', 'live-e2e'])
  assert.equal(manifest.deployment.databaseBeforeProxy, true)
  assert.equal(manifest.deployment.catalogAclReadbackBeforeProxy, true)
  assert.equal(manifest.deployment.rollbackBeforeProxy, true)
  assert.deepEqual(manifest.thresholds, { tie: 30, superSix: 50, bankerDragon: 40, playerDragon: 40, bankerPair: 50, playerPair: 41 })
  assert.equal(proxy.version, '1.0.112')
  assert.equal(frontend.version, '1.0.63')
  assert.equal(worker.version, '1.0.63')
})

test('v3 reweight shadow manifest is isolated and exact', () => {
  const url = new URL('../../release/v104-seven-head-shadow-v3-release-manifest.json', import.meta.url)
  assert.equal(existsSync(url), true)
  const manifest = readJson('../../release/v104-seven-head-shadow-v3-release-manifest.json')
  assert.equal(manifest.releaseVersion, 'v104.3.0-seven-head-shadow.3')
  assert.equal(manifest.shadowStrategyVersion, 'v104-seven-head-shadow-v3-main-player-pair-reweight')
  assert.equal(manifest.formalStrategyVersion, 'v104')
  assert.equal(manifest.shadowOnly, true)
  assert.equal(manifest.autoApply, false)
  assert.equal(manifest.finalSettlementLimit, null)
  assert.equal(manifest.manualStopOnly, true)
  assert.deepEqual(manifest.mainWeights, {
    roadmap_trend_signals: 0.25, ask_road_signals: 0.35,
    shoe_banker_player_bias: 0.30, neutral_reserve: 0.10,
  })
  assert.deepEqual(manifest.playerPairWeights, {
    remaining_rank_pressure: 0.25, shoe_stage: 0.05, player_pair_count: 0.25,
    player_pair_residual: 0.15, pair_shared_factor: 0.30,
  })
  assert.equal(manifest.thresholds.playerPair, 41)
  assert.equal(manifest.database.previousV2ReadOnly, true)
  assert.equal(manifest.database.manualStopDrainSafe, true)
  assert.equal(manifest.database.rollbackRestoresV2, true)
  assert.deepEqual(manifest.deployment.order, ['previous-shadow-drain', 'database-additive', 'catalog-acl-readback', 'proxy-render', 'live-e2e'])
  assert.equal(manifest.deployment.previousShadowDrainBeforeDatabase, true)
})

test('v4 best-observed-heads manifest is isolated, exact, and starts from zero', () => {
  const url = new URL('../../release/v104-seven-head-shadow-v4-release-manifest.json', import.meta.url)
  assert.equal(existsSync(url), true)
  const manifest = readJson('../../release/v104-seven-head-shadow-v4-release-manifest.json')
  assert.equal(manifest.releaseVersion, 'v104.4.0-seven-head-shadow.4')
  assert.equal(manifest.shadowStrategyVersion, 'v104-seven-head-shadow-v4-best-observed-heads')
  assert.equal(manifest.formalStrategyVersion, 'v104')
  assert.equal(manifest.shadowOnly, true)
  assert.equal(manifest.autoApply, false)
  assert.equal(manifest.finalSettlementLimit, null)
  assert.equal(manifest.manualStopOnly, true)
  assert.deepEqual(manifest.headSources, {
    main: 'v1', tie: 'v3', superSix: 'v1', bankerDragon: 'v1',
    playerDragon: 'v1', bankerPair: 'v3', playerPair: 'v2',
  })
  assert.deepEqual(manifest.mainWeights, {
    roadmap_trend_signals: 0.275, ask_road_signals: 0.275,
    shoe_banker_player_bias: 0.35, neutral_reserve: 0.10,
  })
  assert.deepEqual(manifest.playerPairWeights, {
    pair_risk: 0.25, shoe_stage: 0.15, player_pair_count: 0.20,
    table_side_history: 0.20, remaining_rank_pressure: 0.20,
  })
  assert.deepEqual(manifest.thresholds, { tie: 30, superSix: 50, bankerDragon: 40, playerDragon: 40, bankerPair: 50, playerPair: 41 })
  assert.equal(manifest.database.startsAtZero, true)
  assert.equal(manifest.database.previousV3ReadOnly, true)
  assert.equal(manifest.database.manualStopDrainSafe, true)
  assert.equal(manifest.database.rollbackRestoresV3, true)
  assert.deepEqual(manifest.deployment.order, ['previous-shadow-drain', 'database-additive', 'catalog-acl-readback', 'proxy-render', 'live-e2e'])
})

test('v5 best-stage side reweight manifest is isolated, exact, and starts from zero', () => {
  const url = new URL('../../release/v104-seven-head-shadow-v5-release-manifest.json', import.meta.url)
  assert.equal(existsSync(url), true)
  const manifest = readJson('../../release/v104-seven-head-shadow-v5-release-manifest.json')
  assert.equal(manifest.releaseVersion, 'v104.5.0-seven-head-shadow.5')
  assert.equal(manifest.shadowStrategyVersion, 'v104-seven-head-shadow-v5-best-stage-side-reweight')
  assert.equal(manifest.formalStrategyVersion, 'v104')
  assert.equal(manifest.shadowOnly, true)
  assert.equal(manifest.autoApply, false)
  assert.equal(manifest.finalSettlementLimit, null)
  assert.equal(manifest.manualStopOnly, true)
  assert.deepEqual(manifest.thresholds, { tie: 30, superSix: 50, bankerDragon: 40, playerDragon: 40, bankerPair: 50, playerPair: 41 })
  assert.deepEqual(manifest.reweightedHeads, {
    superSix: { shoe_stage: 0.10, banker_point: 0.30, table_side_history: 0.25, remaining_rank_total: 0.35 },
    bankerDragon: { big_road: 0.15, point_diff: 0.10, banker_point: 0.35, banker_natural: 0.05, remaining_rank_total: 0.35 },
    playerPair: { pair_risk: 0.20, shoe_stage: 0.15, player_pair_count: 0.20, table_side_history: 0.25, remaining_rank_pressure: 0.20 },
  })
  assert.deepEqual(manifest.evidenceStages, { superSix: '801-900', bankerDragon: '801-900', playerPair: '501-600' })
  assert.equal(manifest.database.startsAtZero, true)
  assert.equal(manifest.database.previousV4ReadOnly, true)
  assert.equal(manifest.database.manualStopDrainSafe, true)
  assert.equal(manifest.database.rollbackRestoresV4PreV5State, 'shadow_disabled')
  assert.deepEqual(manifest.deployment.order, ['previous-shadow-drain', 'database-additive', 'catalog-acl-readback', 'proxy-render', 'live-e2e'])
})
