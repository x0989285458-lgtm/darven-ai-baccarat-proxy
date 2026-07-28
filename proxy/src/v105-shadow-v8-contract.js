import {
  V105_SHADOW_VERSION as V6_VERSION,
  V105_SHADOW_TABLE_IDS,
  buildV105ShadowPrediction,
  buildV105ShadowSettlement,
} from './v105-shadow-contract.js'

export const V105_SHADOW_V8_VERSION = 'v105-shadow-v8-run-length-ask-road'
export const V105_SHADOW_V8_RELEASE = 'v105-shadow-v8-run-length-ask-road'
export const V105_SHADOW_V8_TABLE_IDS = V105_SHADOW_TABLE_IDS

const ROAD_SPECS = Object.freeze([
  { name: 'bigEye', current: 'bigEyeRaw', candidate: ['big_eye', 'bigEye'] },
  { name: 'smallRoad', current: 'smallRoadRaw', candidate: ['small', 'small_road', 'smallRoad'] },
  { name: 'cockroach', current: 'cockroachRaw', candidate: ['cockroach', 'cockroach_road'] },
])

export function decodeV105ShadowV8DerivedRoad(raw = '') {
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

export function analyzeV105ShadowV8RoadRhythm(sequence = []) {
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

export function analyzeV105ShadowV8AskRoad(table = {}, v6Direction = null, v6RoadPatternClear = false) {
  const roads = Object.fromEntries(ROAD_SPECS.map((spec) => [spec.name, analyzeRoad(table, spec)]))
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
    : v6RoadPatternClear
      ? consensusDirection === v6Direction ? 'confirmed' : 'conflict'
      : 'override_unclear_v6'
  const reason = !consensusDirection
    ? votes.eligible < 2 ? 'insufficient_valid_votes' : 'no_unique_two_of_three_support'
    : relationToV6 === 'confirmed' ? 'ask_road_confirms_clear_v6'
      : relationToV6 === 'conflict' ? 'clear_v6_retained_despite_ask_road_conflict'
        : 'ask_road_consensus_controls_unclear_v6'
  return deepFreeze({ roads, votes, consensusDirection, relationToV6, reason })
}

export function buildV105ShadowV8Prediction(table = {}, historyRows = [], issuanceContext = {}) {
  const v6History = (Array.isArray(historyRows) ? historyRows : [])
    .filter((row) => (row?.strategy_version ?? row?.strategyVersion) === V105_SHADOW_V8_VERSION)
    .map((row) => ({
      ...structuredClone(row),
      strategy_version: V6_VERSION,
      strategyVersion: V6_VERSION,
      prediction_payload: row?.prediction_payload ? {
        ...structuredClone(row.prediction_payload), strategyVersion: V6_VERSION, releaseCandidate: V6_VERSION,
      } : row?.prediction_payload,
    }))
  const v6 = buildV105ShadowPrediction(table, v6History, issuanceContext)
  const askRoadSignal = analyzeV105ShadowV8AskRoad(
    table,
    v6.roadPatternSignal?.direction ?? v6.predictedResult,
    v6.roadPatternSignal?.clear === true,
  )
  const askControls = v6.roadPatternSignal?.clear !== true && Boolean(askRoadSignal.consensusDirection)
  const predictedResult = askControls ? askRoadSignal.consensusDirection : v6.predictedResult
  const sameShoe = String(issuanceContext?.priorShoe ?? '') === String(table?.shoe ?? '')
  const sameSideStreak = predictedResult === issuanceContext?.priorDirection && sameShoe
    ? Math.max(0, Math.floor(Number(issuanceContext?.priorSameSideStreak) || 0)) + 1
    : 1
  const main = askControls ? {
    ...structuredClone(v6.heads.main),
    sourceVersion: 'v8-run-length-ask-road',
    predictedResult,
    roadPatternControlled: false,
    askRoadControlled: true,
  } : structuredClone(v6.heads.main)
  return deepFreeze({
    ...structuredClone(v6),
    strategyVersion: V105_SHADOW_V8_VERSION,
    releaseCandidate: V105_SHADOW_V8_RELEASE,
    predictedResult,
    sameSideStreak,
    heads: { ...structuredClone(v6.heads), main },
    askRoadSignal: structuredClone(askRoadSignal),
  })
}

export function buildV105ShadowV8Settlement(round = {}, issued = {}) {
  if (issued?.strategyVersion !== V105_SHADOW_V8_VERSION) {
    throw new Error('v105-shadow-v8-run-length-ask-road identity mismatch')
  }
  const settlement = buildV105ShadowSettlement(round, {
    ...structuredClone(issued), strategyVersion: V6_VERSION,
  })
  return { ...settlement, strategyVersion: V105_SHADOW_V8_VERSION }
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

function analyzeRoad(table, spec) {
  const sequence = decodeV105ShadowV8DerivedRoad(table?.[spec.current])
  const rhythm = analyzeV105ShadowV8RoadRhythm(sequence)
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
    if (Object.hasOwn(raw, key)) return decodeV105ShadowV8DerivedRoad(raw[key])
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

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}
