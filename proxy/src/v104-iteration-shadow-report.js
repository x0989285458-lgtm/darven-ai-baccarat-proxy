import { SHADOW_HEAD_KEYS, SHADOW_HEAD_LABELS, V104_ITERATION_SHADOW_VERSION, frozenWeightKeys } from './v104-iteration-shadow-contract.js'

const CYCLE_SIZE = 1000
const ACTION_SEQUENCE_FIELDS = Object.freeze({
  main: 'main_action_sequence', tie: 'tie_action_sequence', superSix: 'super_six_action_sequence',
  bankerDragon: 'banker_dragon_action_sequence', playerDragon: 'player_dragon_action_sequence',
  bankerPair: 'banker_pair_action_sequence', playerPair: 'player_pair_action_sequence',
})

export function buildCycleReports(rows = []) {
  const settled = normalizeSettledRows(rows)
  if (settled.length && settled.every((row) => positiveInteger(row.settlement_sequence))) {
    const grouped = new Map()
    for (const row of settled) {
      const cycleNumber = Math.floor((Number(row.settlement_sequence) - 1) / CYCLE_SIZE) + 1
      if (!grouped.has(cycleNumber)) grouped.set(cycleNumber, [])
      grouped.get(cycleNumber).push(row)
    }
    return [...grouped.entries()]
      .filter(([, cycleRows]) => cycleRows.length === CYCLE_SIZE)
      .sort(([left], [right]) => left - right)
      .map(([cycleNumber, cycleRows]) => buildReport(cycleRows, cycleNumber))
  }
  const reports = []
  for (let offset = 0; offset + CYCLE_SIZE <= settled.length; offset += CYCLE_SIZE) {
    const cycleRows = settled.slice(offset, offset + CYCLE_SIZE)
    reports.push(buildReport(cycleRows, offset / CYCLE_SIZE + 1))
  }
  return reports
}

export function buildShadowProgress(rows = []) {
  const settled = normalizeSettledRows(rows)
  const total = settled.reduce((maximum, row) => Math.max(maximum, positiveInteger(row.settlement_sequence) ? Number(row.settlement_sequence) : 0), 0) || settled.length
  const latest = settled.at(-1)
  return {
    shadowVersion: V104_ITERATION_SHADOW_VERSION,
    settledRounds: total,
    completedCycles: Math.floor(total / CYCLE_SIZE),
    currentCycleProgress: total % CYCLE_SIZE,
    heads: SHADOW_HEAD_KEYS.map((key) => {
      const sequenceValue = Number(latest?.[ACTION_SEQUENCE_FIELDS[key]])
      const actions = Number.isSafeInteger(sequenceValue) && sequenceValue >= 0
        ? sequenceValue
        : settled.filter((row) => row.head_results?.[key]?.action === true).length
      return {
        key, label: SHADOW_HEAD_LABELS[key], actions,
        iterationProgress: actions % CYCLE_SIZE,
      }
    }),
  }
}

export function buildShadowAdminStatus(rows = []) {
  const settled = normalizeSettledRows(rows)
  const progress = buildShadowProgress(settled)
  const remainder = settled.length % CYCLE_SIZE
  const currentRows = settled.slice(-Math.max(1, remainder || Math.min(CYCLE_SIZE, settled.length)))
  const progressByHead = new Map(progress.heads.map((head) => [head.key, head.iterationProgress]))
  return {
    ok: true,
    enabled: true,
    shadowVersion: V104_ITERATION_SHADOW_VERSION,
    formalStrategyVersion: 'v104',
    settledRounds: settled.length,
    currentCycleProgress: progress.currentCycleProgress,
    heads: SHADOW_HEAD_KEYS.map((key) => ({
      ...aggregateHead(currentRows, key),
      iterationProgress: progressByHead.get(key) ?? 0,
    })),
    reports: buildCycleReports(settled).map(({ cycleNumber, settledRounds, startedAt, completedAt }) => ({ cycleNumber, settledRounds, startedAt, completedAt })),
    suggestions: buildWeightSuggestions(settled),
  }
}

