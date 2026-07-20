import { createShoeTracker, scoreCardShoeInfluence } from './card-shoe.js'
import {
  ALL_MT_EQUAL_MAIN_WEIGHTS,
  ALL_MT_EQUAL_STRATEGY_VERSION,
  SIDE_PREDICTION_THRESHOLDS as FORMAL_SIDE_PREDICTION_THRESHOLDS,
  buildLivePrediction,
} from './supabase-writer.js'

const DEFAULT_LABELS = ['1', '2', '3', '3A', '5', '6', '7', '8', '9']
const WINNER_LABELS = new Map([
  [1, '閒'], [2, '莊'], [3, '和'], ['1', '閒'], ['2', '莊'], ['3', '和'],
  ['player', '閒'], ['banker', '莊'], ['tie', '和'], ['閒', '閒'], ['莊', '莊'], ['和', '和'],
])

export const SIDE_PREDICTION_THRESHOLDS = FORMAL_SIDE_PREDICTION_THRESHOLDS

export const MAIN_ACTION_CONFIDENCE_THRESHOLD = 30

export const REPORT_MAIN_WEIGHTS = {
  shoeRoad: 0.30,
  askRoad: 0.18,
  recentTrend: 0.17,
  bankerPlayerStats: 0.13,
  auxiliaryRoads: 0.12,
  beadRoad: 0.10,
}

export const FORMAL_MAIN_PREDICTION_WEIGHTS = ALL_MT_EQUAL_MAIN_WEIGHTS
export const MAIN_PREDICTION_WEIGHTS = REPORT_MAIN_WEIGHTS
const SAVED_SIDE_KEYS = ['tie', 'superSix', 'bankerPair', 'playerPair', 'bankerDragon', 'playerDragon']

export function buildStableReportFromRows(rows = []) {
  const tables = new Map()
  const invalidRows = []
  const sourceRows = Array.isArray(rows) ? rows : []
  const fingerprintsByKey = new Map()

  for (const row of sourceRows) {
    if (String(row?.strategy_version ?? '').trim() !== ALL_MT_EQUAL_STRATEGY_VERSION) continue
    const identity = normalizeSavedRowIdentity(row)
    const actions = exactSavedFlags(row?.prediction_features?.side_actions)
    const hits = exactSavedFlags(row?.prediction_features?.side_hits)
    if (!identity || !actions || !hits) continue
    const key = savedSettlementKey(identity)
    const fingerprints = fingerprintsByKey.get(key) ?? new Set()
    fingerprints.add(JSON.stringify([row.predicted_result, row.actual_result, row.is_hit, actions, hits]))
    fingerprintsByKey.set(key, fingerprints)
  }
  const conflictingKeys = new Set([...fingerprintsByKey].filter(([, fingerprints]) => fingerprints.size > 1).map(([key]) => key))

  for (const [index, row] of sourceRows.entries()) {
    if (String(row?.strategy_version ?? '').trim() !== ALL_MT_EQUAL_STRATEGY_VERSION) {
      invalidRows.push({ index, reason: 'unapproved_strategy' })
      continue
    }
    const identity = normalizeSavedRowIdentity(row)
    if (!identity) {
      invalidRows.push({ index, reason: 'missing_identity' })
      continue
    }
    const actions = exactSavedFlags(row?.prediction_features?.side_actions)
    if (!actions) {
      invalidRows.push({ index, reason: 'missing_or_invalid_side_actions' })
      continue
    }
    const hits = exactSavedFlags(row?.prediction_features?.side_hits)
    if (!hits) {
      invalidRows.push({ index, reason: 'missing_or_invalid_side_hits' })
      continue
    }
    const key = savedSettlementKey(identity)
    if (conflictingKeys.has(key)) {
      invalidRows.push({ index, reason: 'duplicate_or_conflicting_row' })
      continue
    }
    const table = tables.get(identity.tableId) ?? createSavedRowAggregate(identity.tableId)
    if (table.roundKeys.has(key)) {
      invalidRows.push({ index, reason: 'duplicate_or_conflicting_row' })
      continue
    }
    tables.set(identity.tableId, table)
    table.roundKeys.add(key)
    table.rounds += 1
    if (row.actual_result === 'tie') table.pushes += 1
    else if (row.actual_result === 'banker' || row.actual_result === 'player') {
      table.mainEvaluated += 1
      if (row.is_hit === true) table.hits += 1
      else table.misses += 1
    }
    for (const sideKey of SAVED_SIDE_KEYS) {
      if (!actions[sideKey]) continue
      table.side[sideKey].actions += 1
      table.sideActions += 1
      if (hits[sideKey]) {
        table.side[sideKey].hits += 1
        table.sideHits += 1
      }
    }
  }

  const reportTables = [...tables.values()]
    .sort((a, b) => a.tableId.localeCompare(b.tableId))
    .map((table) => finalizeSavedRowAggregate(table, true))
  const total = reportTables.reduce((sum, table) => {
    sum.rounds += table.rounds
    sum.hits += table.hits
    sum.misses += table.misses
    sum.pushes += table.pushes
    sum.mainEvaluated += table.mainEvaluated
    sum.sideActions += table.sideActions
    sum.sideHits += table.sideHits
    for (const key of SAVED_SIDE_KEYS) {
      sum.side[key].actions += table.side[key].actions
      sum.side[key].hits += table.side[key].hits
    }
    return sum
  }, createSavedRowAggregate(null))

  return { version: '100-row-contract', invalidRows, tables: reportTables, total: finalizeSavedRowAggregate(total, false) }
}

function savedSettlementKey(identity) {
  return `${identity.source}:${identity.tableId}:${identity.shoe}:${identity.round}`
}

function normalizeSavedRowIdentity(row = {}) {
  const source = String(row.source ?? '').trim()
  const tableId = String(row.table_id ?? '').trim()
  const shoe = String(row.shoe_no ?? '').trim()
  const strategyVersion = String(row.strategy_version ?? '').trim()
  const round = Number(row.round_no)
  if (!source || !tableId || !shoe || !strategyVersion || !Number.isInteger(round) || round < 1) return null
  if (!['banker', 'player'].includes(row.predicted_result)) return null
  if (!['banker', 'player', 'tie'].includes(row.actual_result)) return null
  return { source, tableId, shoe, round, strategyVersion }
}

