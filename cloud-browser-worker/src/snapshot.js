const BANKER_VALUES = new Set(['b', 'banker', 'bank', '庄', '莊', 'zhuang'])
const PLAYER_VALUES = new Set(['p', 'player', 'play', '闲', '閒', 'xian'])
const TIE_VALUES = new Set(['t', 'tie', 'draw', '和'])

export function normalizeWinner(value) {
  if (value == null) return null
  const raw = String(value).trim()
  const key = raw.toLowerCase()
  if (BANKER_VALUES.has(key) || BANKER_VALUES.has(raw)) return 'banker'
  if (PLAYER_VALUES.has(key) || PLAYER_VALUES.has(raw)) return 'player'
  if (TIE_VALUES.has(key) || TIE_VALUES.has(raw)) return 'tie'
  return null
}

export function normalizeTable(table = {}, index = 0) {
  const tableId = firstValue(table, ['tableId', 'table_id', 'tableID', 'id', 'code', 'gameTableId']) ?? String(index + 1)
  return {
    tableId: String(tableId),
    displayName: String(firstValue(table, ['displayName', 'name', 'table_name', 'tableName', 'title']) ?? `MT百家樂第${index + 1}桌`),
    tableType: String(firstValue(table, ['tableType', 'table_type', 'gameType']) ?? 'BAC'),
    shoe: toNullableNumber(firstValue(table, ['shoe', 'current_shoe', 'currentShoe', 'shoeNo', 'shoe_no', 'boot'])),
    round: toNullableNumber(firstValue(table, ['round', 'current_round', 'currentRound', 'roundNo', 'round_no', 'gameNo'])),
    bankerCount: toNumber(firstValue(table, ['bankerCount', 'total_round_banker', 'banker_count', 'bankerTotal']), 0),
    playerCount: toNumber(firstValue(table, ['playerCount', 'total_round_player', 'player_count', 'playerTotal']), 0),
    tieCount: toNumber(firstValue(table, ['tieCount', 'total_round_tie', 'tie_count', 'tieTotal']), 0),
    beadPlateRaw: String(firstValue(table, ['beadPlateRaw', 'bead_plate2', 'beadPlate', 'beadRoad', 'road']) ?? ''),
    bigRoadRaw: String(firstValue(table, ['bigRoadRaw', 'big2', 'bigRoad', 'bigRoadMap']) ?? ''),
  }
}

export function extractSnapshotFromPayloads(payloads = [], { sessionId = 'darven-cloud-browser', now = new Date().toISOString(), url = null } = {}) {
  const parsedPayloads = payloads.map(parseMaybeJson).filter((value) => value != null)
  const tableCandidates = []
  const roundCandidates = []
  for (const payload of parsedPayloads) collectCandidates(payload, { tableCandidates, roundCandidates })

  const tables = dedupeBy(
    tableCandidates.map((table, index) => normalizeTable(table, index)).filter((table) => table.tableId),
    (table) => table.tableId,
  )
  const rounds = dedupeRounds(
    roundCandidates
      .map((round) => normalizeRound(round))
      .filter((round) => round.tableId && round.round != null && round.winner),
  )

  return {
    connected: true,
    authenticated: tables.length > 0 || rounds.length > 0,
    sessionId,
    snapshotAt: now,
    tables,
    rounds,
    diagnostics: {
      sourceUrl: url ? redactUrlSecrets(url) : null,
      payloadCount: parsedPayloads.length,
      tableCount: tables.length,
      roundCount: rounds.length,
    },
  }
}

export function redactUrlSecrets(input = '') {
  return String(input)
    .replace(/([?&](?:token|secret|key|password|auth|authorization)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/(bearer\s+)[A-Za-z0-9._-]+/gi, '$1[redacted]')
}

function normalizeRound(payload = {}) {
  const round = payload.round && typeof payload.round === 'object' ? payload.round : payload
  const tableId = firstValue(round, ['tableId', 'table_id', 'tableID', 'id', 'gameTableId'])
  const winner = normalizeWinner(firstValue(round, ['winner', 'result', 'win', 'main_result', 'mainResult']))
  return {
    tableId: tableId == null ? null : String(tableId),
    shoe: toNullableNumber(firstValue(round, ['shoe', 'current_shoe', 'shoeNo', 'shoe_no'])),
    round: toNullableNumber(firstValue(round, ['round', 'round_no', 'roundNo', 'current_round', 'gameNo'])),
    winner,
    rawResult: payload,
  }
}

function collectCandidates(value, output, seen = new WeakSet()) {
  if (value == null) return
  if (typeof value !== 'object') return
  if (seen.has(value)) return
  seen.add(value)

  if (Array.isArray(value)) {
    if (value.some(isTableLike)) output.tableCandidates.push(...value.filter(isTableLike))
    for (const item of value) collectCandidates(item, output, seen)
    return
  }

  if (isTableLike(value)) output.tableCandidates.push(value)
  if (isRoundLike(value)) output.roundCandidates.push(value)

  for (const key of ['tables', 'tableList', 'rooms', 'games', 'list', 'data', 'result', 'payload', 'snapshot', 'round', 'roundResult']) {
    if (value[key] != null) collectCandidates(value[key], output, seen)
  }
}

function isTableLike(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const hasId = firstValue(value, ['tableId', 'table_id', 'tableID', 'id', 'code', 'gameTableId']) != null
  const hasBaccaratRoad = firstValue(value, ['beadPlateRaw', 'bead_plate2', 'bigRoadRaw', 'big2', 'bigRoad', 'road']) != null
  const hasRound = firstValue(value, ['round', 'current_round', 'currentRound', 'roundNo', 'round_no', 'gameNo']) != null
  const hasTableName = firstValue(value, ['displayName', 'name', 'table_name', 'tableName', 'title']) != null
  return hasId && (hasBaccaratRoad || hasRound || hasTableName)
}

function isRoundLike(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const round = value.round && typeof value.round === 'object' ? value.round : value
  return firstValue(round, ['tableId', 'table_id', 'tableID', 'id', 'gameTableId']) != null
    && firstValue(round, ['round', 'round_no', 'roundNo', 'current_round', 'gameNo']) != null
    && normalizeWinner(firstValue(round, ['winner', 'result', 'win', 'main_result', 'mainResult'])) != null
}

function parseMaybeJson(value) {
  if (value == null) return null
  if (typeof value !== 'string') return value
  const text = value.trim()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return { rawText: text }
  }
}

function firstValue(object, keys) {
  for (const key of keys) {
    if (object?.[key] !== undefined && object?.[key] !== null && object?.[key] !== '') return object[key]
  }
  return null
}

function toNullableNumber(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function toNumber(value, fallback) {
  const number = toNullableNumber(value)
  return number == null ? fallback : number
}

function dedupeBy(items, keyFn) {
  const map = new Map()
  for (const item of items) {
    const key = keyFn(item)
    if (!map.has(key)) map.set(key, item)
  }
  return [...map.values()]
}

function dedupeRounds(rounds) {
  return dedupeBy(rounds, (round) => `${round.tableId}:${round.shoe ?? ''}:${round.round}`)
}
