export const PRODUCTION_TABLE_IDS = Object.freeze([
  'BAG01', 'BAG02', 'BAG03', 'BAG03A', 'BAG05',
  'BAG06', 'BAG07', 'BAG08', 'BAG09', 'BAG10',
])

const productionTableOrder = new Map(PRODUCTION_TABLE_IDS.map((tableId, index) => [tableId, index]))

export function canonicalProductionTableId(value) {
  const id = String(value ?? '').trim().toUpperCase()
  const match = id.match(/^BAG(\d{1,2})(A?)$/)
  if (!match) return id
  return `BAG${match[1].padStart(2, '0')}${match[2]}`
}

export function isProductionTableId(value) {
  return productionTableOrder.has(canonicalProductionTableId(value))
}

export function sortProductionTables(tables = []) {
  return tables
    .filter((table) => isProductionTableId(table?.tableId ?? table?.table_id))
    .map((table) => ({ ...table, tableId: canonicalProductionTableId(table?.tableId ?? table?.table_id) }))
    .sort((left, right) => productionTableOrder.get(left.tableId) - productionTableOrder.get(right.tableId))
}

export function filterProductionRounds(rounds = []) {
  return rounds
    .filter((round) => isProductionTableId(round?.tableId ?? round?.table_id))
    .map((round) => ({ ...round, tableId: canonicalProductionTableId(round?.tableId ?? round?.table_id) }))
}

export function sanitizeProductionSnapshot(snapshot = {}) {
  return {
    ...snapshot,
    tables: sortProductionTables(Array.isArray(snapshot?.tables) ? snapshot.tables : []),
    rounds: filterProductionRounds(Array.isArray(snapshot?.rounds) ? snapshot.rounds : []),
  }
}