export function buildWeightSuggestions(rows = []) {
  const settled = normalizeSettledRows(rows)
  const suggestions = []
  for (const headKey of SHADOW_HEAD_KEYS) {
    const actionRows = settled.filter((row) => row.head_results?.[headKey]?.action === true)
    const latestActionSequence = Number(settled.at(-1)?.[ACTION_SEQUENCE_FIELDS[headKey]])
    const totalActions = Number.isSafeInteger(latestActionSequence) && latestActionSequence >= 0 ? latestActionSequence : actionRows.length
    const completedActionCycle = Math.floor(totalActions / CYCLE_SIZE)
    if (completedActionCycle < 1 || actionRows.length < CYCLE_SIZE) continue
    const sequenceField = ACTION_SEQUENCE_FIELDS[headKey]
    const hasActionSequences = actionRows.some((row) => Number.isSafeInteger(Number(row?.[sequenceField])))
    const sampleRows = hasActionSequences
      ? actionRows.filter((row) => {
          const sequence = Number(row?.[sequenceField])
          return sequence > (completedActionCycle - 1) * CYCLE_SIZE && sequence <= completedActionCycle * CYCLE_SIZE
        })
      : actionRows.slice(-CYCLE_SIZE)
    if (sampleRows.length !== CYCLE_SIZE) continue
    const predictionHead = sampleRows.find((row) => row.prediction_payload?.heads?.[headKey])?.prediction_payload?.heads?.[headKey]
    if (!predictionHead) continue
    const keys = frozenWeightKeys[headKey]
    let currentWeights
    try {
      currentWeights = canonicalWeights(predictionHead.weights, keys)
    } catch {
      continue
    }
    const model = buildBrierModel(sampleRows, headKey, keys)
    if (!model.sampleCount) continue
    const baselineMetrics = evaluateBrierModel(model, currentWeights, keys)
    const candidate = exhaustiveFivePercentGrid(model, keys)
    const suggestedWeights = candidate.weights
    suggestions.push({
      id: `${V104_ITERATION_SHADOW_VERSION}:${headKey}:${completedActionCycle}`,
      shadowVersion: V104_ITERATION_SHADOW_VERSION,
      modelVersion: V104_ITERATION_SHADOW_VERSION,
      headKey, headLabel: SHADOW_HEAD_LABELS[headKey],
      sampleActions: CYCLE_SIZE,
      sampleStartAction: (completedActionCycle - 1) * CYCLE_SIZE + 1,
      sampleEndAction: completedActionCycle * CYCLE_SIZE,
      actionCycle: completedActionCycle,
      currentWeights,
      suggestedWeights,
      baselineMetrics,
      candidateMetrics: candidate.metrics,
      searchMethod: 'exhaustive_5_percent_grid',
      status: 'pending',
      adjustmentScope: 'existing_weight_ratios_only',
      autoApply: false,
    })
  }
  return suggestions
}

function buildReport(rows, cycleNumber) {
  const first = rows[0]
  const last = rows.at(-1)
  return {
    shadowVersion: V104_ITERATION_SHADOW_VERSION,
    formalStrategyVersion: 'v104',
    cycleNumber,
    settledRounds: rows.length,
    startedAt: first?.resolved_at ?? null,
    completedAt: last?.resolved_at ?? null,
    heads: SHADOW_HEAD_KEYS.map((key) => aggregateHead(rows, key)),
  }
}

function aggregateHead(rows, key) {
  const results = rows.map((row) => row.head_results?.[key]).filter(Boolean)
  const actions = results.filter((item) => item.action === true)
  const hits = actions.filter((item) => item.status === 'hit').length
  const misses = actions.filter((item) => item.status === 'miss').length
  const pushes = actions.filter((item) => item.status === 'push').length
  return {
    key, label: SHADOW_HEAD_LABELS[key],
    eligibleRounds: rows.length,
    actions: actions.length,
    actionRate: roundedRate(actions.length, rows.length),
    hits, misses, pushes,
    hitRate: hits + misses ? roundedRate(hits, hits + misses) : null,
    fixedNetUnits: roundUnits(actions.reduce((sum, item) => sum + finite(item.fixedNetUnits), 0)),
    weightedNetUnits: roundUnits(actions.reduce((sum, item) => sum + finite(item.weightedNetUnits), 0)),
    fixedStakeUnits: roundUnits(actions.reduce((sum, item) => sum + finite(item.fixedStakeUnits), 0)),
    weightedStakeUnits: roundUnits(actions.reduce((sum, item) => sum + finite(item.weightedStakeUnits), 0)),
    iterationProgress: actions.length,
  }
}

function normalizeSettledRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row?.settlement_final === true && row?.prediction_payload?.heads && row?.head_results)
    .sort((a, b) => {
      const leftSequence = Number(a?.settlement_sequence)
      const rightSequence = Number(b?.settlement_sequence)
      if (positiveInteger(leftSequence) && positiveInteger(rightSequence)) return leftSequence - rightSequence
      return rowTime(a) - rowTime(b) || String(a.prediction_id ?? '').localeCompare(String(b.prediction_id ?? ''))
    })
}