function exactSavedFlags(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const keys = Object.keys(value).sort()
  if (keys.length !== SAVED_SIDE_KEYS.length || !SAVED_SIDE_KEYS.every((key) => keys.includes(key))) return null
  if (!SAVED_SIDE_KEYS.every((key) => typeof value[key] === 'boolean')) return null
  return Object.fromEntries(SAVED_SIDE_KEYS.map((key) => [key, value[key]]))
}

function createSavedRowAggregate(tableId) {
  return {
    tableId,
    roundKeys: new Set(),
    rounds: 0,
    hits: 0,
    misses: 0,
    pushes: 0,
    mainEvaluated: 0,
    sideActions: 0,
    sideHits: 0,
    side: Object.fromEntries(SAVED_SIDE_KEYS.map((key) => [key, { actions: 0, hits: 0 }])),
  }
}

function finalizeSavedRowAggregate(value, includeTableId) {
  const side = Object.fromEntries(SAVED_SIDE_KEYS.map((key) => {
    const item = value.side[key]
    return [key, { ...item, hitRate: item.actions ? percent(item.hits, item.actions) : null }]
  }))
  return {
    ...(includeTableId ? { tableId: value.tableId } : {}),
    rounds: value.rounds,
    hits: value.hits,
    misses: value.misses,
    pushes: value.pushes,
    mainEvaluated: value.mainEvaluated,
    hitRate: value.mainEvaluated ? percent(value.hits, value.mainEvaluated) : null,
    sideActions: value.sideActions,
    sideHits: value.sideHits,
    sideHitRate: value.sideActions ? percent(value.sideHits, value.sideActions) : null,
    side,
  }
}

export function createStableReportSession({ targetTableCount = 9, startedAt = new Date().toISOString(), labelOrder = DEFAULT_LABELS, globalStats = null } = {}) {
  const tables = new Map()
  const shoeTracker = createShoeTracker({ deckCount: 8 })
  let lastStatus = {}
  let lastSnapshotAt = null
  let rollingGlobalStats = globalStats ?? { banker: 0, player: 0, tie: 0 }

  function ensureTable(table, slotIndex) {
    const key = String(table.tableId ?? `slot-${slotIndex + 1}`)
    if (!tables.has(key)) {
      tables.set(key, {
        tableId: key,
        slot: slotIndex + 1,
        displayName: table.displayName || `MT百家樂第${labelOrder[slotIndex] ?? slotIndex + 1}桌`,
        rounds: 0,
        hits: 0,
        misses: 0,
        pushes: 0,
        mainEvaluated: 0,
        sideLearningSamples: 0,
        sideActions: 0,
        sideHits: 0,
        sidePredictions: createEmptySidePredictionSummary(),
        lastRoundKey: null,
        lastWinner: null,
        lastPrediction: null,
        lastConfidence: null,
        lastPointText: null,
        predictionWeights: { ...FORMAL_MAIN_PREDICTION_WEIGHTS, ...REPORT_MAIN_WEIGHTS },
        sourceScores: {},
        patterns: detectRoadTrends([]),
        performanceTracker: createTablePerformanceTracker(),
        tablePerformance: createTablePerformanceTracker().summary(),
        strategyAdjustmentStats: createStrategyAdjustmentStats(),
        predictionDiagnostics: null,
      })
    }
    const item = tables.get(key)
    item.displayName = table.displayName || item.displayName
    item.tablePerformance = item.performanceTracker.summary()
    return item
  }

  return {
    preflight(snapshot = {}) {
      const status = snapshot.status ?? {}
      const sourceTables = Array.isArray(snapshot.tables) ? snapshot.tables : []
      const tableCount = Number(status.tableCount ?? sourceTables.length ?? 0)
      const failures = []
      if (status.connected !== true) failures.push('proxy not connected')
      if (status.authenticated === false) failures.push('proxy not authenticated')
      if (tableCount < targetTableCount) failures.push(`tableCount ${tableCount} < ${targetTableCount}`)
      return {
        ok: failures.length === 0,
        failures,
        tableCount,
        connected: status.connected === true,
        authenticated: status.authenticated !== false,
        captureMode: status.captureMode ?? null,
      }
    },

    recordSnapshot(snapshot = {}, at = new Date().toISOString()) {
      lastStatus = snapshot.status ?? {}
      lastSnapshotAt = at
      const sourceTables = Array.isArray(snapshot.tables) ? snapshot.tables.slice(0, targetTableCount) : []
      rollingGlobalStats = summarizeGlobalStats(sourceTables, rollingGlobalStats)
      sourceTables.forEach((table, index) => {
        const item = ensureTable(table, index)
        const round = normalizeRound(table.lastRound)
        if (round) {
          const roundKey = `${round.tableId ?? item.tableId}:${round.shoe ?? ''}:${round.round ?? ''}:${round.winner ?? ''}`
          const pending = item.pendingPrediction
          const matchesPending = pending
            && String(pending.targetTableId) === String(round.tableId ?? item.tableId)
            && String(pending.targetShoe ?? '') === String(round.shoe ?? '')
            && Number(pending.targetRound) === Number(round.round)
          if (roundKey !== item.lastRoundKey && matchesPending) {
            shoeTracker.recordRound(round)
            const winner = normalizeWinner(round.winner)
            const predictionMain = pending.predictedResult === 'banker' ? '莊' : '閒'
            const actualSide = actualSideOutcomes(winner, round)
            item.rounds += 1
            item.lastRoundKey = roundKey
            item.lastWinner = winner
            item.lastPrediction = predictionMain
            item.lastConfidence = pending.confidence
            item.lastPointText = formatPointText(round)
            item.lastSidePredictions = structuredClone(pending.sidePredictions)
            item.lastSideActions = structuredClone(pending.sideActions)
            const reportPrediction = pending.reportPrediction
            item.predictionWeights = reportPrediction?.weights ?? { ...FORMAL_MAIN_PREDICTION_WEIGHTS, ...REPORT_MAIN_WEIGHTS }
            item.sourceScores = reportPrediction?.sourceScores ?? pending.scoreTotals ?? {}
            item.patterns = reportPrediction?.patterns ?? item.patterns
            item.cardShoeFeatures = reportPrediction?.cardShoeFeatures ?? item.cardShoeFeatures
            item.strategyAdjustment = reportPrediction?.strategyAdjustment ?? item.strategyAdjustment
            item.predictionDiagnostics = reportPrediction ? {
              sourceScores: reportPrediction.sourceScores,
              weightAblation: reportPrediction.weightAblation,
              confidenceCalibration: reportPrediction.confidenceCalibration,
              strategyAdjustment: reportPrediction.strategyAdjustment,
              patterns: reportPrediction.patterns,
              cardShoeFeatures: reportPrediction.cardShoeFeatures,
              predictionTiming: 'pre_result_context',
              strategyVersion: pending.strategyVersion,
            } : { predictionTiming: 'pre_result_context', strategyVersion: pending.strategyVersion }

            const score = scoreMainPrediction(predictionMain, winner, pending.confidence)
            if (score.push) item.pushes += 1
            if (score.evaluated) {
              item.mainEvaluated += 1
              if (score.hit) item.hits += 1
              else item.misses += 1
              recordStrategyAdjustmentResult(item.strategyAdjustmentStats, reportPrediction?.strategyAdjustment?.mode, score)
              item.performanceTracker.record({ prediction: predictionMain, winner })
              item.tablePerformance = item.performanceTracker.summary()
            }
            recordSideLearning(item, pending.sidePredictions, actualSide, predictionMain, pending.sideActions)
            item.pendingPrediction = null
          }
        }
        const nextPending = buildLivePrediction(table)
        const currentPending = item.pendingPrediction
        if (!currentPending
          || String(currentPending.targetShoe ?? '') !== String(nextPending.targetShoe ?? '')
          || Number(currentPending.targetRound) !== Number(nextPending.targetRound)) {
          item.pendingPrediction = structuredClone(nextPending)
        }
      })
    },

    getReport(endedAt = new Date().toISOString()) {
      const reportTables = Array.from(tables.values())
        .sort((a, b) => a.slot - b.slot)
        .map((table) => ({
          tableId: table.tableId,
          slot: table.slot,
          displayName: table.displayName,
          rounds: table.rounds,
          hits: table.hits,
          misses: table.misses,
          pushes: table.pushes,
          mainEvaluated: table.mainEvaluated,
          hitRate: percent(table.hits, table.mainEvaluated),
          sideLearningSamples: table.sideLearningSamples,
          sideActions: table.sideActions,
          sideHits: table.sideHits,
          sideHitRate: percent(table.sideHits, table.sideActions),
          sidePredictions: table.sidePredictions,
          predictionWeights: table.predictionWeights,
          sourceScores: table.sourceScores,
          patterns: table.patterns,
          cardShoeFeatures: table.cardShoeFeatures,
          tablePerformance: table.tablePerformance,
          strategyAdjustment: table.strategyAdjustment,
          strategyAdjustmentStats: table.strategyAdjustmentStats,
          predictionDiagnostics: table.predictionDiagnostics,
          lastWinner: table.lastWinner,
          lastPrediction: table.lastPrediction,
          lastConfidence: table.lastConfidence,
          lastSidePredictions: table.lastSidePredictions,
          lastSideActions: table.lastSideActions,
          lastPointText: table.lastPointText,
        }))
      const totals = reportTables.reduce((acc, table) => {
        acc.rounds += table.rounds
        acc.hits += table.hits
        acc.misses += table.misses
        acc.pushes += table.pushes
        acc.mainEvaluated += table.mainEvaluated
        acc.sideLearningSamples += table.sideLearningSamples
        acc.sideActions += table.sideActions
        acc.sideHits += table.sideHits
        return acc
      }, { rounds: 0, hits: 0, misses: 0, pushes: 0, mainEvaluated: 0, sideLearningSamples: 0, sideActions: 0, sideHits: 0 })
      const strategyAdjustmentSummary = summarizeStrategyAdjustmentStats(reportTables)
      return {
        version: '100',
        title: '瑞文AI百家策略調整成效統計與AB追蹤報表',
        startedAt,
        endedAt,
        lastSnapshotAt,
        targetTableCount,
        sidePredictionThresholds: SIDE_PREDICTION_THRESHOLDS,
        mainPredictionWeights: FORMAL_MAIN_PREDICTION_WEIGHTS,
        reportMainPredictionWeights: REPORT_MAIN_WEIGHTS,
        displayOnly: { main: '主副預測命中率', hideSourceWeightHitRates: true },
        status: {
          connected: lastStatus.connected === true,
          authenticated: lastStatus.authenticated !== false,
          tableCount: Number(lastStatus.tableCount ?? reportTables.length ?? 0),
          captureMode: lastStatus.captureMode ?? null,
          lastMessageAt: lastStatus.lastMessageAt ?? null,
          errorMessage: lastStatus.errorMessage ?? null,
        },
        tables: reportTables,
        strategyAdjustmentSummary,
        total: {
          ...totals,
          hitRate: percent(totals.hits, totals.mainEvaluated),
          sideHitRate: percent(totals.sideHits, totals.sideActions),
        },
      }
    },
  }
}

