import { canonicalProductionTableId, PRODUCTION_TABLE_IDS } from './table-policy.js'

export function createGapDetector() {
  function detect({ tables = [], cursors = new Map() } = {}) {
    const gaps = []
    for (const table of tables) {
      const tableId = canonicalProductionTableId(table?.tableId ?? table?.table_id)
      if (!PRODUCTION_TABLE_IDS.includes(tableId)) continue
      const cursor = readCursor(cursors, tableId)
      if (!cursor) continue
      const shoe = Number(table?.shoe)
      const round = Number(table?.round)
      if (!Number.isSafeInteger(shoe) || !Number.isSafeInteger(round) || round < 1) continue
      if (Number(cursor.shoe) === shoe) {
        const firstMissing = Number(cursor.round) + 1
        const lastCompleted = round - 1
        if (lastCompleted >= firstMissing) gaps.push({
          type: 'same_shoe', tableId, shoe,
          rounds: Array.from({ length: lastCompleted - firstMissing + 1 }, (_, index) => firstMissing + index),
        })
      } else {
        gaps.push({
          type: 'cross_shoe', tableId,
          from: { shoe: Number(cursor.shoe), round: Number(cursor.round) },
          to: { shoe, round },
        })
      }
    }
    return gaps
  }

  function liveAckAllowed(gaps = []) {
    return gaps.length === 0
  }

  return { detect, liveAckAllowed }
}

function readCursor(cursors, tableId) {
  if (cursors instanceof Map) return cursors.get(tableId) ?? null
  return cursors?.[tableId] ?? null
}
