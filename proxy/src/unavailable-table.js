// This is a narrow Worker wire contract, not a general malformed-screen escape.
// Ingress authentication/source fencing remains the caller's responsibility.
// Never infer missing from null identity or an old timestamp alone.
import { normalizeMtTable } from './normalize-table.js'
const rooms = Object.freeze({ BAV01: '48', BAV02: '49', BAV03: '50', BAV03A: '51', BAV05: '52', BAV06: '57' })
const epoch = '1970-01-01T00:00:00.000Z'
const emptyScreen = table => table.shoe == null && table.round == null && table.roundBasis == null
  && table.trend == null && table.lastRound == null && table.prediction == null && table.v102RankLedger == null
  && ['bigRoadRaw', 'beadPlateRaw', 'bigEyeRaw', 'smallRoadRaw', 'cockroachRaw'].every(k => table[k] == null || table[k] === '')
  && ['bankerCount', 'playerCount', 'tieCount', 'bankerPairCount', 'playerPairCount', 'totalPlayers'].every(k => table[k] == null || table[k] === 0)
  && ['nextBankerRaw', 'nextPlayerRaw', 'current_shoe', 'current_round', 'game_name'].every(k => table[k] == null)

export function isUnavailableTable(table) {
  const typed = table?.availability === 'catalog_missing' && table.catalogMissing === true
    || table?.availability === 'catalog_unavailable' && matchesStoredPlaceholder(table)
  return typed
    && Object.hasOwn(rooms, table.tableId) && String(table.roomId) === rooms[table.tableId]
    && table.tableType === 'BAC' && table.sourceUpdatedAt === epoch
    && table.shoe === null && table.round === null && emptyScreen(table)
}

export function assertUnavailableTable(table) {
  if ((table?.availability != null || table?.catalogMissing === true) && !isUnavailableTable(table)) {
    throw new Error('invalid typed unavailable table')
  }
  return table
}

export function normalizeUnavailableWire(table) {
  if (table?.availability != null && !['catalog_missing', 'catalog_unavailable'].includes(table.availability)) throw new Error('unknown unavailable table kind')
  if (table?.catalogMissing !== true && table?.availability == null) {
    const stored = normalizeStoredUnavailableTable(table)
    return isUnavailableTable(stored) ? stored : null
  }
  // Reparsed durable work must carry the complete normalized proof.
  if (table?.table_type == null) return assertUnavailableTable(table)
  const id = table.table_id
  const wireKeys = new Set(['table_id', 'tableId', 'room_id', 'hall', 'table_type',
    'catalogMissing', 'catalogScreenInvalid', 'sourceUpdatedAt', 'updated_at', 'shoe', 'round', 'availability'])
  if (!Object.hasOwn(rooms, id) || (table.tableId != null && table.tableId !== id)
    || (table.availability != null && table.availability !== 'catalog_missing')
    || String(table.room_id) !== rooms[id] || table.hall !== 3 || table.table_type !== 'BAC'
    || table.catalogMissing !== true || table.sourceUpdatedAt !== epoch || table.updated_at !== epoch
    || Object.keys(table).some(key => !wireKeys.has(key))
    || (table.catalogScreenInvalid != null && table.catalogScreenInvalid !== true)
    || !emptyScreen(table)) throw new Error('invalid missing Worker table placeholder')
  return { tableId: id, tableType: 'BAC', roomId: rooms[id], shoe: null, round: null,
    sourceUpdatedAt: epoch, catalogMissing: true, availability: 'catalog_missing' }
}

// Compatibility only for the exact pre-fix normalizeMtTable projection persisted
// by authenticated ingress. Its flags were lost. Do not call it "missing": an
// invalid-screen Worker tombstone used the same intentionally empty shape.
// Require EVERY empty field and canonical room/type/name, reject extra fields;
// null identity + epoch alone is insufficient. No screen identity is invented.
export function normalizeStoredUnavailableTable(table) {
  assertUnavailableTable(table)
  if (table?.availability != null || !matchesStoredPlaceholder(table)) return table
  return { ...table, availability: 'catalog_unavailable' }
}

function matchesStoredPlaceholder(table) {
  if (!Object.hasOwn(rooms, table?.tableId ?? '')) return false
  const expected = normalizeMtTable({ table_id: table.tableId, table_type: 'BAC',
    room_id: rooms[table.tableId], updated_at: epoch }, Object.keys(rooms).indexOf(table.tableId))
  return Object.entries(expected).every(([key, value]) => table[key] === value)
    && Object.keys(table).every(key => Object.hasOwn(expected, key) || key === 'buildVersion' || key === 'availability')
}
