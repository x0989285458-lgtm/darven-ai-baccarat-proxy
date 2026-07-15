import { describe, expect, it } from 'vitest'
import { buildMtBigRoad, buildRealCardBigRoad } from './realCardRoad'

describe('v098.19 authoritative MT big road', () => {
  it('decodes exact MT columns, winner points, and tie slashes without rebuilding layout', () => {
    expect(buildMtBigRoad('0901,1601#0822,0702')).toEqual([
      { code: '0901', outcome: 'player', point: 9, row: 0, column: 0, hasTie: false },
      { code: '1601', outcome: 'player', point: 6, row: 1, column: 0, hasTie: true },
      { code: '0822', outcome: 'banker', point: 8, row: 0, column: 1, hasTie: false },
      { code: '0702', outcome: 'banker', point: 7, row: 1, column: 1, hasTie: false },
    ])
  })

  it('fails closed for malformed or non-decisive MT cells', () => {
    expect(buildMtBigRoad('0901,bad,123#0703,12345')).toEqual([
      { code: '0901', outcome: 'player', point: 9, row: 0, column: 0, hasTie: false },
    ])
  })
})

describe('v098.18 real-card big road', () => {
  it('uses six-row layout, winner points, and one tie slash only after a prior decisive round', () => {
    const road = buildRealCardBigRoad([
      { round: 1, result: 'tie', bankerPoint: 6, playerPoint: 6 },
      { round: 2, result: 'tie', bankerPoint: 7, playerPoint: 7 },
      { round: 3, result: 'banker', bankerPoint: 6, playerPoint: 4 },
      { round: 4, result: 'tie', bankerPoint: 5, playerPoint: 5 },
      { round: 5, result: 'tie', bankerPoint: 4, playerPoint: 4 },
      { round: 6, result: 'banker', bankerPoint: 7, playerPoint: 2 },
      { round: 7, result: 'banker', bankerPoint: 8, playerPoint: 1 },
      { round: 8, result: 'banker', bankerPoint: 9, playerPoint: 0 },
      { round: 9, result: 'banker', bankerPoint: 5, playerPoint: 3 },
      { round: 10, result: 'banker', bankerPoint: 4, playerPoint: 2 },
      { round: 11, result: 'banker', bankerPoint: 3, playerPoint: 1 },
      { round: 12, result: 'player', bankerPoint: 1, playerPoint: 9 },
    ], 12)

    expect(road).toHaveLength(8)
    expect(road[0]).toMatchObject({ round: 3, outcome: 'banker', point: 6, row: 0, column: 0, hasTie: true })
    expect(road[1]).toMatchObject({ round: 6, outcome: 'banker', point: 7, row: 1, column: 0, hasTie: false })
    expect(road[6]).toMatchObject({ round: 11, outcome: 'banker', row: 5, column: 1 })
    expect(road[7]).toMatchObject({ round: 12, outcome: 'player', point: 9, row: 0, column: 1 })
    expect(road.some((cell) => cell.outcome === ('tie' as never))).toBe(false)
  })

  it('does not carry shoe-leading ties forward to the first decisive cell', () => {
    const road = buildRealCardBigRoad([
      { round: 1, result: 'tie', bankerPoint: 6, playerPoint: 6 },
      { round: 2, result: 'tie', bankerPoint: 5, playerPoint: 5 },
      { round: 3, result: 'banker', bankerPoint: 8, playerPoint: 4 },
    ], 3)

    expect(road).toEqual([{ round: 3, outcome: 'banker', point: 8, row: 0, column: 0, hasTie: false }])
  })

  it('stops at the first missing round and never aligns later points by guess', () => {
    const road = buildRealCardBigRoad([
      { round: 1, result: 'banker', bankerPoint: 8, playerPoint: 3 },
      { round: 3, result: 'player', bankerPoint: 2, playerPoint: 9 },
    ], 3)

    expect(road).toEqual([{ round: 1, outcome: 'banker', point: 8, row: 0, column: 0, hasTie: false }])
  })
})