export function parseDurationMs(value = '10m') {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const text = String(value).trim().toLowerCase()
  const match = text.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/)
  if (!match) throw new Error(`Invalid duration: ${value}`)
  const amount = Number(match[1])
  const unit = match[2] ?? 'ms'
  if (unit === 'ms') return Math.round(amount)
  if (unit === 's') return Math.round(amount * 1000)
  if (unit === 'm') return Math.round(amount * 60_000)
  if (unit === 'h') return Math.round(amount * 3_600_000)
  throw new Error(`Invalid duration unit: ${unit}`)
}

export function formatReportText(report) {
  if (report?.version === '100-row-contract') return formatSavedRowsReportText(report)
  const lines = []
  lines.push(`## ${report.title}`)
  lines.push('')
  lines.push(`期間：${formatTime(report.startedAt)} ～ ${formatTime(report.endedAt)}`)
  lines.push(`連線：${report.status.connected ? '已連線' : '未連線'} / 桌數 ${report.status.tableCount}`)
  if (report.status.errorMessage) lines.push(`錯誤：${report.status.errorMessage}`)
  lines.push('')
  lines.push(`主預測命中率：${report.total.hitRate}%（命中 ${report.total.hits} / 未中 ${report.total.misses} / 和局不計 ${report.total.pushes} / 主統計 ${report.total.mainEvaluated} / 總局 ${report.total.rounds}）`)
  lines.push(`副預測出手命中率：${report.total.sideHitRate}%（出手 ${report.total.sideActions} / 命中 ${report.total.sideHits} / 學習樣本 ${report.total.sideLearningSamples}）`)
  if (report.strategyAdjustmentSummary) {
    const summary = report.strategyAdjustmentSummary.byMode
    lines.push(`策略調整成效：正常 ${formatStrategyModeSummary(summary.normal)} / 弱桌降權 ${formatStrategyModeSummary(summary.weakTableDeweight)} / 反向修正 ${formatStrategyModeSummary(summary.reverseCorrection)} / 強桌加權 ${formatStrategyModeSummary(summary.strongTableBoost)}`)
  }
  lines.push('')
  lines.push('| 桌台 | 局數 | 主命中 | 主未中 | 和局不計 | 主命中率 | 近況 | 副樣本 | 副出手 | 副命中 | 最後結果 |')
  lines.push('|---|---:|---:|---:|---:|---:|---|---:|---:|---:|---|')
  for (const table of report.tables) {
    const perf = table.tablePerformance ? `${table.tablePerformance.hitRate}%/${table.tablePerformance.tier}` : '-'
    lines.push(`| ${table.displayName} | ${table.rounds} | ${table.hits} | ${table.misses} | ${table.pushes} | ${table.hitRate}% | ${perf} | ${table.sideLearningSamples} | ${table.sideActions} | ${table.sideHits} | ${table.lastPrediction ?? '-'}(${table.lastConfidence ?? '-'}%)→${table.lastWinner ?? '-'} ${table.lastPointText ?? ''} |`)
  }
  return lines.join('\n')
}

