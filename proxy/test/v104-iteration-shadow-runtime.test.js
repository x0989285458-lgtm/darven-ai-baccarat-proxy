import test from 'node:test'
import assert from 'node:assert/strict'
import { createV104IterationShadowRuntime } from '../src/v104-iteration-shadow-runtime.js'

const table = (overrides = {}) => ({
  tableId: 'BAG08', shoe: 104, round: 20,
  bankerCount: 12, playerCount: 8,
  beadPlateRaw: '222221', bigRoadRaw: '222221',
  nextBankerRaw: '', nextPlayerRaw: '',
  ...overrides,
})

function createWriter(history = []) {
  const candidates = []
  const settlements = []
  const durable = new Map()
  return {
    configured: true, candidates, settlements, durable,
    async getV104IterationShadowHistory() { return structuredClone(history) },
    async issueV104IterationShadowPrediction(candidate) {
      candidates.push(structuredClone(candidate))
      const issued = { ...candidate, predictionId: `pid-${candidate.targetShoe}-${candidate.targetRound}`, issuedAt: '2026-07-21T10:00:00Z' }
      durable.set(`${candidate.targetShoe}:${candidate.targetRound}`, issued)
      return issued
    },
    async readV104IterationShadowIssuance({ shoe, round }) { return durable.get(`${shoe}:${round}`) ?? null },
    async settleV104IterationShadowPrediction(settlement) { settlements.push(structuredClone(settlement)); return { predictionId: settlement.predictionId, duplicate: false } },
  }
}

test('v104 runtime hydrates issuance streaks before predicting and tracks pre-result directions per table and shoe', async () => {
  const history = Array.from({ length: 4 }, (_, index) => ({
    source: 'ofalive99', table_id: 'BAG08', shoe_no: '104', round_no: 17 + index,
    strategy_version: 'v104-seven-head-shadow-v2-player-pair-threshold-41', prediction_timing: 'pre_result_context',
    prediction_issued_at: `2026-07-21T10:0${index}:00Z`, predicted_result: 'banker',
  }))
  const writer = createWriter(history)
  const runtime = createV104IterationShadowRuntime({ enabled: true, writer })
  const issued = await runtime.observeTable(table())

  assert.equal(issued.lockRisk, true)
  assert.equal(issued.shoeBiasSuppressed, true)
  assert.equal(runtime.snapshot().historySource, 'v104_iteration_shadow_issuance_and_final')
})

test('v104 runtime resets same-side issuance tracking when shoe changes', async () => {
  const writer = createWriter()
  const runtime = createV104IterationShadowRuntime({ enabled: true, writer })
  for (let round = 20; round < 24; round += 1) await runtime.observeTable(table({ round }))
  const fresh = await runtime.observeTable(table({ shoe: 105, round: 0, bankerCount: 0, playerCount: 0 }))
  assert.equal(fresh.sameSideStreak, 1)
  assert.equal(fresh.shoeBiasSuppressed, false)
})

test('v104 restart rehydrates an unsettled immutable issuance instead of recomputing the same target', async () => {
  const payload = {
    source: 'ofalive99', strategyVersion: 'v104-seven-head-shadow-v2-player-pair-threshold-41', predictionTiming: 'pre_result_context',
    targetTableId: 'BAG08', targetShoe: '104', targetRound: 21,
    predictedResult: 'banker', confidence: 48, sameSideStreak: 4,
    independentSupportCount: 2, shoeBiasSuppressed: false, lockRisk: false,
  }
  const history = [{
    prediction_id: 'persisted-v104-21', source: 'ofalive99', table_id: 'BAG08',
    shoe_no: '104', round_no: 21, strategy_version: 'v104-seven-head-shadow-v2-player-pair-threshold-41',
    prediction_timing: 'pre_result_context', prediction_issued_at: '2026-07-21T10:04:00Z',
    predicted_result: 'banker', settlement_final: false, prediction_payload: payload,
  }]
  const writer = createWriter(history)
  const runtime = createV104IterationShadowRuntime({ enabled: true, writer })
  const issued = await runtime.observeTable(table({ round: 20 }))
  assert.equal(issued.predictionId, 'persisted-v104-21')
  assert.equal(issued.sameSideStreak, 4)
  assert.equal(writer.candidates.length, 0)
})

test('v104 restart hydration resets streak across missing round gaps', async () => {
  const history = [17, 19].map((round) => ({
    source: 'ofalive99', table_id: 'BAG08', shoe_no: '104', round_no: round,
    strategy_version: 'v104-seven-head-shadow-v2-player-pair-threshold-41', prediction_timing: 'pre_result_context',
    prediction_issued_at: `2026-07-21T10:${round}:00Z`, predicted_result: 'banker',
  }))
  const writer = createWriter(history)
  const runtime = createV104IterationShadowRuntime({ enabled: true, writer })
  const issued = await runtime.observeTable(table({
    round: 19, bankerCount: 20, playerCount: 0,
    beadPlateRaw: '222222', bigRoadRaw: '222222', nextBankerRaw: '2', nextPlayerRaw: '1',
  }))
  assert.equal(issued.predictedResult, 'banker')
  assert.equal(issued.sameSideStreak, 2)
})

