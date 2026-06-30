import type { LiveTable } from '../lib/liveClient'

const beadSamples = [
  '020112020221#020201020201#010202030112#020102020121#030201020212#0102020102',
  '010202010121#020112020301#010202030201#020101020212#0102020102',
  '020202010202#010202020112#020102020302#020201010202#010102020201#030202010102#0202010202',
]

const bigSamples = [
  '0202,0202,0102,0202,#0101,0101,0101,#0202,0202,0202,0102,#0101,0101,#0202,0202,0102',
  '0101,0101,#0202,#0101,0101,0101,#0202,0202,#0101,0101',
  '0202,0202,0202,#0101,#0202,0202,0202,#0101,0101,#0202,0202,0202',
]

export const mockTables: LiveTable[] = Array.from({ length: 9 }, (_, index) => {
  const tableNo = index + 1
  const bankers = 14 + tableNo
  const players = 12 + (tableNo % 5)
  const ties = 2 + (tableNo % 4)
  return {
    id: `BAG${String(tableNo).padStart(2, '0')}`,
    name: `BAG${String(tableNo).padStart(2, '0')}`,
    table_type: tableNo % 2 === 0 ? 'BAS' : 'BAC',
    trend: {
      current_shoe: `S-240618-${String(tableNo).padStart(2, '0')}`,
      current_round: 30 + tableNo * 4,
      total_round_banker: bankers,
      total_round_player: players,
      total_round_tie: ties,
      total_round_banker_pair: 2 + (tableNo % 6),
      total_round_player_pair: 1 + (tableNo % 5),
      bead_plate2: beadSamples[index % beadSamples.length],
      big2: bigSamples[index % bigSamples.length],
    },
  }
})
