import {
  analyzeFiveRoadCycles,
  decodeBeadOutcomeSequence,
} from './v105-road-cycle.js'

export function analyzeV105ShadowV10UncommonRoadStructure(table = {}) {
  const fallbackFields = Array.isArray(table?.roadFallbackFields) ? table.roadFallbackFields : []
  if (table?.roadSource === 'real_round_fallback' || fallbackFields.includes('bigRoadRaw')) {
    return neutral('authoritative_big_road_required')
  }

  const roadValidation = analyzeFiveRoadCycles(table)
  if (roadValidation?.main?.source !== 'chronological_bead_reconstructed_big_road') {
    return neutral(roadValidation?.main?.invalidReason ?? 'authoritative_road_input_invalid')
  }

  const runs = buildRuns(decodeBeadOutcomeSequence(table?.beadPlateRaw))
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
    source: 'chronological_bead_reconstructed_big_road',
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

function buildRuns(outcomes) {
  return outcomes.reduce((runs, side) => {
    const previous = runs.at(-1)
    if (previous?.side === side) previous.length += 1
    else runs.push({ side, length: 1 })
    return runs
  }, [])
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
