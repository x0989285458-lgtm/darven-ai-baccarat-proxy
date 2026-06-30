const BACCARAT_TYPES = new Set(['BAC', 'BAS'])

export function normalizeMtTables(rawTables = []) {
  return rawTables
    .filter((table) => BACCARAT_TYPES.has(String(table?.table_type ?? '').toUpperCase()))
    .map((table, index) => normalizeMtTable(table, index))
    .sort((a, b) => a.tableId.localeCompare(b.tableId, 'en', { numeric: true }))
}

export function normalizeMtTable(raw, index = 0) {
  const trend = raw?.trend ?? {}
  const tableId = String(raw?.table_id ?? raw?.id ?? `UNKNOWN_${index + 1}`)
  const tableName = raw?.table_name ?? raw?.name ?? `${index + 1}`
  return {
    tableId,
    displayName: `MT百家樂第${tableName}桌`,
    tableType: String(raw?.table_type ?? '').toUpperCase(),
    shoe: toNumberOrNull(trend.current_shoe),
    round: toNumberOrNull(trend.current_round),
    bankerCount: toNumberOrZero(trend.total_round_banker),
    playerCount: toNumberOrZero(trend.total_round_player),
    tieCount: toNumberOrZero(trend.total_round_tie),
    bankerPairCount: toNumberOrZero(trend.total_round_banker_pair),
    playerPairCount: toNumberOrZero(trend.total_round_player_pair),
    beadPlateRaw: String(trend.bead_plate2 ?? ''),
    bigRoadRaw: String(trend.big2 ?? ''),
    bigEyeRaw: String(trend.big_eye2 ?? ''),
    smallRoadRaw: String(trend.small2 ?? ''),
    cockroachRaw: String(trend.cockroach2 ?? ''),
    nextBankerRaw: trend.next_banker2 ?? null,
    nextPlayerRaw: trend.next_player2 ?? null,
    dealerName: raw?.dealer?.username ?? null,
    totalPlayers: toNumberOrZero(raw?.totalplayers),
    roomId: raw?.room_id ?? null,
    state: raw?.state ?? null,
    orderState: raw?.orderState ?? null,
    sourceUpdatedAt: raw?.updated_at ?? raw?.updatedAt ?? null,
  }
}

function toNumberOrZero(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function toNumberOrNull(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}
