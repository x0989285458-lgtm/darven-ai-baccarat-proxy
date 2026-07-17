import fs from 'node:fs'
import crypto from 'node:crypto'
import {
  buildV100SideShadowActions,
  calculateV100SidePredictionShadow,
} from '../src/supabase-writer.js'
import {
  buildStrictTemporalRankState,
  deriveTrainOnlyCalibrationOffsets,
  reconstructV100BacktestTable,
} from '../src/v100-backtest.js'

const cohortPath = process.argv[2]
const eventsPath = process.argv[3]
const outputPath = process.argv[4]
if (!cohortPath || !eventsPath || !outputPath) {
  throw new Error('usage: node scripts/v100-strict-backtest.mjs <cohort.json> <events.json> <output.json>')
}
const cohort = JSON.parse(fs.readFileSync(cohortPath, 'utf8'))
const eventsDocument = JSON.parse(fs.readFileSync(eventsPath, 'utf8'))
const rows = [...cohort.rows].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)))
const events = eventsDocument.rows ?? eventsDocument
const targets = ['tie', 'superSix', 'bankerPair', 'playerPair', 'bankerDragon', 'playerDragon']
const weights = { ask_road_signals: 0.25, roadmap_trend_signals: 0.45, recent_practical_calibration: 0.20, shoe_banker_player_bias: 0.10 }
const threshold = { tie: 25, superSix: 45, bankerPair: 43, playerPair: 43, bankerDragon: 30, playerDragon: 30 }
const clamp = (value) => Math.max(0, Math.min(100, Number(value) || 0))

function identityKey(value) {
  return JSON.stringify([String(value.source ?? ''), String(value.table_id ?? value.tableId ?? ''), String(value.shoe_no ?? value.shoe ?? '')])
}
const eventsByIdentity = new Map()
for (const event of events) {
  const key = identityKey(event)
  const list = eventsByIdentity.get(key) ?? []
  list.push(event)
  eventsByIdentity.set(key, list)
}

function scoreDirection(total, row) {
  if (Math.abs(total.banker - total.player) > 1e-12) return total.banker > total.player ? 'banker' : 'player'
  const mt = row.prediction_features.mt_context ?? {}
  const banker = Number(mt.bankerCount ?? 0)
  const player = Number(mt.playerCount ?? 0)
  if (banker !== player) return banker > player ? 'player' : 'banker'
  return row.predicted_result
}

function reconstructMain(row) {
  const unified = row.prediction_features.unified_main_scores ?? {}
  const total = { banker: 0, player: 0 }
  for (const [key, weight] of Object.entries(weights)) {
    const score = unified[key]
    if (!score) throw new Error(`missing persisted unified main score: ${key} row=${row.id}`)
    total.banker += Number(score.banker) * weight
    total.player += Number(score.player) * weight
  }
  const baseline = scoreDirection(total, row)
  const ask = unified.ask_road_signals
  const shoe = unified.shoe_banker_player_bias
  const askMargin = Number(ask.banker) - Number(ask.player)
  const shoeMargin = Number(shoe.banker) - Number(shoe.player)
  let residual = shoeMargin
  if (askMargin !== 0 && shoeMargin !== 0 && Math.sign(askMargin) === Math.sign(shoeMargin)) {
    residual = Math.sign(shoeMargin) * Math.max(Math.abs(shoeMargin) - Math.abs(askMargin), 0)
  }
  residual = Math.max(-0.1, Math.min(0.1, residual))
  const candidate = {
    banker: total.banker - Number(shoe.banker) * weights.shoe_banker_player_bias + ((1 + residual) / 2) * weights.shoe_banker_player_bias,
    player: total.player - Number(shoe.player) * weights.shoe_banker_player_bias + ((1 - residual) / 2) * weights.shoe_banker_player_bias,
  }
  return { baseline, candidate: scoreDirection(candidate, row) }
}

const prepared = []
let baselineMainMismatches = 0
let v99MainChanges = 0
for (const row of rows) {
  const main = reconstructMain(row)
  if (main.baseline !== row.predicted_result) baselineMainMismatches += 1
  if (main.candidate !== row.predicted_result) v99MainChanges += 1
  const temporalRank = buildStrictTemporalRankState(row, eventsByIdentity.get(identityKey(row)) ?? [])
  const table = reconstructV100BacktestTable(row)
  if (temporalRank) table.v100RankLedger = temporalRank
  const side = calculateV100SidePredictionShadow({
    table,
    rankAvailable: Boolean(temporalRank),
    rankFallback: 'renormalize',
    mainPrediction: main.candidate,
    v98SidePredictions: row.prediction_features.side_predictions,
  })
  prepared.push({
    id: row.id,
    createdAt: row.created_at,
    main: main.candidate,
    rankAvailable: Boolean(temporalRank),
    raw: side.diagnostics.rawPredictions,
    actual: row.side_actual_results,
    baselineActions: row.prediction_features.side_actions,
  })
}
if (baselineMainMismatches !== 0) throw new Error(`v98 main reconstruction mismatch: ${baselineMainMismatches}`)

