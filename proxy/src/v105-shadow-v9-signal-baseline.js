import {
  V104_ITERATION_SHADOW_VERSION,
  buildV104IterationShadowPrediction,
  buildV104IterationShadowSettlement,
} from './v104-iteration-shadow-contract.js'
import { decodeRoadColorSequence, detectRepeatedCycle } from './v105-road-cycle.js'

export const V105_SHADOW_V9_SIGNAL_TABLE_IDS = Object.freeze([
  'BAG01', 'BAG02', 'BAG03', 'BAG03A', 'BAG05',
  'BAG06', 'BAG07', 'BAG08', 'BAG09', 'BAG10',
])

const ROAD_SPECS = Object.freeze([
  { name: 'bigEye', current: 'bigEyeRaw', candidate: ['big_eye', 'bigEye'] },
  { name: 'smallRoad', current: 'smallRoadRaw', candidate: ['small', 'small_road', 'smallRoad'] },
  { name: 'cockroach', current: 'cockroachRaw', candidate: ['cockroach', 'cockroach_road'] },
])

function decodeDerivedRoad(raw = '') {
  const layout = decodeLayout(raw)
  if (!layout) return []
  const used = new Set()
  const sequence = []
  let previousRunColor = null
  for (let column = 0; column <= layout.maxColumn; column += 1) {
    const startKey = `${column}:0`
    const color = layout.cells.get(startKey)
    if (!color || used.has(startKey)) continue
    if (color === previousRunColor) return []
    let currentColumn = column
    let currentRow = 0
    while (true) {
      const key = `${currentColumn}:${currentRow}`
      if (layout.cells.get(key) !== color || used.has(key)) break
      used.add(key)
      sequence.push(color)
      const below = `${currentColumn}:${currentRow + 1}`
      const right = `${currentColumn + 1}:${currentRow}`
      if (currentRow < 5 && layout.cells.get(below) === color && !used.has(below)) currentRow += 1
      else if (currentRow === 5 && layout.cells.get(right) === color && !used.has(right)) currentColumn += 1
      else break
    }
    previousRunColor = color
  }
  return used.size === layout.cells.size ? sequence : []
}

function analyzeRunLengthRhythm(sequence = []) {
  const colors = normalizeSequence(sequence)
  const windows = {
    near6: colors.slice(-6),
    near12: colors.slice(-12),
    background24: colors.slice(-24),
  }
  const runs = buildRuns(colors)
  const near12Runs = buildRuns(windows.near12)
  const backgroundRuns = buildRuns(windows.background24)
  const current = runs.at(-1)
  const near12Current = near12Runs.at(-1)
  const previousSameColor = near12Runs.at(-3)
  const pattern = classifyPatterns(backgroundRuns)
  let expectedColor = null
  let reason = 'insufficient_rhythm_data'
  let currentPhase = 'insufficient_history'
  if (current?.length >= 5) {
    expectedColor = current.color
    reason = 'long_run_continuation'
    currentPhase = 'continuing_unbounded_dragon'
  } else if (current && near12Current?.color === current.color && previousSameColor?.color === current.color) {
    if (current.length < previousSameColor.length) {
      expectedColor = current.color
      reason = 'repeated_run_rhythm'
      currentPhase = 'filling_previous_same_color_length'
    } else if (current.length === previousSameColor.length) {
      expectedColor = opposite(current.color)
      reason = 'repeated_run_rhythm'
      currentPhase = 'completed_repeated_run'
    } else {
      reason = 'transition_ambiguous'
      currentPhase = 'just_changed_ambiguous'
    }
  } else if (current) {
    currentPhase = 'unconfirmed_short_phase'
  }
  return deepFreeze({
    sequence: colors,
    decodedRuns: runs,
    windows,
    pattern,
    currentPhase,
    expectedColor,
    reason,
  })
}

function analyzeRunLengthAskRoad(table = {}, roadPatternDirection = null, roadPatternClear = false) {
  const roads = Object.fromEntries(ROAD_SPECS.map((spec) => [spec.name, analyzeRunLengthRoad(table, spec)]))
  const directions = Object.values(roads).map((road) => road.vote).filter(Boolean)
  const votes = {
    banker: directions.filter((direction) => direction === 'banker').length,
    player: directions.filter((direction) => direction === 'player').length,
    eligible: directions.length,
  }
  const consensusDirection = votes.banker >= 2
    ? 'banker'
    : votes.player >= 2
      ? 'player'
      : null
  const relationToV6 = !consensusDirection
    ? 'fallback_v6'
    : roadPatternClear
      ? consensusDirection === roadPatternDirection ? 'confirmed' : 'conflict'
      : 'override_unclear_v6'
  const reason = !consensusDirection
    ? votes.eligible < 2 ? 'insufficient_valid_votes' : 'no_unique_two_of_three_support'
    : relationToV6 === 'confirmed' ? 'ask_road_confirms_clear_v6'
      : relationToV6 === 'conflict' ? 'clear_v6_retained_despite_ask_road_conflict'
        : 'ask_road_consensus_controls_unclear_v6'
  return deepFreeze({ roads, votes, consensusDirection, relationToV6, reason })
}