function buildBrierModel(rows, headKey, keys) {
  const size = keys.length
  const matrix = Array.from({ length: size }, () => Array(size).fill(0))
  const target = Array(size).fill(0)
  let constant = 0; let sampleCount = 0; let hits = 0; let misses = 0; let pushes = 0
  for (const row of rows) {
    const result = row.head_results?.[headKey]
    if (result?.status === 'push') { pushes += 1; continue }
    if (!['hit', 'miss'].includes(result?.status)) continue
    const values = keys.map((key) => Number(row.prediction_payload?.heads?.[headKey]?.featureValues?.[key]) / 100)
    if (values.some((value) => !Number.isFinite(value))) continue
    const outcome = result.status === 'hit' ? 1 : 0
    if (outcome) hits += 1
    else misses += 1
    sampleCount += 1
    constant += outcome * outcome
    for (let i = 0; i < size; i += 1) {
      target[i] += values[i] * outcome
      for (let j = 0; j < size; j += 1) matrix[i][j] += values[i] * values[j]
    }
  }
  return { matrix, target, constant, sampleCount, hits, misses, pushes }
}

function evaluateBrierModel(model, weights, keys) {
  const vector = keys.map((key) => finite(weights[key]))
  let error = model.constant
  for (let i = 0; i < vector.length; i += 1) {
    error -= 2 * vector[i] * model.target[i]
    for (let j = 0; j < vector.length; j += 1) error += vector[i] * vector[j] * model.matrix[i][j]
  }
  return {
    brierScore: Number((error / model.sampleCount).toFixed(12)),
    evaluatedActions: model.sampleCount,
    hits: model.hits,
    misses: model.misses,
    pushes: model.pushes,
  }
}

function exhaustiveFivePercentGrid(model, keys) {
  const slots = 20
  let bestWeights = null; let bestMetrics = null; let candidateCount = 0
  const allocation = Array(keys.length).fill(0)
  const minimumSlots = 1
  const visit = (index, remaining) => {
    if (index === keys.length - 1) {
      if (remaining < minimumSlots) return
      allocation[index] = remaining
      candidateCount += 1
      const weights = Object.fromEntries(keys.map((key, keyIndex) => [key, allocation[keyIndex] / slots]))
      const metrics = evaluateBrierModel(model, weights, keys)
      if (!bestMetrics || metrics.brierScore < bestMetrics.brierScore - 1e-12
          || (Math.abs(metrics.brierScore - bestMetrics.brierScore) <= 1e-12 && weightSignature(weights, keys) < weightSignature(bestWeights, keys))) {
        bestWeights = weights
        bestMetrics = metrics
      }
      return
    }
    const remainingKeys = keys.length - index - 1
    for (let value = minimumSlots; value <= remaining - remainingKeys * minimumSlots; value += 1) {
      allocation[index] = value
      visit(index + 1, remaining - value)
    }
  }
  visit(0, slots)
  return { weights: bestWeights, metrics: { ...bestMetrics, gridCandidates: candidateCount, gridStepPercent: 5 } }
}

function weightSignature(weights, keys) {
  return keys.map((key) => String(Math.round(finite(weights?.[key]) * 100)).padStart(3, '0')).join(':')
}

function canonicalWeights(source, keys) {
  const raw = Object.fromEntries(keys.map((key) => [key, Math.max(0, finite(source?.[key]))]))
  return normalizeWeights(raw, keys)
}

function normalizeWeights(source, keys) {
  const total = keys.reduce((sum, key) => sum + Math.max(0, finite(source?.[key])), 0)
  if (!(total > 0)) throw new Error('shadow suggestion weights have no positive total')
  const weights = Object.fromEntries(keys.map((key) => [key, Number((Math.max(0, finite(source[key])) / total).toFixed(12))]))
  const sum = Object.values(weights).reduce((acc, value) => acc + value, 0)
  weights[keys[0]] = Number((weights[keys[0]] + (1 - sum)).toFixed(12))
  return weights
}

function roundedRate(numerator, denominator) {
  return denominator ? Math.round(numerator / denominator * 1000) / 10 : null
}

function finite(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function roundUnits(value) {
  return Math.round(finite(value) * 10000) / 10000
}

function positiveInteger(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0
}

function rowTime(row) {
  return Date.parse(row?.resolved_at ?? '') || 0
}