function formatSavedRowsReportText(report) {
  const rate = (value) => value == null ? '-' : `${value}%`
  const lines = [
    '## v102 已保存預測結算報表',
    '',
    `主預測命中率：${rate(report.total.hitRate)}（命中 ${report.total.hits} / 未中 ${report.total.misses} / 和局不計 ${report.total.pushes} / 主統計 ${report.total.mainEvaluated} / 總局 ${report.total.rounds}）`,
    `副預測出手命中率：${rate(report.total.sideHitRate)}（出手 ${report.total.sideActions} / 命中 ${report.total.sideHits}）`,
    `無效列：${report.invalidRows.length}`,
    '',
    '| 桌台 | 局數 | 主命中 | 主未中 | 和局不計 | 主命中率 | 副出手 | 副命中 | 副命中率 |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
  ]
  for (const table of report.tables) {
    lines.push(`| ${table.tableId} | ${table.rounds} | ${table.hits} | ${table.misses} | ${table.pushes} | ${rate(table.hitRate)} | ${table.sideActions} | ${table.sideHits} | ${rate(table.sideHitRate)} |`)
  }
  return lines.join('\n')
}

export function evaluateFiveRoadPrediction(table = {}, { globalStats = null, tablePerformance = null } = {}) {
  const bead = parseBeadOutcomes(table.beadPlateRaw)
  const bigRoad = parseBigRoadOutcomes(table.bigRoadRaw)
  const cardShoe = scoreCardShoeInfluence({ lastRound: table.lastRound ?? {}, shoeState: table.shoeState ?? null })
  const performance = normalizeTablePerformance(tablePerformance ?? table.tablePerformance)
  const shoeOutcomes = bigRoad.length ? bigRoad : bead
  const auxiliaryRoads = addScores(
    derivedRoadScore(bigRoad, 1),
    derivedRoadScore(bigRoad, 2),
    derivedRoadScore(bigRoad, 3),
  )
  const sourceScores = {
    shoeRoad: directionalScore(shoeOutcomes),
    askRoad: askRoadScore(table),
    recentTrend: roadTrendScore(shoeOutcomes),
    bankerPlayerStats: addScores(
      { banker: Number(table.bankerCount ?? 0), player: Number(table.playerCount ?? 0) },
      { banker: Number(globalStats?.banker ?? 0), player: Number(globalStats?.player ?? 0) },
      performance.directionScore,
    ),
    auxiliaryRoads,
    beadRoad: directionalScore(bead),
  }
  const totalScore = combineWeightedScores(sourceScores, REPORT_MAIN_WEIGHTS)
  const rawMain = totalScore.banker >= totalScore.player ? '莊' : '閒'
  const strategyAdjustment = buildV036StrategyAdjustment(rawMain, performance, totalScore)
  const main = strategyAdjustment.adjustedMain
  const difference = Math.abs(totalScore.banker - totalScore.player)
  const rawConfidence = difference < 1e-9 ? 30 : calculateConservativeMainConfidence(sourceScores, REPORT_MAIN_WEIGHTS)
  const confidenceCalibration = calibrateConfidenceForTablePerformance(rawConfidence, performance, strategyAdjustment)
  const confidence = confidenceCalibration.finalConfidence
  return {
    main,
    confidence,
    weights: REPORT_MAIN_WEIGHTS,
    sourceScores,
    weightAblation: buildWeightAblation(sourceScores, REPORT_MAIN_WEIGHTS, totalScore),
    confidenceCalibration,
    strategyAdjustment,
    cardShoeFeatures: cardShoe.features,
    tablePerformance: performance.publicSummary,
    patterns: detectRoadTrends(bigRoad.length ? bigRoad : bead),
  }
}


function combineWeightedScores(sourceScores, weights = MAIN_PREDICTION_WEIGHTS, omitKey = null) {
  return Object.entries(weights).reduce((acc, [key, weight]) => {
    if (key === omitKey) return acc
    const score = sourceScores[key] ?? { banker: 0, player: 0 }
    acc.banker += Number(score.banker ?? 0) * weight
    acc.player += Number(score.player ?? 0) * weight
    return acc
  }, { banker: 0, player: 0 })
}

function calculateConservativeMainConfidence(sourceScores = {}, weights = MAIN_PREDICTION_WEIGHTS) {
  let activeWeight = 0
  let agreementSum = 0
  let strengthSum = 0
  for (const [key, rawWeight] of Object.entries(weights)) {
    const weight = Math.max(0, Number(rawWeight ?? 0))
    if (!weight) continue
    const score = sourceScores[key] ?? { banker: 0.5, player: 0.5 }
    const banker = Math.max(0, Number(score.banker ?? 0.5))
    const player = Math.max(0, Number(score.player ?? 0.5))
    const total = banker + player
    const share = total > 0 ? banker / total : 0.5
    const edge = Math.abs(share - 0.5) * 2
    const signedEdge = share >= 0.5 ? edge : -edge
    activeWeight += weight
    agreementSum += weight * signedEdge
    strengthSum += weight * edge
  }
  if (!activeWeight) return 30
  const agreement = Math.abs(agreementSum) / activeWeight
  const strength = strengthSum / activeWeight
  const combined = clamp(agreement * 0.7 + strength * 0.3, 0, 1)
  const rawConfidence = 30 + 40 * combined
  return Math.round(clamp(45 + 2 * (rawConfidence - 32.03), 30, 70))
}

