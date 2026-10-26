import { normalizeExactRealCardEvent } from '../../shared/real-card-validator.js'
import { canonicalProductionTableId, PRODUCTION_TABLE_IDS } from './table-policy.js'

// MT codes: first bead digit is a pair bitmask (player=1, banker=2),
// second digit is the outcome. Native big cells retain tie/point/pair/outcome.
// Never reconstruct historical points from beads. They must exist in big2.
export function projectMtFinalTrend(table, final) {
  const event = normalizeExactRealCardEvent(final)
  const trend = table?.trend
  const tableId = canonicalProductionTableId(table?.table_id ?? table?.tableId)
  if (!PRODUCTION_TABLE_IDS.includes(tableId) || tableId !== canonicalProductionTableId(final?.tableId)) return null
  if (!event || !trend || Number(table.shoe) !== Number(final.shoe)
    || Number(trend.current_shoe) !== Number(final.shoe)
    || !Number.isSafeInteger(final.round) || final.round < 1) return null
  const before = readBaseline(trend)
  if (!before || before.codes.length !== final.round - 1) return null
  const pair = Number(sameRank(event.rawResult[0], event.rawResult[2]))
    + 2 * Number(sameRank(event.rawResult[1], event.rawResult[3]))
  const winner = event.result === 'banker' ? '2' : event.result === 'player' ? '1' : '3'
  const code = `${pair}${winner}`
  const codes = [...before.codes, code]
  const records = recordsFromBeads(codes)
  const placed = layout(records, record => record.code[1])
  const oldPlaced = layout(before.records, record => record.code[1])
  const oldPoints = new Map([...oldPlaced].map(([key, record]) => [record.index, Number(before.big.get(key)[1])]))
  const point = winner === '2' ? event.bankerPoint : event.playerPoint
  const big = new Map()
  for (const [key, record] of placed) {
    const winningPoint = record.index === before.codes.length ? point : oldPoints.get(record.index)
    if (!Number.isInteger(winningPoint) || record.ties > 9) return null
    big.set(key, `${record.ties}${winningPoint}${record.code}`)
  }
  const sequence = records.map(record => Number(record.code[1]))
  const counts = countCodes(codes)
  const next = { ...structuredClone(trend),
    current_shoe: String(final.shoe), current_round: String(final.round + 1), total_round: String(final.round),
    total_round_banker: String(counts.banker), total_round_player: String(counts.player), total_round_tie: String(counts.tie),
    total_round_banker_pair: String(counts.bankerPair), total_round_player_pair: String(counts.playerPair),
    bead_plate2: encodeBeads(codes), big2: encodeGrid(big, 6),
    big_eye2: encodeGrid(derived(sequence, 1), 8), small2: encodeGrid(derived(sequence, 2), 8),
    cockroach2: encodeGrid(derived(sequence, 3), 8),
  }
  next.next_banker2 = ask(codes, records, big, '02')
  next.next_player2 = ask(codes, records, big, '01')
  return next
}

export function withMtTrendBundle(table) {
  const tableId = canonicalProductionTableId(table?.table_id ?? table?.tableId)
  const rawShoe = table?.trend?.current_shoe
  const shoe = /^\d+$/.test(String(rawShoe ?? '')) && Number.isSafeInteger(Number(rawShoe)) ? String(Number(rawShoe)) : null
  const bundle = { schemaVersion: 1, tableId, shoe, completedRound: null, status: 'pending', reason: 'missing-or-invalid-bundle' }
  const baseline = PRODUCTION_TABLE_IDS.includes(tableId) && shoe !== null ? readBaseline(table?.trend) : null
  if (baseline && validAsks(table.trend, baseline)) {
    bundle.completedRound = baseline.codes.length
    if (String(table.shoe) !== shoe) bundle.reason = 'shoe-mismatch'
    else if (!Number.isSafeInteger(table.round) || table.round !== bundle.completedRound) bundle.reason = 'coverage-mismatch'
    else { bundle.status = 'available'; bundle.reason = 'complete' }
  }
  return { ...table, trendBundle: bundle }
}