export function buildV105ShadowV9SignalBaseline(table = {}, historyRows = [], issuanceContext = {}) {
  const baseline = buildRoadPatternBaseline(table, historyRows, issuanceContext)
  const roadPatternDirection = baseline.roadPatternSignal?.direction ?? baseline.predictedResult
  const roadPatternClear = baseline.roadPatternSignal?.clear === true
  const roadCycleSignal = analyzeRoadCycleAskRoad(table, roadPatternDirection, roadPatternClear)
  const runLengthSignal = analyzeRunLengthAskRoad(table, roadPatternDirection, roadPatternClear)
  const roadCyclePrediction = resolveAskRoadPrediction({
    baseline,
    askRoadSignal: roadCycleSignal,
    table,
    issuanceContext,
    sourceVersion: 'v7-ask-road',
  })
  const runLengthPrediction = resolveAskRoadPrediction({
    baseline,
    askRoadSignal: runLengthSignal,
    table,
    issuanceContext,
    sourceVersion: 'v8-run-length-ask-road',
  })
  return deepFreeze({ roadCyclePrediction, runLengthPrediction })
}

export function buildV105ShadowV9BaselineSettlement(round = {}, issued = {}) {
  return buildV104IterationShadowSettlement(round, {
    ...structuredClone(issued),
    strategyVersion: V104_ITERATION_SHADOW_VERSION,
  })
}

function resolveAskRoadPrediction({ baseline, askRoadSignal, table, issuanceContext, sourceVersion }) {
  const askControls = baseline.roadPatternSignal?.clear !== true && Boolean(askRoadSignal.consensusDirection)
  const predictedResult = askControls ? askRoadSignal.consensusDirection : baseline.predictedResult
  const sameShoe = String(issuanceContext?.priorShoe ?? '') === String(table?.shoe ?? '')
  const sameSideStreak = predictedResult === issuanceContext?.priorDirection && sameShoe
    ? Math.max(0, Math.floor(Number(issuanceContext?.priorSameSideStreak) || 0)) + 1
    : 1
  const main = askControls ? {
    ...structuredClone(baseline.heads.main),
    sourceVersion,
    predictedResult,
    roadPatternControlled: false,
    askRoadControlled: true,
  } : structuredClone(baseline.heads.main)
  return deepFreeze({
    ...structuredClone(baseline),
    predictedResult,
    sameSideStreak,
    heads: { ...structuredClone(baseline.heads), main },
    askRoadSignal: structuredClone(askRoadSignal),
  })
}

function buildRoadPatternBaseline(table = {}, historyRows = [], issuanceContext = {}) {
  const targetTableId = String(table?.tableId ?? '')
  const stagedHistory = (Array.isArray(historyRows) ? historyRows : [])
    .filter((row) => (
      (row?.prediction_timing ?? row?.predictionTiming) === 'pre_result_context'
      && Boolean(row?.prediction_issued_at ?? row?.predictionIssuedAt)
      && (row?.settlement_final ?? row?.settlementFinal) === true
      && String(row?.table_id ?? row?.tableId ?? '') === targetTableId
    ))
    .sort((left, right) => predictionIssuedTime(left) - predictionIssuedTime(right))
    .slice(-60)
  const isolatedHistory = stagedHistory
    .sort((left, right) => historyTime(right) - historyTime(left))
    .slice(0, 60)
    .map((row) => ({
      ...structuredClone(row),
      strategy_version: V104_ITERATION_SHADOW_VERSION,
      strategyVersion: V104_ITERATION_SHADOW_VERSION,
    }))
  const baseline = buildV104IterationShadowPrediction(table, isolatedHistory, issuanceContext)
  const roadPattern = analyzeRoadPattern(table)
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
    strategyVersion: baseline.strategyVersion,
    releaseCandidate: baseline.releaseCandidate,
    formalStrategyVersion: 'v105',
    predictedResult: roadDirection ?? baseline.predictedResult,
    sameSideStreak,
    heads: { ...structuredClone(baseline.heads), main },
    roadPatternSignal: structuredClone(roadPattern.roadPatternSignal),
    decodedRecentRuns: structuredClone(roadPattern.decodedRecentRuns),
    roadPatternWindows: structuredClone(roadPattern.windows),
  })
}