function buildWeightAblation(sourceScores, weights, totalScore) {
  const baseMain = totalScore.banker >= totalScore.player ? '莊' : '閒'
  const baseMargin = Math.round(Math.abs(totalScore.banker - totalScore.player) * 1000) / 1000
  const sources = Object.entries(weights).map(([key, weight]) => {
    const score = sourceScores[key] ?? { banker: 0, player: 0 }
    const without = combineWeightedScores(sourceScores, weights, key)
    const withoutMain = without.banker >= without.player ? '莊' : '閒'
    const withoutMargin = Math.round(Math.abs(without.banker - without.player) * 1000) / 1000
    return {
      key,
      weight,
      contribution: {
        banker: Math.round(Number(score.banker ?? 0) * weight * 1000) / 1000,
        player: Math.round(Number(score.player ?? 0) * weight * 1000) / 1000,
      },
      withoutMain,
      flipsMain: withoutMain !== baseMain,
      marginDelta: Math.round((baseMargin - withoutMargin) * 1000) / 1000,
    }
  }).sort((a, b) => Math.abs(b.marginDelta) - Math.abs(a.marginDelta))
  return { baseMain, baseMargin, sources }
}

function predictMainOutcome(table = {}, globalStats = null, tablePerformance = null) {
  return evaluateFiveRoadPrediction(table, { globalStats, tablePerformance })
}

function predictSideOutcomes(table = {}) {
  const banker = Number(table.bankerCount ?? 0)
  const player = Number(table.playerCount ?? 0)
  const tie = Number(table.tieCount ?? 0)
  const total = Math.max(1, banker + player + tie)
  const bankerRate = percent(banker, total)
  const playerRate = percent(player, total)
  const cardShoe = scoreCardShoeInfluence({ lastRound: table.lastRound ?? {}, shoeState: table.shoeState ?? null })
  return {
    tie: clamp(percent(tie, total) * 0.8 + cardShoe.side.tie * 0.2, 0, 80),
    superSix: clamp((bankerRate * 0.5) * 0.7 + cardShoe.side.superSix * 0.3, 0, 80),
    bankerPair: clamp(percent(Number(table.bankerPairCount ?? 0), total) * 0.8 + cardShoe.side.bankerPair * 0.2, 0, 80),
    playerPair: clamp(percent(Number(table.playerPairCount ?? 0), total) * 0.8 + cardShoe.side.playerPair * 0.2, 0, 80),
    bankerDragon: clamp((bankerRate * 0.7) * 0.75 + cardShoe.side.bankerDragon * 0.25, 0, 80),
    playerDragon: clamp((playerRate * 0.7) * 0.75 + cardShoe.side.playerDragon * 0.25, 0, 80),
  }
}


export function createTablePerformanceTracker({ windowSize = 18 } = {}) {
  const history = []
  return {
    record({ prediction, winner } = {}) {
      if ((prediction !== '莊' && prediction !== '閒') || (winner !== '莊' && winner !== '閒')) return
      history.push({ prediction, winner, hit: prediction === winner })
      while (history.length > windowSize) history.shift()
    },
    summary() {
      const evaluated = history.length
      const hits = history.filter((item) => item.hit).length
      const hitRate = percent(hits, evaluated)
      const misses = evaluated - hits
      const currentMissStreak = countCurrentMissStreak(history)
      const reverseSignal = detectReverseSignal(history)
      const tier = currentMissStreak >= 3 ? 'low' : evaluated >= 5 && hitRate < 40 ? 'low' : evaluated < 6 ? 'learning' : hitRate < 45 ? 'low' : hitRate >= 60 ? 'strong' : 'normal'
      const bankerHits = history.filter((item) => item.hit && item.winner === '莊').length
      const playerHits = history.filter((item) => item.hit && item.winner === '閒').length
      const bankerActuals = history.filter((item) => item.winner === '莊').length
      const playerActuals = history.filter((item) => item.winner === '閒').length
      const actualBiasRate = evaluated ? Math.max(bankerActuals, playerActuals) / evaluated : 0
      const actualBias = evaluated >= 5 && actualBiasRate >= 0.6 ? (bankerActuals >= playerActuals ? '莊' : '閒') : null
      return { windowSize: evaluated, configuredWindowSize: windowSize, hits, misses, hitRate, tier, bankerHits, playerHits, bankerActuals, playerActuals, actualBias, actualBiasRate: Math.round(actualBiasRate * 1000) / 10, currentMissStreak, reverseSignal }
    },
  }
}

function normalizeTablePerformance(summary) {
  const publicSummary = summary ?? createTablePerformanceTracker().summary()
  const hitRate = Number(publicSummary.hitRate ?? 0)
  const tier = publicSummary.tier ?? 'learning'
  const bankerHits = Number(publicSummary.bankerHits ?? 0)
  const playerHits = Number(publicSummary.playerHits ?? 0)
  const directionScore = { banker: 0, player: 0 }
  if (tier === 'strong') {
    directionScore.banker = 2 + bankerHits
    directionScore.player = 2 + playerHits
  } else if (tier === 'normal') {
    directionScore.banker = 1 + bankerHits / 2
    directionScore.player = 1 + playerHits / 2
  } else if (tier === 'low') {
    // Keep predicting 莊/閒, but pull confidence down and avoid over-trusting this table.
    directionScore.banker = 0.05
    directionScore.player = 0.05
  }
  const reverseSignal = publicSummary.reverseSignal === '莊' || publicSummary.reverseSignal === '閒' ? publicSummary.reverseSignal : null
  const actualBias = publicSummary.actualBias === '莊' || publicSummary.actualBias === '閒' ? publicSummary.actualBias : null
  if (tier === 'low' && !reverseSignal && actualBias === '莊') directionScore.banker += 100
  if (tier === 'low' && !reverseSignal && actualBias === '閒') directionScore.player += 100
  if (reverseSignal === '莊') directionScore.banker += 120
  if (reverseSignal === '閒') directionScore.player += 120
  return { publicSummary: { ...publicSummary, hitRate, tier, reverseSignal, actualBias }, directionScore }
}

