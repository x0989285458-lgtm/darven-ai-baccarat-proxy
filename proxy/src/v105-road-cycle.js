const SIDE_LABEL = Object.freeze({ banker: '莊', player: '閒' })

export function decodeBeadOutcomeSequence(raw = '') {
  const text = String(raw ?? '')
  if (!text) return []
  const outcomes = []
  for (const column of text.split('#')) {
    if (!/^\d*$/.test(column) || column.length % 2 !== 0) return []
    for (let index = 0; index < column.length; index += 2) {
      const winnerCode = column[index + 1]
      if (!['1', '2', '3'].includes(winnerCode)) return []
      if (winnerCode === '1') outcomes.push('player')
      if (winnerCode === '2') outcomes.push('banker')
    }
  }
  return outcomes
}

export function decodeBigRoadOutcomeSequence(raw = '') {
  const text = String(raw ?? '')
  if (!text) return []
  const outcomes = []
  for (const column of text.split('#')) {
    for (const cell of column.split(',')) {
      const value = cell.trim()
      if (!value) continue
      if (value === 'B') outcomes.push('banker')
      else if (value === 'P') outcomes.push('player')
      else if (/^\d{2,4}$/.test(value) && value.endsWith('2')) outcomes.push('banker')
      else if (/^\d{2,4}$/.test(value) && value.endsWith('1')) outcomes.push('player')
      else return []
    }
  }
  return outcomes
}

export function decodeRoadColorSequence(raw = '') {
  const text = String(raw ?? '')
  if (!text) return []
  const values = []
  for (const column of text.split('#')) {
    for (const cell of column.split(',')) {
      const value = cell.trim()
      if (!value) continue
      if (value !== '1' && value !== '2') return []
      values.push(value)
    }
  }
  return values
}

export function detectRepeatedCycle(sequence = [], { minimumRepeats = 2, maximumWindow = 36 } = {}) {
  if (!Array.isArray(sequence)
    || !Number.isSafeInteger(minimumRepeats) || minimumRepeats < 2 || minimumRepeats > 10
    || !Number.isSafeInteger(maximumWindow) || maximumWindow < 4 || maximumWindow > 120) {
    return { detected: false }
  }
  const values = sequence.slice(-maximumWindow)
  const candidates = []
  for (let motifLength = 2; motifLength <= Math.floor(values.length / minimumRepeats); motifLength += 1) {
    const motif = values.slice(-motifLength)
    if (new Set(motif).size < 2) continue
    let repeats = 1
    for (let cursor = values.length - (motifLength * 2); cursor >= 0; cursor -= motifLength) {
      const block = values.slice(cursor, cursor + motifLength)
      if (block.length !== motifLength || block.some((value, index) => value !== motif[index])) break
      repeats += 1
    }
    if (repeats >= minimumRepeats) candidates.push({ motif, repeats, motifLength })
  }
  const winner = candidates.sort((left, right) => right.repeats - left.repeats || right.motifLength - left.motifLength)[0]
  if (!winner) return { detected: false }
  return {
    detected: true,
    motif: winner.motif,
    motifRunLengths: runLengths(winner.motif),
    repeats: winner.repeats,
    next: winner.motif[0],
  }
}

export function analyzeFiveRoadCycles(table = {}) {
  const renderedBigRoadOutcomes = decodeBigRoadOutcomeSequence(table.bigRoadRaw)
  const renderedBigRoadLayout = decodeBigRoadLayout(table.bigRoadRaw)
  const beadOutcomes = decodeBeadOutcomeSequence(table.beadPlateRaw)
  const reconstructedBigRoadLayout = reconstructBigRoadLayout(beadOutcomes)
  const bigRoadPresent = renderedBigRoadOutcomes.length > 0 && renderedBigRoadLayout !== null
  const beadPresent = beadOutcomes.length > 0
  const roadCountsAgree = bigRoadPresent && beadPresent && sameOutcomeCounts(renderedBigRoadOutcomes, beadOutcomes)
  const roadLayoutsAgree = roadCountsAgree && sameRoadLayout(renderedBigRoadLayout, reconstructedBigRoadLayout)
  const roadsAgree = roadCountsAgree && roadLayoutsAgree
  const mainCycle = roadsAgree ? detectRepeatedCycle(beadOutcomes) : { detected: false }
  const source = roadsAgree ? 'chronological_bead_reconstructed_big_road' : null
  const cycleStrengthEligible = isCycleStrengthEligible(mainCycle)
  const candidateDirection = cycleStrengthEligible ? mainCycle.next : null
  const auxiliary = {
    beadPlate: { cycle: detectRepeatedCycle(beadOutcomes), validationOnly: true, countedAsIndependentSupport: false },
    bigEye: analyzeAuxiliaryRoad(table.bigEyeRaw, table.nextBankerRaw?.big_eye, table.nextPlayerRaw?.big_eye, candidateDirection),
    smallRoad: analyzeAuxiliaryRoad(table.smallRoadRaw, table.nextBankerRaw?.small, table.nextPlayerRaw?.small, candidateDirection),
    cockroach: analyzeAuxiliaryRoad(table.cockroachRaw, table.nextBankerRaw?.cockroach, table.nextPlayerRaw?.cockroach, candidateDirection),
  }
  const independentAuxiliary = [auxiliary.bigEye, auxiliary.smallRoad, auxiliary.cockroach]
  const auxiliaryAgrees = independentAuxiliary.filter((item) => item.agreesWithMain).length
  const auxiliaryConflicts = independentAuxiliary.filter((item) => item.conflictsWithMain).length
  const priorityEligible = cycleStrengthEligible && auxiliaryAgrees >= 1 && auxiliaryConflicts === 0
  const mainDirection = priorityEligible ? mainCycle.next : null
  const main = mainCycle.detected ? {
    ...mainCycle,
    direction: mainCycle.next,
    source,
    cycleStrengthEligible,
    priorityEligible,
    auxiliaryAgrees,
    auxiliaryConflicts,
    reasonText: priorityEligible ? `大路週期${mainCycle.motifRunLengths.join('－')}連續${mainCycle.repeats}次，${auxiliaryAgrees}路輔助確認，下一位置支持${SIDE_LABEL[mainCycle.next]}` : null,
    invalidReason: !cycleStrengthEligible ? 'short_period_requires_three_repeats'
      : auxiliaryConflicts > 0 ? 'auxiliary_road_conflict'
        : 'auxiliary_confirmation_missing',
  } : {
    detected: false, direction: null, source, cycleStrengthEligible: false, priorityEligible: false,
    auxiliaryAgrees: 0, auxiliaryConflicts: 0, reasonText: null,
    invalidReason: !bigRoadPresent ? 'big_road_missing_or_invalid'
      : !beadPresent ? 'bead_plate_missing_or_invalid'
        : !roadCountsAgree ? 'big_road_bead_mismatch'
          : !roadLayoutsAgree ? 'big_road_bead_layout_mismatch'
            : 'no_complete_cycle',
  }
  const roadmapScore = mainDirection === 'banker'
    ? { banker: 0.55, player: 0.45 }
    : mainDirection === 'player'
      ? { banker: 0.45, player: 0.55 }
      : { banker: 0.5, player: 0.5 }

  return {
    main,
    roadmapScore,
    auxiliary,
  }
}

