import { readFileSync, writeFileSync } from 'node:fs'
import { buildV105FormalPrediction } from '../src/v105-formal-strategy.js'
import { isVerifiedFinalRoundAction } from '../../shared/real-card-validator.js'

const inputPath = process.argv[2]
const outputPath = process.argv[3]
if (!inputPath || !outputPath) throw new Error('usage: node scripts/replay-v105-jsonl.mjs INPUT.jsonl OUTPUT.json')

const rows = readFileSync(inputPath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  .sort((a, b) => Date.parse(a.issuedAt) - Date.parse(b.issuedAt) || String(a.id).localeCompare(String(b.id)))
const evaluableRows = rows.filter(isEvaluableRow)
const warmupCount = Math.floor(evaluableRows.length * 0.2)
const warmupCutoffMs = warmupCount > 0 ? Date.parse(evaluableRows[warmupCount - 1].issuedAt) : Number.NEGATIVE_INFINITY
rows.forEach((row) => { row.warmup = Date.parse(row.issuedAt) <= warmupCutoffMs })
const resolvedHistory = []
const pendingResolved = [...evaluableRows].sort((a, b) => Date.parse(a.resolvedAt) - Date.parse(b.resolvedAt))
const issuanceState = new Map()
const results = []
let resolvedIndex = 0

for (const row of rows) {
  const issuedMs = Date.parse(row.issuedAt)
  while (resolvedIndex < pendingResolved.length && Date.parse(pendingResolved[resolvedIndex].resolvedAt) < issuedMs) {
    const prior = pendingResolved[resolvedIndex++]
    resolvedHistory.push({
      strategy_version: prior.warmup ? 'v104' : 'v105', prediction_timing: 'pre_result_context', prediction_issued_at: prior.issuedAt,
      settlement_final: true, table_id: prior.tableId,
      predicted_result: prior.warmup ? prior.oldPrediction : prior.baselineV104PredictedResult,
      actual_result: prior.actualResult, resolved_at: prior.resolvedAt,
    })
  }
  const table = {
    ...(row.mtContext || {}), ...(row.roadFeatures || {}),
    tableId: row.tableId, shoe: row.shoe, round: Number(row.round) - 1,
    tableRecentHitRate: row.tableRecentHitRate,
    tableRecentPredictionCount: row.tableRecentPredictionCount,
    sourceUpdatedAt: row.issuedAt,
  }
  delete table.actualWinner
  delete table.winner
  delete table.rawResult
  delete table.lastRound
  const key = String(row.tableId)
  const state = issuanceState.get(key) || { priorDirection: null, priorSameSideStreak: 0, priorShoe: row.shoe, priorRound: null }
  if (String(state.priorShoe) !== String(row.shoe) || (Number.isSafeInteger(state.priorRound) && row.round !== state.priorRound + 1)) {
    state.priorDirection = null
    state.priorSameSideStreak = 0
    state.priorShoe = row.shoe
    state.priorRound = null
  }
  if (row.warmup) {
    state.priorSameSideStreak = Number(row.oldSameSideStreak)
    state.priorDirection = row.oldPrediction
    state.priorShoe = row.shoe
    state.priorRound = row.round
    issuanceState.set(key, state)
    continue
  }
  const candidate = buildV105FormalPrediction(table, resolvedHistory, state)
  const cycle = candidate.diagnostics?.roadCycles?.main
  const finalPrediction = candidate.predictedResult
  state.priorSameSideStreak = candidate.baselineV104SameSideStreak
  state.priorDirection = candidate.baselineV104PredictedResult
  state.priorShoe = row.shoe
  state.priorRound = row.round
  issuanceState.set(key, state)
  row.v105PredictedResult = finalPrediction
  row.baselineV104PredictedResult = candidate.baselineV104PredictedResult
  row.baselineV104SameSideStreak = candidate.baselineV104SameSideStreak
  if (!isEvaluableRow(row)) continue
  const auxiliary = candidate.diagnostics?.roadCycles?.auxiliary || {}
  const independentAuxiliary = ['bigEye', 'smallRoad', 'cockroach'].map((key) => auxiliary[key]).filter(Boolean)
  const auxiliaryAgrees = independentAuxiliary.filter((item) => item.agreesWithMain).length
  const auxiliaryConflicts = independentAuxiliary.filter((item) => item.conflictsWithMain).length
  results.push({
    id: row.id, issuedAt: row.issuedAt, tableId: row.tableId, shoe: row.shoe, round: row.round,
    actual: row.actualResult, old: row.oldPrediction, next: finalPrediction,
    baseline: candidate.baselineV104PredictedResult,
    oldSameSideStreak: Number(row.oldSameSideStreak),
    baselineSameSideStreak: candidate.baselineV104SameSideStreak,
    cycleDetected: cycle?.detected === true, cyclePriorityEligible: cycle?.priorityEligible === true,
    cyclePeriod: cycle?.motif?.length ?? null,
    cycleRepeats: cycle?.repeats ?? null,
    auxiliaryAgrees, auxiliaryConflicts,
  })
}

function isEvaluableRow(row = {}) {
  return row.settlementFinal === true
    && isVerifiedFinalRoundAction(row.settlementSourceAction)
    && Boolean(row.resolvedAt)
    && ['banker', 'player', 'tie'].includes(row.actualResult)
}

function unit(prediction, actual) {
  if (actual === 'tie') return 0
  if (prediction !== actual) return -1
  return prediction === 'banker' ? 0.95 : 1
}
function summarize(items, key) {
  let decisive = 0, hits = 0, pushes = 0, changed = 0, bankroll = 0, peak = 0, maxDrawdown = 0, losing = 0, maxLosing = 0
  for (const item of items) {
    const prediction = item[key]
    if (item.old !== item.next) changed += 1
    if (item.actual === 'tie') { pushes += 1; continue }
    decisive += 1
    if (prediction === item.actual) { hits += 1; losing = 0 } else { losing += 1; maxLosing = Math.max(maxLosing, losing) }
    bankroll += unit(prediction, item.actual)
    peak = Math.max(peak, bankroll)
    maxDrawdown = Math.max(maxDrawdown, peak - bankroll)
  }
  return {
    rows: items.length, decisive, pushes, hits, misses: decisive - hits,
    hitRate: decisive ? Number((hits / decisive * 100).toFixed(4)) : null,
    netUnits: Number(bankroll.toFixed(4)), maxLosingStreak: maxLosing,
    maxDrawdownUnits: Number(maxDrawdown.toFixed(4)), changedDirections: changed,
  }
}
function group(items, keyFn) {
  const groups = new Map()
  for (const item of items) {
    const key = keyFn(item)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(item)
  }
  return Object.fromEntries([...groups.entries()].map(([key, value]) => [key, { v104: summarize(value, 'old'), v105: summarize(value, 'next') }]))
}
function blocks(items, size) {
  const out = []
  for (let i = 0; i < items.length; i += size) {
    const block = items.slice(i, i + size)
    out.push({ start: i + 1, end: i + block.length, v104: summarize(block, 'old'), v105: summarize(block, 'next') })
  }
  return out
}
const detectedCycleRows = results.filter((row) => row.cycleDetected)
const cycleRows = results.filter((row) => row.cyclePriorityEligible)
const baselineDirectionMismatches = results.filter((row) => row.baseline !== row.old)
const baselineStreakMismatches = results.filter((row) => row.baselineSameSideStreak !== row.oldSameSideStreak)
const baselineMismatches = results.filter((row) => row.baseline !== row.old || row.baselineSameSideStreak !== row.oldSameSideStreak)
const nonCycleDirectionDrifts = results.filter((row) => !row.cyclePriorityEligible && row.next !== row.old)
const report = {
  generatedAt: new Date().toISOString(),
  methodology: {
    source: 'all immutable v104 formal issuances for state + verified Final settlements for scoring',
    rowsSortedBy: 'prediction_issued_at ascending',
    walkForwardSplit: { warmupRows: warmupCount, evaluationRows: results.length, warmupPolicy: 'immutable v104 predecessor', evaluationPolicy: 'v105 sequential' },
    leakageGuard: 'candidate history includes only rows with resolved_at strictly before current prediction_issued_at',
    currentRoundOutcomeUsedAsFeature: false,
    v104Baseline: 'persisted immutable formal prediction',
    v104BaselineState: 'persisted immutable sameSideStreak and direction from each predecessor issuance',
    v105Candidate: 'counterfactual buildV105FormalPrediction from persisted pre-result road_features and mt_context',
    sideHeadsChanged: false,
  },
  all: { v104: summarize(results, 'old'), v105: summarize(results, 'next') },
  baselineParity: {
    mismatches: baselineMismatches.length,
    directionMismatches: baselineDirectionMismatches.length,
    sameSideStreakMismatches: baselineStreakMismatches.length,
    nonCycleDirectionDrifts: nonCycleDirectionDrifts.length,
    passed: baselineMismatches.length === 0 && nonCycleDirectionDrifts.length === 0,
    mismatchSamples: baselineMismatches.slice(0, 20).map(({ id, tableId, shoe, round, old, baseline, oldSameSideStreak, baselineSameSideStreak, cyclePriorityEligible }) => ({ id, tableId, shoe, round, old, baseline, oldSameSideStreak, baselineSameSideStreak, cyclePriorityEligible })),
  },
  cycleDetection: {
    rows: detectedCycleRows.length,
    rate: results.length ? Number((detectedCycleRows.length / results.length * 100).toFixed(4)) : 0,
  },
  cycleCoverage: {
    rows: cycleRows.length,
    rate: results.length ? Number((cycleRows.length / results.length * 100).toFixed(4)) : 0,
    v104: summarize(cycleRows, 'old'), v105: summarize(cycleRows, 'next'),
  },
  byHundred: blocks(results, 100),
  byThousand: blocks(results, 1000),
  byTable: group(results, (row) => row.tableId),
  byShoe: group(results, (row) => `${row.tableId}:${row.shoe}`),
  byCyclePeriod: group(cycleRows, (row) => String(row.cyclePeriod)),
  byAuxiliaryValidation: group(cycleRows, (row) => `agree${row.auxiliaryAgrees}-conflict${row.auxiliaryConflicts}`),
}
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ rows: results.length, all: report.all, baselineParity: report.baselineParity, cycleCoverage: report.cycleCoverage, tableCount: Object.keys(report.byTable).length, shoeCount: Object.keys(report.byShoe).length }))
if (!report.baselineParity.passed) process.exitCode = 2