function buildV036StrategyAdjustment(rawMain, performance, totalScore = {}) {
  const summary = performance.publicSummary ?? {}
  const tier = summary.tier ?? 'learning'
  const reverseSignal = summary.reverseSignal === '莊' || summary.reverseSignal === '閒' ? summary.reverseSignal : null
  const currentMissStreak = Number(summary.currentMissStreak ?? 0)
  const hitRate = Number(summary.hitRate ?? 0)
  const weak = tier === 'low' || (Number(summary.windowSize ?? 0) >= 5 && hitRate < 45)
  const reverseSignalPresent = Boolean(reverseSignal)
  if (weak && currentMissStreak >= 3 && reverseSignalPresent) {
    return { mode: 'reverse-correction', statusText: '反向修正啟用', rawMain, adjustedMain: reverseSignal, reason: 'weak-table-three-miss-opposite-road', hitRate, currentMissStreak, totalScore }
  }
  if (weak) {
    return { mode: 'weak-table-deweight', statusText: '弱桌降權中', rawMain, adjustedMain: rawMain, reason: 'weak-table-low-hit-rate', hitRate, currentMissStreak, totalScore }
  }
  if (tier === 'strong') {
    return { mode: 'strong-table-boost', statusText: '強桌加權中', rawMain, adjustedMain: rawMain, reason: 'strong-table-conservative-boost', hitRate, currentMissStreak, totalScore }
  }
  return { mode: 'normal', statusText: '正常策略', rawMain, adjustedMain: rawMain, reason: 'normal', hitRate, currentMissStreak, totalScore }
}

function calibrateConfidenceForTablePerformance(confidence, performance, strategyAdjustment = null) {
  const summary = performance.publicSummary
  const tier = summary.tier
  const hitRate = Number(summary.hitRate ?? 0)
  const currentMissStreak = Number(summary.currentMissStreak ?? 0)
  const windowSize = Number(summary.windowSize ?? 0)
  let finalConfidence = confidence
  let reason = 'raw'
  if (strategyAdjustment?.mode === 'reverse-correction') {
    const cap = currentMissStreak >= 3 || (windowSize >= 5 && hitRate < 40) ? 40 : 55
    finalConfidence = clamp(Math.min(confidence - 18, cap), 30, cap)
    reason = 'reverse-correction-cap'
  } else if (strategyAdjustment?.mode === 'weak-table-deweight') {
    const cap = currentMissStreak >= 3 || (windowSize >= 5 && hitRate < 40) ? 40 : 46
    finalConfidence = clamp(Math.min(confidence - 14, cap), 30, cap)
    reason = 'weak-table-deweight-cap'
  } else if (currentMissStreak >= 3 || (windowSize >= 5 && hitRate < 40)) {
    finalConfidence = clamp(Math.min(confidence - 20, 40), 30, 40)
    reason = currentMissStreak >= 3 ? 'three-miss-cap' : 'very-low-hit-rate-cap'
  } else if (tier === 'low') {
    finalConfidence = clamp(Math.min(confidence - 14, 46), 30, 46)
    reason = 'low-table-cap'
  } else if (strategyAdjustment?.mode === 'strong-table-boost' || tier === 'strong') {
    finalConfidence = clamp(confidence + 4, 30, 70)
    reason = 'strong-table-conservative-boost'
  }
  return { rawConfidence: confidence, finalConfidence, reason, tier, hitRate, currentMissStreak, windowSize, strategyMode: strategyAdjustment?.mode ?? 'normal' }
}

function adjustConfidenceForTablePerformance(confidence, performance) {
  return calibrateConfidenceForTablePerformance(confidence, performance).finalConfidence
}

function countCurrentMissStreak(history) {
  let count = 0
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index].hit) break
    count += 1
  }
  return count
}

function detectReverseSignal(history) {
  const tail = history.slice(-3)
  if (tail.length < 3) return null
  if (!tail.every((item) => item.hit === false)) return null
  const prediction = tail[0].prediction
  const winner = tail[0].winner
  if (!tail.every((item) => item.prediction === prediction && item.winner === winner)) return null
  return winner === '莊' || winner === '閒' ? winner : null
}

function scoreMainPrediction(prediction, winner, confidence = 100) {
  if (Number(confidence ?? 0) < MAIN_ACTION_CONFIDENCE_THRESHOLD) return { evaluated: false, hit: false, push: false }
  if (winner === '和') return { evaluated: false, hit: false, push: true }
  if (winner !== '莊' && winner !== '閒') return { evaluated: false, hit: false, push: false }
  return { evaluated: true, hit: prediction === winner, push: false }
}

function recordSideLearning(item, predictions, actuals, mainPrediction, savedActions = null) {
  const actions = exactSavedFlags(savedActions)
  if (!actions) return
  for (const key of Object.keys(SIDE_PREDICTION_THRESHOLDS)) {
    const probability = predictions[key] ?? 0
    const actionable = actions[key]
    const hit = actionable && actuals[key] === true
    item.sideLearningSamples += 1
    if (actionable) item.sideActions += 1
    if (hit) item.sideHits += 1
    const summary = item.sidePredictions[key]
    summary.probability = probability
    summary.samples += 1
    if (actionable) summary.actions += 1
    if (hit) summary.hits += 1
    summary.actionable = actionable
    summary.hitRate = percent(summary.hits, summary.actions)
  }
}

function buildSideActions(predictions = {}, mainPrediction = null) {
  const actions = Object.fromEntries(Object.entries(SIDE_PREDICTION_THRESHOLDS).map(([key, threshold]) => [key, Number(predictions[key] ?? 0) >= threshold]))
  const bankerDragon = Number(predictions.bankerDragon ?? 0)
  const playerDragon = Number(predictions.playerDragon ?? 0)
  actions.superSix = Boolean(actions.superSix) && mainPrediction === '莊'
  actions.bankerDragon = mainPrediction === '莊' && bankerDragon >= SIDE_PREDICTION_THRESHOLDS.bankerDragon
  actions.playerDragon = mainPrediction === '閒' && playerDragon >= SIDE_PREDICTION_THRESHOLDS.playerDragon
  return actions
}

function actualSideOutcomes(winner, round = {}) {
  const bankerPoint = Number(round.bankerPoint)
  const playerPoint = Number(round.playerPoint)
  const hasPoints = Number.isFinite(bankerPoint) && Number.isFinite(playerPoint)
  return {
    tie: winner === '和',
    superSix: winner === '莊' && hasPoints && bankerPoint === 6,
    bankerPair: round.bankerPair === true,
    playerPair: round.playerPair === true,
    bankerDragon: winner === '莊' && hasPoints && Math.abs(bankerPoint - playerPoint) >= 4,
    playerDragon: winner === '閒' && hasPoints && Math.abs(playerPoint - bankerPoint) >= 4,
  }
}

