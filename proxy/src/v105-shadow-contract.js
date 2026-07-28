import {
  V104_ITERATION_SHADOW_VERSION,
  buildV104IterationShadowPrediction,
  buildV104IterationShadowSettlement,
} from './v104-iteration-shadow-contract.js'

export const V105_SHADOW_VERSION = 'v105-shadow-v6-road-pattern'
export const V105_SHADOW_RELEASE = 'v105-shadow-v6-road-pattern'
export const V105_SHADOW_TABLE_IDS = Object.freeze([
  'BAG01', 'BAG02', 'BAG03', 'BAG03A', 'BAG05',
  'BAG06', 'BAG07', 'BAG08', 'BAG09', 'BAG10',
])

export function decodeV105ShadowV6BigRoad(raw = '') {
  const layout = decodeV105ShadowV6BigRoadLayout(raw)
  if (!layout) return []
  const used = new Set()
  const outcomes = []
  let previousRunSide = null
  for (let column = 0; column <= layout.maxColumn; column += 1) {
    const start = layout.cells.get(`${column}:0`)
    if (!start || start === previousRunSide || used.has(`${column}:0`)) continue
    let currentColumn = column
    let currentRow = 0
    while (true) {
      const key = `${currentColumn}:${currentRow}`
      if (layout.cells.get(key) !== start || used.has(key)) break
      used.add(key)
      outcomes.push(start)
      const below = `${currentColumn}:${currentRow + 1}`
      const right = `${currentColumn + 1}:${currentRow}`
      if (currentRow < 5 && layout.cells.get(below) === start && !used.has(below)) {
        currentRow += 1
      } else if (layout.cells.get(right) === start && !used.has(right)) {
        currentColumn += 1
      } else {
        break
      }
    }
    previousRunSide = start
  }
  return used.size === layout.cells.size ? outcomes : []
}

export function analyzeV105ShadowV6RoadPattern(table = {}) {
  const fallbackFields = Array.isArray(table?.roadFallbackFields) ? table.roadFallbackFields : []
  if (table?.roadSource === 'real_round_fallback' || fallbackFields.includes('bigRoadRaw')) {
    return emptyRoadPatternAnalysis('authoritative_big_road_required')
  }
  const outcomes = decodeV105ShadowV6BigRoad(table?.bigRoadRaw)
  if (outcomes.length === 0) return emptyRoadPatternAnalysis('big_road_missing_or_invalid')
  const decodedRecentRuns = buildRoadRuns(outcomes.slice(-12))
  const roadPatternSignal = detectRepeatedRunLengthSignal(decodedRecentRuns)
  return {
    roadPatternSignal,
    decodedRecentRuns: decodedRecentRuns.map((run) => ({ ...run })),
    windows: {
      near6: outcomes.slice(-6),
      near12: outcomes.slice(-12),
      background24: outcomes.slice(-24),
    },
  }
}

function decodeV105ShadowV6BigRoadLayout(raw) {
  const text = String(raw ?? '')
  if (!text) return null
  const cells = new Map()
  const columns = text.split('#')
  for (const [columnIndex, column] of columns.entries()) {
    const values = column.split(',')
    if (values.length > 6) return null
    for (const [rowIndex, cell] of values.entries()) {
      const value = cell.trim()
      if (!value) continue
      const side = decodeV105ShadowV6BigRoadCell(value)
      if (!side) return null
      cells.set(`${columnIndex}:${rowIndex}`, side)
    }
  }
  return cells.size ? { cells, maxColumn: columns.length - 1 } : null
}

function decodeV105ShadowV6BigRoadCell(value) {
  if (value === 'B') return 'banker'
  if (value === 'P') return 'player'
  if (!/^\d{2,6}$/.test(value)) return null
  if (value.endsWith('2')) return 'banker'
  if (value.endsWith('1')) return 'player'
  return null
}

function buildRoadRuns(outcomes) {
  return outcomes.reduce((runs, side) => {
    const previous = runs.at(-1)
    if (previous?.side === side) previous.length += 1
    else runs.push({ side, length: 1 })
    return runs
  }, [])
}

function detectRepeatedRunLengthSignal(runs) {
  if (runs.length >= 3) {
    const current = runs.at(-1)
    const previous = runs.at(-2)
    const beforePrevious = runs.at(-3)
    if (previous.length === beforePrevious.length && current.length <= previous.length) {
      return repeatedRunLengthSignal({
        patternName: `equal_columns_${previous.length}`,
        motifRunLengths: [previous.length],
        current,
        targetLength: previous.length,
      })
    }
    if (current.length === beforePrevious.length && previous.length !== beforePrevious.length) {
      return repeatedRunLengthSignal({
        patternName: `alternating_columns_${beforePrevious.length}_${previous.length}`,
        motifRunLengths: [beforePrevious.length, previous.length],
        current,
        targetLength: beforePrevious.length,
      })
    }
  }
  return { clear: false, direction: null, patternName: null, motifRunLengths: [], reason: 'no_clear_repeated_run_length' }
}