const splitIndex = Math.floor(prepared.length * 0.70)
const train = prepared.slice(0, splitIndex)
const holdout = prepared.slice(splitIndex)
const offsets = deriveTrainOnlyCalibrationOffsets(train)

function evaluate(items) {
  const stats = Object.fromEntries(targets.map((key) => [key, { actions: 0, hits: 0, events: 0, baselineActions: 0, baselineHits: 0, scores: [] }]))
  let rankAvailable = 0
  for (const item of items) {
    rankAvailable += Number(item.rankAvailable)
    const predictions = Object.fromEntries(targets.map((key) => [key, clamp(Number(item.raw[key]) + Number(offsets[key] ?? 0))]))
    const actions = buildV100SideShadowActions(predictions, item.main)
    for (const key of targets) {
      const target = stats[key]
      const actual = Boolean(item.actual?.[key])
      const action = Boolean(actions[key])
      const baselineAction = Boolean(item.baselineActions?.[key])
      target.actions += Number(action)
      target.hits += Number(action && actual)
      target.events += Number(actual)
      target.baselineActions += Number(baselineAction)
      target.baselineHits += Number(baselineAction && actual)
      target.scores.push(predictions[key])
    }
  }
  const summarized = Object.fromEntries(targets.map((key) => {
    const value = stats[key]
    const sorted = value.scores.sort((a, b) => a - b)
    return [key, {
      threshold: threshold[key],
      meanScore: Number((sorted.reduce((sum, score) => sum + score, 0) / Math.max(1, sorted.length)).toFixed(4)),
      medianScore: Number((sorted[Math.floor(sorted.length / 2)] ?? 0).toFixed(4)),
      actions: value.actions,
      actionRate: Number((value.actions / Math.max(1, items.length) * 100).toFixed(4)),
      hits: value.hits,
      precision: value.actions ? Number((value.hits / value.actions * 100).toFixed(4)) : null,
      events: value.events,
      eventCoverage: value.events ? Number((value.hits / value.events * 100).toFixed(4)) : null,
      baselineActions: value.baselineActions,
      baselineHits: value.baselineHits,
    }]
  }))
  return { rows: items.length, rankAvailable, rankCoverage: Number((rankAvailable / Math.max(1, items.length) * 100).toFixed(4)), targets: summarized }
}

const calibration = {
  method: 'chronological_train_product_runtime_quantile',
  splitIndex,
  trainRows: train.length,
  holdoutRows: holdout.length,
  trainFirstCreatedAt: train[0]?.createdAt ?? null,
  trainLastCreatedAt: train.at(-1)?.createdAt ?? null,
  holdoutFirstCreatedAt: holdout[0]?.createdAt ?? null,
  trainIdsSha256: crypto.createHash('sha256').update(train.map((item) => item.id).join('\n')).digest('hex'),
  offsets,
}
const report = {
  generatedAt: new Date().toISOString(),
  strategyVersion: 'v100_主副訊號去重與8副牌階完整性版',
  cohortPath,
  eventsPath,
  cohortCutoff: cohort.cutoff,
  eventCutoff: eventsDocument.cutoff ?? null,
  fallback: 'renormalize',
  temporalRankRule: 'all rounds 1..target-1 must have received_at <= prediction.created_at',
  baselineMainMismatches,
  v99MainChanges,
  calibration,
  all: evaluate(prepared),
  train: evaluate(train),
  holdout: evaluate(holdout),
}
fs.writeFileSync(outputPath, JSON.stringify(report, null, 2))
const calibrationPath = outputPath.replace(/\.json$/i, '-calibration.json')
fs.writeFileSync(calibrationPath, JSON.stringify(calibration, null, 2))
console.log(JSON.stringify({ outputPath, calibrationPath, baselineMainMismatches, v99MainChanges, strictRankAvailable: report.all.rankAvailable, offsets, holdout: report.holdout }, null, 2))