test('v104 serializes concurrent same-table issuances before deriving the next streak', async () => {
  const writer = createWriter()
  const originalIssue = writer.issueV104IterationShadowPrediction.bind(writer)
  let releaseFirst
  let firstStarted
  const started = new Promise((resolve) => { firstStarted = resolve })
  const gate = new Promise((resolve) => { releaseFirst = resolve })
  writer.issueV104IterationShadowPrediction = async (candidate) => {
    if (candidate.targetRound === 21) {
      firstStarted()
      await gate
    }
    return originalIssue(candidate)
  }
  const runtime = createV104IterationShadowRuntime({ enabled: true, writer })
  const strongBanker = {
    bankerCount: 20, playerCount: 0,
    beadPlateRaw: '222222', bigRoadRaw: '222222', nextBankerRaw: '2', nextPlayerRaw: '1',
  }
  const firstPromise = runtime.observeTable(table({ ...strongBanker, round: 20 }))
  await started
  const secondPromise = runtime.observeTable(table({ ...strongBanker, round: 21 }))
  releaseFirst()
  const [first, second] = await Promise.all([firstPromise, secondPromise])
  assert.equal(first.predictedResult, 'banker')
  assert.equal(second.predictedResult, 'banker')
  assert.equal(first.sameSideStreak, 1)
  assert.equal(second.sameSideStreak, 2)
})

test('v104 first complete issuance wins and identical replay is idempotent', async () => {
  const writer = createWriter()
  const runtime = createV104IterationShadowRuntime({ enabled: true, writer })
  const first = await runtime.observeTable(table())
  assert.deepEqual(await runtime.observeTable(table()), first)
  assert.equal(writer.candidates.length, 1)
})

test('v104 settles only verified Final identity and tie remains PUSH', async () => {
  const writer = createWriter()
  const runtime = createV104IterationShadowRuntime({ enabled: true, writer })
  await runtime.observeTable(table())
  const result = await runtime.settleRound({ ...table(), round: 21, sourceAction: '/show_win', winner: 'tie' })
  assert.equal(result.predictionId, 'pid-104-21')
  assert.equal(writer.settlements[0].settlementStatus, 'push')
  assert.equal(writer.settlements[0].isHit, null)
  await assert.rejects(runtime.settleRound({ ...table(), round: 22, sourceAction: '/show_poker', winner: 'banker' }), /immutable issuance|verified Final/i)
})

test('v104 concurrent identical Final settlement shares one in-flight writer call', async () => {
  const writer = createWriter()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const originalSettle = writer.settleV104IterationShadowPrediction.bind(writer)
  writer.settleV104IterationShadowPrediction = async (settlement) => {
    await gate
    return originalSettle(settlement)
  }
  const runtime = createV104IterationShadowRuntime({ enabled: true, writer })
  await runtime.observeTable(table())
  const final = { ...table(), round: 21, sourceAction: '/summary', winner: 'banker' }
  const first = runtime.settleRound(final)
  const second = runtime.settleRound(final)
  release()
  const [left, right] = await Promise.all([first, second])
  assert.equal(writer.settlements.length, 1)
  assert.equal(left.predictionId, right.predictionId)
})