function analyzeRoadPattern(table = {}) {
  const fallbackFields = Array.isArray(table?.roadFallbackFields) ? table.roadFallbackFields : []
  if (table?.roadSource === 'real_round_fallback' || fallbackFields.includes('bigRoadRaw')) {
    return emptyRoadPatternAnalysis('authoritative_big_road_required')
  }
  const outcomes = decodeBigRoad(table?.bigRoadRaw)
  if (outcomes.length === 0) return emptyRoadPatternAnalysis('big_road_missing_or_invalid')
  const decodedRecentRuns = buildSideRuns(outcomes.slice(-12))
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

function decodeBigRoad(raw = '') {
  const layout = decodeBigRoadLayout(raw)
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
      if (currentRow < 5 && layout.cells.get(below) === start && !used.has(below)) currentRow += 1
      else if (layout.cells.get(right) === start && !used.has(right)) currentColumn += 1
      else break
    }
    previousRunSide = start
  }
  return used.size === layout.cells.size ? outcomes : []
}

function decodeBigRoadLayout(raw) {
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
      const side = decodeBigRoadCell(value)
      if (!side) return null
      cells.set(`${columnIndex}:${rowIndex}`, side)
    }
  }
  return cells.size ? { cells, maxColumn: columns.length - 1 } : null
}

function decodeBigRoadCell(value) {
  if (value === 'B') return 'banker'
  if (value === 'P') return 'player'
  if (!/^\d{2,6}$/.test(value)) return null
  if (value.endsWith('2')) return 'banker'
  if (value.endsWith('1')) return 'player'
  return null
}

function buildSideRuns(outcomes) {
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

function analyzeRoadCycleAskRoad(table = {}, roadPatternDirection = null, roadPatternClear = false) {
  const roads = Object.fromEntries(ROAD_SPECS.map((spec) => [spec.name, analyzeRoadCycleCandidate(table, spec)]))
  const directions = Object.values(roads).map((road) => road.candidateDirection).filter(Boolean)
  const votes = {
    banker: directions.filter((direction) => direction === 'banker').length,
    player: directions.filter((direction) => direction === 'player').length,
    eligible: directions.length,
  }
  const consensusDirection = votes.banker >= 2 && votes.player === 0
    ? 'banker'
    : votes.player >= 2 && votes.banker === 0
      ? 'player'
      : null
  const relationToV6 = !consensusDirection
    ? 'fallback_v6'
    : roadPatternClear
      ? consensusDirection === roadPatternDirection ? 'confirmed' : 'conflict'
      : 'override_unclear_v6'
  const reason = !consensusDirection
    ? votes.eligible < 2 ? 'insufficient_valid_votes' : 'no_unique_two_of_three_support'
    : relationToV6 === 'confirmed' ? 'ask_road_confirms_clear_v6'
      : relationToV6 === 'conflict' ? 'clear_v6_retained_despite_ask_road_conflict'
        : 'ask_road_consensus_controls_unclear_v6'
  return deepFreeze({ roads, votes, consensusDirection, relationToV6, reason })
}

function analyzeRoadCycleCandidate(table, spec) {
  const currentSequence = decodeRoadColorSequence(table?.[spec.current])
  const cycle = detectRepeatedCycle(currentSequence)
  const rhythmEligible = cycle.detected === true
    && Array.isArray(cycle.motif)
    && (cycle.motif.length >= 4 || cycle.repeats >= 3)
  const expectedColor = rhythmEligible ? cycle.next : null
  const bankerCandidate = decodeRoadCycleCandidate(table?.nextBankerRaw, spec.candidate)
  const playerCandidate = decodeRoadCycleCandidate(table?.nextPlayerRaw, spec.candidate)
  const bankerNextColor = exactAppendedColor(currentSequence, bankerCandidate)
  const playerNextColor = exactAppendedColor(currentSequence, playerCandidate)
  let candidateDirection = null
  let reason = null
  if (!expectedColor) reason = 'insufficient_rhythm_data'
  else if (!bankerNextColor || !playerNextColor) reason = 'candidate_not_exact_append'
  else if (bankerNextColor === playerNextColor) reason = 'candidate_colors_same'
  else if (bankerNextColor === expectedColor) candidateDirection = 'banker'
  else if (playerNextColor === expectedColor) candidateDirection = 'player'
  else reason = 'expected_color_not_uniquely_supported'
  return {
    currentSequence: [...currentSequence],
    expectedColor,
    bankerNextColor,
    playerNextColor,
    candidateDirection,
    reason: candidateDirection ? 'unique_expected_color_match' : reason,
  }
}

function decodeRoadCycleCandidate(raw, keys) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  for (const key of keys) {
    if (Object.hasOwn(raw, key)) return decodeRoadColorSequence(raw[key])
  }
  return []
}