function summarizeGlobalStats(tables, fallback) {
  const summary = tables.reduce((acc, table) => {
    acc.banker += Number(table.bankerCount ?? 0)
    acc.player += Number(table.playerCount ?? 0)
    acc.tie += Number(table.tieCount ?? 0)
    return acc
  }, { banker: 0, player: 0, tie: 0 })
  return summary.banker + summary.player + summary.tie ? summary : fallback
}

function createEmptySidePredictionSummary() {
  return Object.fromEntries(Object.keys(SIDE_PREDICTION_THRESHOLDS).map((key) => [key, {
    probability: 0,
    actionable: false,
    samples: 0,
    actions: 0,
    hits: 0,
    hitRate: 0,
  }]))
}

function createStrategyAdjustmentStats() {
  return {
    normal: createEmptyStrategyModeStats(),
    weakTableDeweight: createEmptyStrategyModeStats(),
    reverseCorrection: createEmptyStrategyModeStats(),
    strongTableBoost: createEmptyStrategyModeStats(),
  }
}

function createEmptyStrategyModeStats() {
  return { evaluated: 0, hits: 0, misses: 0, hitRate: 0 }
}

function normalizeStrategyAdjustmentMode(mode) {
  if (mode === 'weak-table-deweight') return 'weakTableDeweight'
  if (mode === 'reverse-correction') return 'reverseCorrection'
  if (mode === 'strong-table-boost') return 'strongTableBoost'
  return 'normal'
}

function recordStrategyAdjustmentResult(stats, mode, score) {
  const key = normalizeStrategyAdjustmentMode(mode)
  const item = stats[key] ?? stats.normal
  item.evaluated += 1
  if (score.hit) item.hits += 1
  else item.misses += 1
  item.hitRate = percent(item.hits, item.evaluated)
}

function summarizeStrategyAdjustmentStats(tables) {
  const byMode = createStrategyAdjustmentStats()
  for (const table of tables) {
    for (const key of Object.keys(byMode)) {
      const source = table.strategyAdjustmentStats?.[key]
      if (!source) continue
      byMode[key].evaluated += Number(source.evaluated ?? 0)
      byMode[key].hits += Number(source.hits ?? 0)
      byMode[key].misses += Number(source.misses ?? 0)
    }
  }
  let totalEvaluated = 0
  for (const item of Object.values(byMode)) {
    item.hitRate = percent(item.hits, item.evaluated)
    totalEvaluated += item.evaluated
  }
  return { totalEvaluated, byMode }
}

function formatStrategyModeSummary(item = createEmptyStrategyModeStats()) {
  return `${item.hitRate ?? 0}%（${item.hits ?? 0}/${item.evaluated ?? 0}）`
}

function parseBeadOutcomes(raw = '') {
  return String(raw).split('#').flatMap((column) => (column.match(/\d{2}/g) ?? []).map((code) => {
    if (code[1] === '1') return '閒'
    if (code[1] === '2') return '莊'
    if (code[1] === '3') return '和'
    return null
  }).filter(Boolean))
}

function parseBigRoadOutcomes(raw = '') {
  return String(raw).split('#').flatMap((column) => column.split(',').map((code) => {
    const last = code.trim().at(-1)
    if (last === '1') return '閒'
    if (last === '2') return '莊'
    return null
  }).filter(Boolean))
}

function addScores(...scores) {
  return scores.reduce((acc, score) => ({
    banker: acc.banker + Number(score?.banker ?? 0),
    player: acc.player + Number(score?.player ?? 0),
  }), { banker: 0, player: 0 })
}

function directionalScore(outcomes, sampleSize = 12) {
  const recent = outcomes.filter((outcome) => outcome === '莊' || outcome === '閒').slice(-sampleSize)
  const banker = recent.filter((outcome) => outcome === '莊').length
  const player = recent.length - banker
  const trends = detectRoadTrends(recent)
  const score = { banker, player }
  const last = recent.at(-1)
  if (trends.longDragon.side === '莊') score.banker += Math.min(4, trends.longDragon.length)
  if (trends.longDragon.side === '閒') score.player += Math.min(4, trends.longDragon.length)
  if ((trends.singleJump || trends.doubleJump) && last) score[last === '莊' ? 'player' : 'banker'] += 2
  if (trends.upSlope && last) score[last === '莊' ? 'banker' : 'player'] += 2
  if (trends.downSlope && last) score[last === '莊' ? 'player' : 'banker'] += 1
  if (trends.doubleDragon && last) score[last === '莊' ? 'banker' : 'player'] += 1
  return score
}

function derivedRoadScore(outcomes, offset) {
  const seq = outcomes.filter((outcome) => outcome === '莊' || outcome === '閒')
  if (seq.length <= offset + 2) return directionalScore(seq)
  const derived = seq.slice(offset).map((value, index) => value === seq[index] ? '莊' : '閒')
  return directionalScore(derived)
}

function roadTrendScore(outcomes = []) {
  const seq = outcomes.filter((outcome) => outcome === '莊' || outcome === '閒')
  const trends = detectRoadTrends(seq)
  const last = seq.at(-1)
  const score = { banker: 0, player: 0 }
  const add = (side, value) => {
    if (side === '莊') score.banker += value
    if (side === '閒') score.player += value
  }
  const opposite = (side) => side === '莊' ? '閒' : side === '閒' ? '莊' : null
  const cycleNext = patternNextSide(seq)

  if (trends.longDragon.side) add(trends.longDragon.side, Math.min(6, trends.longDragon.length * 1.2))
  if (trends.singleJump && last) add(opposite(last), 5)
  if (trends.doubleJump && last) add(opposite(last), 4)
  if (trends.threeJump && last) add(opposite(last), 4)
  if (trends.oneBankerTwoPlayer) add('莊', 5)
  if (trends.onePlayerTwoBanker) add('閒', 5)
  if (trends.rowPairRun && last) add(opposite(last), 3)
  if (trends.bankerThenJump) add(last === '莊' ? '閒' : '莊', 2)
  if (trends.playerThenJump) add(last === '閒' ? '莊' : '閒', 2)
  if (trends.bankerThenRun) add('莊', 3)
  if (trends.playerThenRun) add('閒', 3)
  if (trends.brokenSingleJump && last) add(last, 4)
  if (trends.longDragonToSingleJump && last) add(opposite(last), 3)
  if (trends.singleJumpToLongDragon && last) add(last, 4)
  if (cycleNext) add(cycleNext, 2)
  if (trends.doubleDragon && last) add(last, 3)
  if (trends.upSlope && last) add(last, 3)
  if (trends.downSlope && last) add(opposite(last), 2)
  return score
}