function validAsks(trend, baseline) {
  for (const [field, code] of [['next_banker2', '02'], ['next_player2', '01']]) {
    let value = trend[field]
    if (typeof value === 'string') {
      if (value.length > 65536) return false
      try { value = JSON.parse(value) } catch { return false }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const expected = ask(baseline.codes, baseline.records, baseline.big, code)
    if (value.bead_plate !== expected.bead_plate) return false
    for (const key of ['big', 'big_eye', 'small', 'cockroach']) {
      const actual = decodeGrid(value[key])
      if (!actual || !sameGrid(actual, decodeGrid(expected[key]))) return false
    }
  }
  return true
}

function readBaseline(trend) {
  if (typeof trend.bead_plate2 !== 'string' || typeof trend.big2 !== 'string') return null
  const columns = trend.bead_plate2 === '' ? [] : trend.bead_plate2.split('#')
  if (columns.some((column, i) => !/^(?:[0-3][1-3]){1,6}$/.test(column)
    || (i < columns.length - 1 && column.length !== 12))) return null
  const codes = columns.flatMap(column => column.match(/../g) ?? [])
  if (codes.length > 200 || Number(trend.total_round) !== codes.length) return null
  const counts = countCodes(codes)
  for (const [field, key] of [['banker','banker'],['player','player'],['tie','tie'],['banker_pair','bankerPair'],['player_pair','playerPair']]) {
    if (!/^\d+$/.test(String(trend[`total_round_${field}`])) || Number(trend[`total_round_${field}`]) !== counts[key]) return null
  }
  const big = decodeGrid(trend.big2)
  if (!big) return null
  const records = recordsFromBeads(codes)
  const positions = layout(records, record => record.code[1])
  if (big.size !== positions.size) return null
  for (const [key, record] of positions) {
    const cell = big.get(key)
    if (!/^\d{4}$/.test(cell ?? '') || cell.slice(2) !== record.code || Number(cell[0]) !== record.ties) return null
  }
  const sequence = records.map(record => Number(record.code[1]))
  for (const [offset, field] of [[1,'big_eye2'],[2,'small2'],[3,'cockroach2']]) {
    const actual = decodeGrid(trend[field])
    if (!actual || !sameGrid(actual, derived(sequence, offset))) return null
  }
  return { codes, records, big }
}

function sameRank(a, b) { return (a - 1) % 13 === (b - 1) % 13 }
function countCodes(codes) {
  const out = { banker: 0, player: 0, tie: 0, bankerPair: 0, playerPair: 0 }
  for (const code of codes) {
    out[code[1] === '2' ? 'banker' : code[1] === '1' ? 'player' : 'tie'] += 1
    out.playerPair += Number(Boolean(Number(code[0]) & 1))
    out.bankerPair += Number(Boolean(Number(code[0]) & 2))
  }
  return out
}
function recordsFromBeads(codes) {
  const records = []
  codes.forEach((code, index) => {
    if (code[1] !== '3') records.push({ code, index, ties: 0 })
    else if (records.length) {
      const last = records.at(-1)
      last.ties += 1
      last.code = `${Number(last.code[0]) | Number(code[0])}${last.code[1]}`
    }
  })
  return records
}
function layout(values, colorOf = value => String(value)) {
  const occupied = new Map()
  let previous = null, base = -1, column = -1, row = -1, tail = false
  for (const value of values) {
    const color = colorOf(value)
    if (color !== previous) {
      base += 1; column = base; row = 0; tail = false
      while (occupied.has(`${column}:${row}`)) column += 1
      base = column
    } else if (!tail && row < 5 && !occupied.has(`${column}:${row + 1}`)) row += 1
    else {
      tail = true; column += 1
      while (occupied.has(`${column}:${row}`)) column += 1
    }
    occupied.set(`${column}:${row}`, value); previous = color
  }
  return occupied
}
function derived(sequence, offset) {
  const lengths = [], colors = []
  let previous = null
  for (const outcome of sequence) {
    if (outcome !== previous) lengths.push(1)
    else lengths[lengths.length - 1] += 1
    const column = lengths.length - 1, row = lengths[column] - 1
    if (row === 0 && column >= offset + 1) colors.push(lengths[column - 1] === lengths[column - offset - 1] ? '2' : '1')
    else if (row > 0 && column >= offset) colors.push(lengths[column - offset] === row ? '1' : '2')
    previous = outcome
  }
  return layout(colors)
}
function decodeGrid(raw) {
  if (typeof raw !== 'string') return null
  const grid = new Map()
  raw.split('#').forEach((column, c) => column.split(',').forEach((cell, r) => { if (cell !== '') grid.set(`${c}:${r}`, cell) }))
  return grid
}
function sameGrid(a, b) { return a.size === b.size && [...a].every(([key, value]) => b.get(key) === value) }
function encodeGrid(grid, rows) {
  if (!grid.size) return ''
  const width = 1 + Math.max(...[...grid.keys()].map(key => Number(key.split(':')[0])))
  return Array.from({ length: width }, (_, column) => Array.from({ length: rows }, (_, row) => grid.get(`${column}:${row}`) ?? '').join(',')).join('#')
}
function encodeBeads(codes) {
  const columns = []
  for (let i = 0; i < codes.length; i += 6) columns.push(codes.slice(i, i + 6).join(''))
  return columns.join('#')
}
function ask(codes, records, actualBig, code) {
  const nextRecords = [...records, { code, index: codes.length, ties: 0 }]
  const oldPositions = layout(records, record => record.code[1])
  const cells = new Map([...oldPositions].map(([key, record]) => [record.index, actualBig.get(key)]))
  const nextBig = new Map([...layout(nextRecords, record => record.code[1])].map(([key, record]) => [key,
    record.index === codes.length ? `07${code}` : cells.get(record.index)]))
  const sequence = nextRecords.map(record => Number(record.code[1]))
  // MT asks explicitly use hypothetical seven-point, non-pair cells; these
  // values never enter the actual big2, Final or historical point map.
  return { bead_plate: encodeBeads([...codes, code]), big: encodeGrid(nextBig, 6),
    big_eye: encodeGrid(derived(sequence, 1), 8), small: encodeGrid(derived(sequence, 2), 8),
    cockroach: encodeGrid(derived(sequence, 3), 8) }
}