function decodeLayout(raw) {
  const text = String(raw ?? '')
  if (!text) return null
  const cells = new Map()
  const columns = text.split('#')
  for (const [columnIndex, column] of columns.entries()) {
    const values = column.split(',')
    if (values.length > 6) return null
    for (const [rowIndex, value] of values.entries()) {
      const color = value.trim()
      if (!color) continue
      if (color !== '1' && color !== '2') return null
      cells.set(`${columnIndex}:${rowIndex}`, color)
    }
  }
  return cells.size ? { cells, maxColumn: columns.length - 1 } : null
}

function normalizeSequence(sequence) {
  if (!Array.isArray(sequence) || sequence.some((color) => color !== '1' && color !== '2')) return []
  return [...sequence]
}

function buildRuns(sequence) {
  return sequence.reduce((runs, color) => {
    const previous = runs.at(-1)
    if (previous?.color === color) previous.length += 1
    else runs.push({ color, length: 1 })
    return runs
  }, [])
}

function analyzeRunLengthRoad(table, spec) {
  const sequence = decodeDerivedRoad(table?.[spec.current])
  const rhythm = analyzeRunLengthRhythm(sequence)
  const bankerCandidate = decodeCandidate(table?.nextBankerRaw, spec.candidate)
  const playerCandidate = decodeCandidate(table?.nextPlayerRaw, spec.candidate)
  const bankerNextColor = exactAppendedColor(sequence, bankerCandidate)
  const playerNextColor = exactAppendedColor(sequence, playerCandidate)
  let vote = null
  let reason = rhythm.reason
  if (!sequence.length) reason = 'current_road_missing_or_invalid'
  else if (!rhythm.expectedColor) reason = rhythm.reason
  else if (!bankerNextColor || !playerNextColor) reason = 'candidate_not_exact_append'
  else if (bankerNextColor === playerNextColor) reason = 'candidate_colors_same'
  else if (bankerNextColor === rhythm.expectedColor) vote = 'banker'
  else if (playerNextColor === rhythm.expectedColor) vote = 'player'
  else reason = 'expected_color_not_uniquely_supported'
  return {
    ...structuredClone(rhythm),
    bankerNextColor,
    playerNextColor,
    vote,
    reason: vote ? 'unique_expected_color_match' : reason,
  }
}

function decodeCandidate(raw, keys) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  for (const key of keys) {
    if (Object.hasOwn(raw, key)) return decodeDerivedRoad(raw[key])
  }
  return []
}

function exactAppendedColor(current, candidate) {
  if (candidate.length !== current.length + 1) return null
  if (current.some((color, index) => candidate[index] !== color)) return null
  return candidate.at(-1) ?? null
}

function classifyPatterns(runs) {
  const lengths = runs.map((run) => run.length)
  const recognized = []
  if (runs.length >= 4 && lengths.every((length) => length === 1)) recognized.push('single_jump')
  if (runs.length >= 4 && lengths.every((length) => length === 2)) recognized.push('double_jump')
  const current = runs.at(-1)
  if (current?.length >= 5) recognized.push(`${current.color === '1' ? 'red' : 'blue'}_long_dragon`)
  else if (current?.length >= 3) recognized.push(`${current.color === '1' ? 'red' : 'blue'}_short_dragon`)
  if (hasRepeatedPair(lengths, 1, 2)) recognized.push('one_room_one_living')
  if (hasRepeatedPair(lengths, 2, 3)) recognized.push('two_room_one_living')
  if (lengths.length >= 4 && lengths.at(-4) === lengths.at(-2) && lengths.at(-3) === lengths.at(-1)) recognized.push('repeated_run_lengths')
  if (lengths.length >= 4 && new Set(lengths.slice(-4)).size >= 3) recognized.push('continuous_turns')
  return { primary: recognized[0] ?? 'unclassified', recognized }
}

function hasRepeatedPair(lengths, first, second) {
  if (lengths.length < 4) return false
  const tail = lengths.slice(-4)
  return tail[0] === first && tail[1] === second && tail[2] === first && tail[3] === second
}

function opposite(color) {
  return color === '1' ? '2' : color === '2' ? '1' : null
}

function historyTime(row) {
  const parsed = Date.parse(row?.settled_at ?? row?.settledAt ?? row?.prediction_issued_at ?? row?.predictionIssuedAt ?? '')
  return Number.isFinite(parsed) ? parsed : 0
}

function predictionIssuedTime(row) {
  return Date.parse(row?.prediction_issued_at ?? row?.predictionIssuedAt ?? '') || 0
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}