function askRoadScore(table = {}) {
  const banker = scoreRawAsk(table.nextBankerRaw ?? table.next_banker2)
  const player = scoreRawAsk(table.nextPlayerRaw ?? table.next_player2)
  return { banker, player }
}

function scoreRawAsk(raw) {
  if (raw == null) return 0
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw)
  return (text.toLowerCase().match(/red|紅/g) ?? []).length + (text.match(/1/g) ?? []).length
}

export function detectRoadTrends(outcomes = []) {
  const seq = outcomes.map((outcome) => outcome === 'Banker' ? '莊' : outcome === 'Player' ? '閒' : outcome).filter((outcome) => outcome === '莊' || outcome === '閒')
  const recent = seq.slice(-18)
  const groups = groupRuns(recent)
  const singleJump = recent.length >= 5 && recent.slice(-5).every((value, index, arr) => index === 0 || value !== arr[index - 1])
  const last6 = recent.slice(-6)
  const doubleJump = last6.length >= 6 && last6[0] === last6[1] && last6[2] === last6[3] && last6[4] === last6[5] && last6[0] !== last6[2] && last6[2] !== last6[4]
  const strongestRun = groups.reduce((best, run) => run.length > best.length ? run : best, { side: null, length: 0 })
  const longDragon = { side: strongestRun.length >= 3 ? strongestRun.side : null, length: strongestRun.length }
  const doubleDragon = groups.length >= 2 && groups.slice(-2).every((run) => run.length >= 3)
  const lengths = groups.map((run) => run.length).slice(-4)
  const upSlope = lengths.length >= 3 && lengths.every((length, index) => index === 0 || length >= lengths[index - 1]) && lengths.at(-1) > lengths[0]
  const downSlope = lengths.length >= 3 && lengths.every((length, index) => index === 0 || length <= lengths[index - 1]) && lengths.at(-1) < lengths[0]
  const lastGroups3 = groups.slice(-3)
  const threeJump = lastGroups3.length === 3 && lastGroups3.every((run) => run.length === 3) && lastGroups3[0].side === lastGroups3[2].side && lastGroups3[0].side !== lastGroups3[1].side
  const oneBankerTwoPlayer = tailMatches(recent, ['莊', '閒', '閒', '莊', '閒', '閒'])
  const onePlayerTwoBanker = tailMatches(recent, ['閒', '莊', '莊', '閒', '莊', '莊'])
  const rowPairRun = groups.length >= 4 && groups.slice(-4).every((run) => run.length >= 2)
  const bankerThenJump = countFollowedBy(recent, '莊', '閒') >= 3
  const playerThenJump = countFollowedBy(recent, '閒', '莊') >= 3
  const bankerThenRun = countRunPattern(recent, ['莊', '莊', '閒']) >= 2 || tailMatches(recent, ['莊', '莊', '閒', '莊'])
  const playerThenRun = countRunPattern(recent, ['閒', '閒', '莊']) >= 2 || tailMatches(recent, ['閒', '閒', '莊', '閒'])
  const lastSix = recent.slice(-6)
  const brokenSingleJump = lastSix.length === 6 && lastSix.slice(0, 5).every((value, index, arr) => index === 0 || value !== arr[index - 1]) && lastSix[5] === lastSix[4]
  const longDragonToSingleJump = groups.length >= 4 && groups.slice(-4)[0].length >= 3 && groups.slice(-3).every((run) => run.length === 1)
  const singleJumpToLongDragon = groups.length >= 4 && groups.at(-1).length >= 2 && groups.slice(0, -1).slice(-4).every((run) => run.length === 1)
  return { singleJump, doubleJump, threeJump, oneBankerTwoPlayer, onePlayerTwoBanker, rowPairRun, bankerThenJump, playerThenJump, bankerThenRun, playerThenRun, brokenSingleJump, longDragonToSingleJump, singleJumpToLongDragon, doubleDragon, upSlope, downSlope, longDragon }
}

function tailMatches(seq, pattern) {
  if (seq.length < pattern.length) return false
  const tail = seq.slice(-pattern.length)
  return pattern.every((value, index) => tail[index] === value)
}

function countFollowedBy(seq, fromSide, toSide) {
  let count = 0
  for (let index = 0; index < seq.length - 1; index += 1) {
    if (seq[index] === fromSide && seq[index + 1] === toSide) count += 1
  }
  return count
}

function countRunPattern(seq, pattern) {
  let count = 0
  for (let index = 0; index <= seq.length - pattern.length; index += 1) {
    if (pattern.every((value, offset) => seq[index + offset] === value)) count += 1
  }
  return count
}

function patternNextSide(seq) {
  if (tailMatches(seq, ['莊', '閒', '閒', '莊', '閒', '閒'])) return '莊'
  if (tailMatches(seq, ['閒', '莊', '莊', '閒', '莊', '莊'])) return '閒'
  if (tailMatches(seq, ['莊', '莊', '莊', '閒', '閒', '閒'])) return '莊'
  if (tailMatches(seq, ['閒', '閒', '閒', '莊', '莊', '莊'])) return '閒'
  return null
}

function groupRuns(seq) {
  const groups = []
  for (const side of seq) {
    const last = groups.at(-1)
    if (last?.side === side) last.length += 1
    else groups.push({ side, length: 1 })
  }
  return groups
}

function normalizeRound(round) {
  if (!round || typeof round !== 'object') return null
  if (round.winner == null || round.round == null) return null
  return round
}

function normalizeWinner(value) {
  const key = typeof value === 'string' ? value.toLowerCase() : value
  return WINNER_LABELS.get(key) ?? null
}

function formatPointText(round) {
  const player = round.playerPoint
  const banker = round.bankerPoint
  if (player == null || banker == null) return null
  return `閒${player}/莊${banker}`
}

function percent(numerator, denominator) {
  if (!denominator) return 0
  return Math.round((numerator / denominator) * 1000) / 10
}

function clamp(value, min = 0, max = 99) {
  return Math.max(min, Math.min(max, Math.round(value)))
}

function formatTime(value) {
  if (!value) return '-'
  return String(value).replace('T', ' ').replace(/\.\d{3}Z$/, '')
}
