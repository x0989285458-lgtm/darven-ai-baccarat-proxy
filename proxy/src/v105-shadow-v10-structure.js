export function analyzeV105ShadowV10UncommonRoadStructure(table = {}) {
  const fallbackFields = Array.isArray(table?.roadFallbackFields) ? table.roadFallbackFields : []
  if (table?.roadSource === 'real_round_fallback' || fallbackFields.includes('bigRoadRaw')) {
    return neutral('authoritative_big_road_required')
  }

  const runs = decodeAuthoritativeBigRoadRuns(table?.bigRoadRaw)
  if (runs.length === 0) return neutral('big_road_missing_or_invalid')
  if (runs.length < 4) return neutral('insufficient_run_history', runs)

  const candidates = findMotifCandidates(runs.map((run) => run.length))
  const eligible = candidates.filter((candidate) => candidate.currentRunLength <= candidate.targetRunLength)
    .sort(compareCandidates)[0]
  if (eligible) return diagnosticFromCandidate(eligible, runs)

  const overrun = candidates.filter((candidate) => candidate.currentRunLength > candidate.targetRunLength)
    .sort(compareCandidates)[0]
  if (overrun) return neutral('current_run_exceeds_motif_target', runs, overrun)
  return neutral('no_complete_repeated_motif', runs)
}

function findMotifCandidates(lengths) {
  const candidates = []
  const runCount = lengths.length
  for (let motifLength = 2; motifLength <= Math.floor(runCount / 2); motifLength += 1) {
    const suffixMotif = lengths.slice(-motifLength)
    if (isUncommonMotif(suffixMotif)) {
      let repeats = 1
      for (let cursor = runCount - (motifLength * 2); cursor >= 0; cursor -= motifLength) {
        if (!sameValues(lengths.slice(cursor, cursor + motifLength), suffixMotif)) break
        repeats += 1
      }
      if (repeats >= 2) {
        candidates.push(candidate({
          motif: suffixMotif,
          motifLength,
          phaseIndex: motifLength - 1,
          completedRepeats: repeats,
          currentRunLength: suffixMotif.at(-1),
        }))
      }
    }

    for (let prefixLength = 1; prefixLength <= motifLength; prefixLength += 1) {
      const evidenceLength = (motifLength * 2) + prefixLength
      if (evidenceLength > runCount) continue
      const evidence = lengths.slice(-evidenceLength)
      const motif = evidence.slice(0, motifLength)
      if (!isUncommonMotif(motif)
        || !sameValues(evidence.slice(motifLength, motifLength * 2), motif)) continue
      const prefix = evidence.slice(motifLength * 2)
      if (!sameValues(prefix.slice(0, -1), motif.slice(0, prefixLength - 1))) continue
      candidates.push(candidate({
        motif,
        motifLength,
        phaseIndex: prefixLength - 1,
        completedRepeats: 2 + (prefixLength === motifLength && prefix.at(-1) === motif.at(-1) ? 1 : 0),
        currentRunLength: prefix.at(-1),
      }))
    }
  }
  return candidates
}

function candidate({ motif, motifLength, phaseIndex, completedRepeats, currentRunLength }) {
  return {
    motifRunLengths: [...motif],
    motifLength,
    phaseIndex,
    repeats: completedRepeats,
    currentRunLength,
    targetRunLength: motif[phaseIndex],
  }
}

function diagnosticFromCandidate(candidateValue, runs) {
  const current = runs.at(-1)
  const continuing = candidateValue.currentRunLength < candidateValue.targetRunLength
  return deepFreeze({
    eligible: true,
    direction: continuing ? current.side : opposite(current.side),
    reason: continuing ? 'current_run_below_motif_target' : 'completed_repeated_motif',
    source: 'authoritative_big_road_only',
    motifRunLengths: [...candidateValue.motifRunLengths],
    repeats: candidateValue.repeats,
    phaseIndex: candidateValue.phaseIndex,
    currentPhase: continuing ? 'continuing_current_run' : 'target_reached_switch',
    currentSide: current.side,
    currentRunLength: candidateValue.currentRunLength,
    targetRunLength: candidateValue.targetRunLength,
    decodedRuns: runs.map((run) => ({ ...run })),
  })
}

function neutral(reason, runs = [], candidateValue = null) {
  const current = runs.at(-1)
  return deepFreeze({
    eligible: false,
    direction: null,
    reason,
    source: null,
    motifRunLengths: candidateValue ? [...candidateValue.motifRunLengths] : [],
    repeats: candidateValue?.repeats ?? 0,
    phaseIndex: candidateValue?.phaseIndex ?? null,
    currentPhase: reason === 'current_run_exceeds_motif_target' ? 'overrun_ineligible' : 'ineligible',
    currentSide: current?.side ?? null,
    currentRunLength: current?.length ?? null,
    targetRunLength: candidateValue?.targetRunLength ?? null,
    decodedRuns: runs.map((run) => ({ ...run })),
  })
}

function decodeAuthoritativeBigRoadRuns(raw = '') {
  const layout = decodeBigRoadLayout(raw)
  if (!layout) return []
  const used = new Set()
  const runs = []
  let previousSide = null
  for (let column = 0; column <= layout.maxColumn; column += 1) {
    const startKey = `${column}:0`
    const side = layout.cells.get(startKey)
    if (!side || used.has(startKey)) continue
    if (side === previousSide) return []
    let currentColumn = column
    let currentRow = 0
    let length = 0
    while (true) {
      const key = `${currentColumn}:${currentRow}`
      if (layout.cells.get(key) !== side || used.has(key)) break
      used.add(key)
      length += 1
      const below = `${currentColumn}:${currentRow + 1}`
      const right = `${currentColumn + 1}:${currentRow}`
      if (currentRow < 5 && layout.cells.get(below) === side && !used.has(below)) currentRow += 1
      else if (layout.cells.get(right) === side && !used.has(right)) currentColumn += 1
      else break
    }
    runs.push({ side, length })
    previousSide = side
  }
  return used.size === layout.cells.size ? runs : []
}

function decodeBigRoadLayout(raw = '') {
  const text = String(raw ?? '')
  if (!text) return null
  const cells = new Map()
  const columns = text.split('#')
  for (const [columnIndex, column] of columns.entries()) {
    const values = column.split(',')
    if (values.length > 6 || values.every((cell) => !cell.trim())) return null
    for (const [rowIndex, cell] of values.entries()) {
      const value = cell.trim()
      if (!value) continue
      const side = value === 'B' || (/^\d{2,6}$/.test(value) && value.endsWith('2'))
        ? 'banker'
        : value === 'P' || (/^\d{2,6}$/.test(value) && value.endsWith('1'))
          ? 'player'
          : null
      if (!side) return null
      cells.set(`${columnIndex}:${rowIndex}`, side)
    }
  }
  return cells.size ? { cells, maxColumn: columns.length - 1 } : null
}

function isUncommonMotif(motif) {
  return motif.length >= 2
    && motif.every((length) => Number.isSafeInteger(length) && length > 0)
    && new Set(motif).size >= 2
}

function sameValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function compareCandidates(left, right) {
  return right.repeats - left.repeats
    || right.motifLength - left.motifLength
    || right.phaseIndex - left.phaseIndex
}

function opposite(side) {
  return side === 'banker' ? 'player' : side === 'player' ? 'banker' : null
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}