function repeatedRunLengthSignal({ patternName, motifRunLengths, current, targetLength }) {
  const continueCurrent = current.length < targetLength
  return {
    clear: true,
    direction: continueCurrent ? current.side : oppositeSide(current.side),
    patternName,
    motifRunLengths: [...motifRunLengths],
    currentRunLength: current.length,
    targetRunLength: targetLength,
    phase: continueCurrent ? 'continue_current_column' : 'switch_to_next_column',
    reason: null,
  }
}

function oppositeSide(side) {
  return side === 'banker' ? 'player' : 'banker'
}

function emptyRoadPatternAnalysis(reason) {
  return {
    roadPatternSignal: { clear: false, direction: null, patternName: null, motifRunLengths: [], reason },
    decodedRecentRuns: [],
    windows: { near6: [], near12: [], background24: [] },
  }
}

export function buildV105ShadowPrediction(table = {}, historyRows = [], issuanceContext = {}) {
  const targetTableId = String(table?.tableId ?? '')
  const isolatedHistory = (Array.isArray(historyRows) ? historyRows : [])
    .filter((row) => {
      const strategyVersion = row?.strategy_version ?? row?.strategyVersion
      const timing = row?.prediction_timing ?? row?.predictionTiming
      const issuedAt = row?.prediction_issued_at ?? row?.predictionIssuedAt
      const settled = row?.settlement_final ?? row?.settlementFinal
      return strategyVersion === V105_SHADOW_VERSION
        && timing === 'pre_result_context'
        && Boolean(issuedAt)
        && settled === true
        && String(row?.table_id ?? row?.tableId ?? '') === targetTableId
    })
    .sort((left, right) => historyTime(right) - historyTime(left))
    .slice(0, 60)
    .map((row) => ({
      ...structuredClone(row),
      strategy_version: V104_ITERATION_SHADOW_VERSION,
      strategyVersion: V104_ITERATION_SHADOW_VERSION,
    }))
  const baseline = buildV104IterationShadowPrediction(table, isolatedHistory, issuanceContext)
  const roadPattern = analyzeV105ShadowV6RoadPattern(table)
  const roadDirection = roadPattern.roadPatternSignal.clear === true
    ? roadPattern.roadPatternSignal.direction
    : null
  const sameShoe = String(issuanceContext?.priorShoe ?? '') === String(table?.shoe ?? '')
  const sameSideStreak = roadDirection
    ? roadDirection === issuanceContext?.priorDirection && sameShoe
      ? Math.max(0, Math.floor(Number(issuanceContext?.priorSameSideStreak) || 0)) + 1
      : 1
    : baseline.sameSideStreak
  const main = roadDirection ? {
    ...structuredClone(baseline.heads.main),
    sourceVersion: 'v6-road-pattern',
    predictedResult: roadDirection,
    roadPatternControlled: true,
  } : baseline.heads.main
  return deepFreeze({
    ...baseline,
    strategyVersion: V105_SHADOW_VERSION,
    releaseCandidate: V105_SHADOW_RELEASE,
    formalStrategyVersion: 'v105',
    predictedResult: roadDirection ?? baseline.predictedResult,
    sameSideStreak,
    heads: { ...structuredClone(baseline.heads), main },
    roadPatternSignal: structuredClone(roadPattern.roadPatternSignal),
    decodedRecentRuns: structuredClone(roadPattern.decodedRecentRuns),
    roadPatternWindows: structuredClone(roadPattern.windows),
  })
}

function historyTime(row = {}) {
  const parsed = Date.parse(row?.settled_at ?? row?.settledAt ?? row?.prediction_issued_at ?? row?.predictionIssuedAt ?? '')
  return Number.isFinite(parsed) ? parsed : 0
}

export function buildV105ShadowSettlement(round = {}, issued = {}) {
  if (issued?.strategyVersion !== V105_SHADOW_VERSION) {
    throw new Error('v105-shadow-v6-road-pattern identity mismatch')
  }
  const baseline = buildV104IterationShadowSettlement(round, {
    ...structuredClone(issued),
    strategyVersion: V104_ITERATION_SHADOW_VERSION,
  })
  return { ...baseline, strategyVersion: V105_SHADOW_VERSION }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}