test('v104 persists immutable cycle report SVG and per-head grid suggestion at exact milestones', async () => {
  const writer = createWriter()
  let issued
  const originalIssue = writer.issueV104IterationShadowPrediction.bind(writer)
  writer.issueV104IterationShadowPrediction = async (candidate) => { issued = await originalIssue(candidate); return issued }
  writer.settleV104IterationShadowPrediction = async (settlement) => ({
    predictionId: settlement.predictionId, prediction_id: settlement.predictionId, duplicate: false,
    settlement_sequence: 1000,
    action_sequences: { main_action_count: 1000, tie_action_count: 0, super_six_action_count: 0, banker_dragon_action_count: 0, player_dragon_action_count: 0, banker_pair_action_count: 0, player_pair_action_count: 0 },
  })
  const runtime = createV104IterationShadowRuntime({ enabled: true, writer })
  await runtime.observeTable(table())
  const makeRow = (index) => ({
    prediction_id: `history-${index}`, settlement_sequence: index + 1,
    main_action_sequence: index + 1, settlement_final: true,
    prediction_payload: structuredClone(issued),
    head_results: {
      main: { action: true, status: index % 2 ? 'miss' : 'hit', fixedStakeUnits: 1, weightedStakeUnits: 2, fixedNetUnits: index % 2 ? -1 : 1, weightedNetUnits: index % 2 ? -2 : 2 },
      tie: { action: false, status: 'no_action' }, superSix: { action: false, status: 'no_action' },
      bankerDragon: { action: false, status: 'no_action' }, playerDragon: { action: false, status: 'no_action' },
      bankerPair: { action: false, status: 'no_action' }, playerPair: { action: false, status: 'no_action' },
    },
    resolved_at: new Date(2026, 0, 1, 0, 0, index).toISOString(),
  })
  const rows = Array.from({ length: 1000 }, (_, index) => makeRow(index))
  writer.getV104IterationShadowSettledRange = async () => rows
  writer.getV104IterationShadowHeadActionRange = async () => rows
  writer.getV104IterationShadowSuggestions = async () => [{
    id: 'v104-seven-head-shadow-v2-player-pair-threshold-41:tie:1', status: 'pending', head_key: 'tie', headKey: 'tie', headLabel: '和', action_cycle: 1,
    currentWeights: { tie_rate: 0.5, tie_signal: 0.5 }, suggestedWeights: { tie_rate: 0.55, tie_signal: 0.45 }, autoApply: false,
  }]
  let artifact
  writer.persistV104IterationShadowArtifacts = async (payload) => { artifact = payload; return { persisted: true } }
  await runtime.settleRound({ ...table(), round: 21, sourceAction: '/summary', winner: 'banker' })
  assert.equal(artifact.report.cycleNumber, 1)
  assert.match(artifact.reportSvg, /^<svg/)
  assert.equal(artifact.suggestions.some((item) => item.headKey === 'tie'), true)
  assert.equal(artifact.suggestions.some((item) => item.headKey === 'main'), true)
  assert.match(artifact.reportSvg, /和｜只調現有比例/)
  assert.equal(artifact.suggestions.find((item) => item.headKey === 'main').searchMethod, 'exhaustive_5_percent_grid')
  assert.equal(artifact.suggestions.find((item) => item.headKey === 'main').autoApply, false)
})

test('v104 restart reconstructs missing durable cycle and head artifacts from counters', async () => {
  const seedWriter = createWriter()
  const seedRuntime = createV104IterationShadowRuntime({ enabled: true, writer: seedWriter })
  const issued = await seedRuntime.observeTable(table())
  const rows = Array.from({ length: 1000 }, (_, index) => ({
    prediction_id: `recover-${index}`, settlement_sequence: index + 1, main_action_sequence: index + 1,
    settlement_final: true, prediction_payload: structuredClone(issued),
    head_results: {
      main: { action: true, status: index % 2 ? 'hit' : 'miss', fixedStakeUnits: 1, weightedStakeUnits: 1, fixedNetUnits: index % 2 ? 0.95 : -1, weightedNetUnits: index % 2 ? 0.95 : -1 },
      tie: { action: false }, superSix: { action: false }, bankerDragon: { action: false },
      playerDragon: { action: false }, bankerPair: { action: false }, playerPair: { action: false },
    },
    resolved_at: new Date(1700000000000 + index * 1000).toISOString(),
  }))
  const writer = createWriter()
  writer.getV104IterationShadowCounters = async () => ({ settlement_count: 1000, main_action_count: 1000, tie_action_count: 0, super_six_action_count: 0, banker_dragon_action_count: 0, player_dragon_action_count: 0, banker_pair_action_count: 0, player_pair_action_count: 0 })
  writer.getV104IterationShadowCycleReports = async () => []
  writer.getV104IterationShadowSuggestions = async () => []
  writer.getV104IterationShadowSettledRange = async () => rows
  writer.getV104IterationShadowHeadActionRange = async () => rows
  const persisted = []
  writer.persistV104IterationShadowArtifacts = async (payload) => { persisted.push(payload); return { persisted: true } }
  const runtime = createV104IterationShadowRuntime({ enabled: true, writer })
  await runtime.start()
  assert.equal(persisted.length, 1)
  assert.equal(persisted[0].report.cycleNumber, 1)
  assert.equal(persisted[0].suggestions[0].headKey, 'main')
  assert.match(persisted[0].reportSvg, /千次權重迭代建議/)
  assert.equal(runtime.snapshot().status, 'ready')
})

test('v104 pending issuances remain bounded and evicted identity hydrates from DB for settlement', async () => {
  const writer = createWriter()
  const runtime = createV104IterationShadowRuntime({ enabled: true, writer, maxPendingIssuances: 2 })
  await runtime.observeTable(table({ round: 20 }))
  await runtime.observeTable(table({ round: 21 }))
  await runtime.observeTable(table({ round: 22 }))
  assert.equal(runtime.snapshot().pendingIssuances, 2)
  const result = await runtime.settleRound({ ...table(), round: 21, sourceAction: '/summary', winner: 'banker' })
  assert.equal(result.predictionId, 'pid-104-21')
})

test('v104 hanging RPC times out into its own observable error', async () => {
  const writer = createWriter()
  writer.issueV104IterationShadowPrediction = async () => new Promise(() => {})
  const runtime = createV104IterationShadowRuntime({ enabled: true, writer, requestTimeoutMs: 10 })
  await assert.rejects(runtime.observeTable(table()), /timed out/i)
  assert.equal(runtime.snapshot().status, 'error')
  assert.match(runtime.snapshot().error, /timed out/i)
})