function isCycleStrengthEligible(cycle) {
  return cycle?.detected === true
    && Array.isArray(cycle.motif)
    && (cycle.motif.length >= 4 || cycle.repeats >= 3)
}

function analyzeAuxiliaryRoad(raw, bankerCandidateRaw, playerCandidateRaw, mainDirection) {
  const sequence = decodeRoadColorSequence(raw)
  const cycle = detectRepeatedCycle(sequence)
  const priorityEligible = isCycleStrengthEligible(cycle)
  const expectedColor = priorityEligible ? cycle.next : null
  const bankerNextColor = appendedColor(sequence, decodeRoadColorSequence(bankerCandidateRaw))
  const playerNextColor = appendedColor(sequence, decodeRoadColorSequence(playerCandidateRaw))
  const candidateDirection = expectedColor && bankerNextColor === expectedColor && playerNextColor !== expectedColor
    ? 'banker'
    : expectedColor && playerNextColor === expectedColor && bankerNextColor !== expectedColor
      ? 'player'
      : null
  return {
    cycle,
    priorityEligible,
    validationOnly: true,
    expectedColor,
    candidateDirection,
    agreesWithMain: Boolean(mainDirection && candidateDirection === mainDirection),
    conflictsWithMain: Boolean(mainDirection && candidateDirection && candidateDirection !== mainDirection),
  }
}

function decodeBigRoadLayout(raw) {
  const text = String(raw ?? '')
  if (!text) return null
  const layout = new Map()
  for (const [columnIndex, column] of text.split('#').entries()) {
    for (const [rowIndex, cell] of column.split(',').entries()) {
      const value = cell.trim()
      if (!value) continue
      const side = value === 'B' || (/^\d{2,4}$/.test(value) && value.endsWith('2'))
        ? 'banker'
        : value === 'P' || (/^\d{2,4}$/.test(value) && value.endsWith('1'))
          ? 'player'
          : null
      if (!side || rowIndex > 5) return null
      layout.set(`${columnIndex}:${rowIndex}`, side)
    }
  }
  return layout.size ? layout : null
}

function reconstructBigRoadLayout(outcomes) {
  const layout = new Map()
  let column = 0
  let row = 0
  let streakStartColumn = 0
  let previous = null
  for (const side of outcomes) {
    if (previous === null) {
      column = 0; row = 0; streakStartColumn = 0
    } else if (side === previous) {
      const below = `${column}:${row + 1}`
      if (row < 5 && !layout.has(below)) row += 1
      else {
        column += 1
        while (layout.has(`${column}:${row}`)) column += 1
      }
    } else {
      streakStartColumn += 1
      column = streakStartColumn
      row = 0
      while (layout.has(`${column}:${row}`)) column += 1
    }
    layout.set(`${column}:${row}`, side)
    previous = side
  }
  return layout
}

function sameRoadLayout(left, right) {
  if (!(left instanceof Map) || !(right instanceof Map) || left.size !== right.size) return false
  for (const [coordinate, side] of left) if (right.get(coordinate) !== side) return false
  return true
}

function sameOutcomeCounts(left, right) {
  const count = (values, side) => values.reduce((total, value) => total + (value === side ? 1 : 0), 0)
  return left.length === right.length
    && count(left, 'banker') === count(right, 'banker')
    && count(left, 'player') === count(right, 'player')
}

function appendedColor(current, candidate) {
  if (candidate.length <= current.length) return null
  if (current.some((value, index) => candidate[index] !== value)) return null
  return candidate[current.length] ?? null
}

function runLengths(sequence) {
  return sequence.reduce((lengths, value, index) => {
    if (index === 0 || value !== sequence[index - 1]) lengths.push(1)
    else lengths[lengths.length - 1] += 1
    return lengths
  }, [])
}
