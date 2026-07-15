import type { RealCardRound } from './liveClient'

export type RealCardRoadCell = {
  round: number
  outcome: 'banker' | 'player'
  point: number
  row: number
  column: number
  hasTie: boolean
}

export function buildRealCardBigRoad(rounds: RealCardRound[], completeThroughRound: number): RealCardRoadCell[] {
  const completeThrough = Math.max(0, Math.floor(Number(completeThroughRound) || 0))
  const byRound = new Map<number, RealCardRound>()
  for (const item of rounds) {
    if (!Number.isSafeInteger(item.round) || item.round < 1 || item.round > completeThrough) continue
    const existing = byRound.get(item.round)
    if (existing && JSON.stringify(existing) !== JSON.stringify(item)) return []
    byRound.set(item.round, item)
  }
  const prefix: RealCardRound[] = []
  for (let round = 1; round <= completeThrough; round += 1) {
    const item = byRound.get(round)
    if (!item) break
    prefix.push(item)
  }

  const cells: RealCardRoadCell[] = []
  const occupied = new Set<string>()
  let streakStartColumn = 0
  for (const item of prefix) {
    if (item.result === 'tie') {
      const last = cells.at(-1)
      if (last) last.hasTie = true
      continue
    }
    const outcome = item.result
    const point = outcome === 'banker' ? item.bankerPoint : item.playerPoint
    const previous = cells.at(-1)
    let row = 0
    let column = 0
    if (!previous) {
      streakStartColumn = 0
    } else if (previous.outcome === outcome) {
      const downwardKey = `${previous.column}:${previous.row + 1}`
      if (previous.row < 5 && !occupied.has(downwardKey)) {
        row = previous.row + 1
        column = previous.column
      } else {
        row = previous.row
        column = previous.column + 1
        while (occupied.has(`${column}:${row}`)) column += 1
      }
    } else {
      streakStartColumn += 1
      column = streakStartColumn
      while (occupied.has(`${column}:0`)) column += 1
      streakStartColumn = column
    }
    const cell = { round: item.round, outcome, point, row, column, hasTie: false }
    cells.push(cell)
    occupied.add(`${column}:${row}`)
  }
  return cells
}
