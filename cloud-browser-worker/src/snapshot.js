const BANKER_VALUES = new Set(['2', 'b', 'banker', 'bank', '庄', '莊', 'zhuang'])
const PLAYER_VALUES = new Set(['1', 'p', 'player', 'play', '闲', '閒', 'xian'])
const TIE_VALUES = new Set(['3', 't', 'tie', 'draw', '和'])

export function normalizeWinner(value, rawResult = null) {
  if (value != null) {
    const raw = String(value).trim()
    const key = raw.toLowerCase()
    if (BANKER_VALUES.has(key) || BANKER_VALUES.has(raw)) return 'banker'
    if (PLAYER_VALUES.has(key) || PLAYER_VALUES.has(raw)) return 'player'
    if (TIE_VALUES.has(key) || TIE_VALUES.has(raw)) return 'tie'
  }
  if (Array.isArray(rawResult) && rawResult.length > 9) {
    const playerPoint = Number(rawResult[8])
    const bankerPoint = Number(rawResult[9])
    if (Number.isFinite(playerPoint) && Number.isFinite(bankerPoint)) {
      if (bankerPoint > playerPoint) return 'banker'
      if (playerPoint > bankerPoint) return 'player'
      return 'tie'
    }
  }
  return null
}

export function normalizeTable(table = {}, index = 0) {
  const trend = table?.trend && typeof table.trend === 'object' ? table.trend : {}
  const tableId = normalizeTableId(firstValue(table, ['tableId', 'table_id', 'tableID', 'id', 'code', 'gameTableId']) ?? String(index + 1))
  return {
    tableId,
    displayName: String(firstValue(table, ['displayName', 'name', 'table_name', 'tableName', 'title']) ?? `MT百家樂第${index + 1}桌`),
    tableType: String(firstValue(table, ['tableType', 'table_type', 'gameType']) ?? 'BAC'),
    shoe: toNullableNumber(firstValueIn([table, trend], ['shoe', 'current_shoe', 'currentShoe', 'shoeNo', 'shoe_no', 'boot'])),
    round: toNullableNumber(firstValueIn([table, trend], ['round', 'current_round', 'currentRound', 'roundNo', 'round_no', 'gameNo'])),
    bankerCount: toNumber(firstValueIn([table, trend], ['bankerCount', 'total_round_banker', 'banker_count', 'bankerTotal']), 0),
    playerCount: toNumber(firstValueIn([table, trend], ['playerCount', 'total_round_player', 'player_count', 'playerTotal']), 0),
    tieCount: toNumber(firstValueIn([table, trend], ['tieCount', 'total_round_tie', 'tie_count', 'tieTotal']), 0),
    bankerPairCount: toNumber(firstValueIn([table, trend], ['bankerPairCount', 'total_round_banker_pair', 'banker_pair_count', 'bankerPairTotal']), 0),
    playerPairCount: toNumber(firstValueIn([table, trend], ['playerPairCount', 'total_round_player_pair', 'player_pair_count', 'playerPairTotal']), 0),
    beadPlateRaw: String(firstValueIn([table, trend], ['beadPlateRaw', 'bead_plate2', 'beadPlate', 'beadRoad', 'road']) ?? ''),
    bigRoadRaw: String(firstValueIn([table, trend], ['bigRoadRaw', 'big2', 'bigRoad', 'bigRoadMap']) ?? ''),
    bigEyeRaw: String(firstValueIn([table, trend], ['bigEyeRaw', 'big_eye2', 'bigEye', 'bigEyeRoad']) ?? ''),
    smallRoadRaw: String(firstValueIn([table, trend], ['smallRoadRaw', 'small2', 'smallRoad']) ?? ''),
    cockroachRaw: String(firstValueIn([table, trend], ['cockroachRaw', 'cockroach2', 'cockroachRoad']) ?? ''),
    nextBankerRaw: firstValueIn([table, trend], ['nextBankerRaw', 'next_banker2', 'nextBanker']) ?? null,
    nextPlayerRaw: firstValueIn([table, trend], ['nextPlayerRaw', 'next_player2', 'nextPlayer']) ?? null,
    dealerName: firstValue(table?.dealer && typeof table.dealer === 'object' ? table.dealer : {}, ['username', 'name']) ?? firstValue(table, ['dealerName', 'dealer_name']) ?? null,
    totalPlayers: toNumber(firstValueIn([table, trend], ['totalPlayers', 'totalplayers', 'total_players']), 0),
    roomId: firstValueIn([table, trend], ['roomId', 'room_id']) ?? null,
    state: firstValueIn([table, trend], ['state']) ?? null,
    orderState: firstValueIn([table, trend], ['orderState', 'order_state']) ?? null,
    sourceUpdatedAt: firstValueIn([table, trend], ['sourceUpdatedAt', 'updated_at', 'updatedAt']) ?? null,
  }
}

export function extractSnapshotFromPayloads(payloads = [], { sessionId = 'darven-cloud-browser', now = new Date().toISOString(), url = null } = {}) {
  const parsedPayloads = payloads.map(parseMaybeJson).filter((value) => value != null)
  const tableCandidates = []
  const roundCandidates = []
  parsedPayloads.forEach((payload, sourceIndex) => collectCandidates(payload, { tableCandidates, roundCandidates }, new WeakSet(), sourceIndex))

  const tables = mergeTables(
    tableCandidates
      .map((table, index) => ({ ...normalizeTable(table, index), __sourceIndex: table.__sourceIndex ?? 0, __sourceKind: table.__sourceKind ?? null }))
      .filter((table) => isWantedBaccaratTable(table)),
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
  const round = extractRoundBody(payload)
  const rawResult = Array.isArray(round.result) ? round.result : Array.isArray(round.rawResult) ? round.rawResult : null
  const tableId = firstValue(round, ['tableId', 'table_id', 'tableID', 'id', 'gameTableId'])
  const winner = normalizeWinner(firstValue(round, ['winner', 'win', 'main_result', 'mainResult']) ?? (Array.isArray(round.result) ? null : round.result), rawResult)
  return {
    tableId: tableId == null ? null : String(tableId),
    shoe: toNullableNumber(firstValue(round, ['shoe', 'current_shoe', 'shoeNo', 'shoe_no'])),
    round: toNullableNumber(firstValue(round, ['round', 'round_no', 'roundNo', 'current_round', 'gameNo'])),
    winner,
    playerPoint: rawResult && rawResult.length > 8 ? toNullableNumber(rawResult[8]) : toNullableNumber(firstValue(round, ['playerPoint', 'player_point'])),
    bankerPoint: rawResult && rawResult.length > 9 ? toNullableNumber(rawResult[9]) : toNullableNumber(firstValue(round, ['bankerPoint', 'banker_point'])),
    rawResult: rawResult ?? payload,
    sourceAction: getActionName(payload.action) || payload.event || round.action || null,
  }
}

function extractRoundBody(value = {}) {
  const action = getActionName(value.action)
  if (value.round && typeof value.round === 'object') return value.round
  if (value.body && typeof value.body === 'object' && isMtRoundAction(action)) return value.body
  if (value.msg && typeof value.msg === 'object' && isMtRoundAction(action)) return value.msg
  if (value.data && typeof value.data === 'object' && isMtRoundAction(action)) return value.data
  return value
}

function getActionName(action = '') {
  return typeof action === 'object' && action !== null ? (action.name ?? action.path ?? '') : action
}

function isMtRoundAction(action = '') {
  return /(show_poker|summary|show_win|roundResult|round_result)/i.test(String(action ?? ''))
}

function collectCandidates(value, output, seen = new WeakSet(), sourceIndex = 0) {
  if (value == null) return
  if (typeof value === 'string') {
    const parsed = parseMaybeJson(value)
    if (parsed && typeof parsed === 'object' && !parsed.rawText) {
      collectCandidates(parsed, output, seen, sourceIndex)
    } else {
      output.tableCandidates.push(...parseBaccaratTablesFromText(value).map((table) => ({ ...table, __sourceIndex: sourceIndex, __sourceKind: 'text' })))
    }
    return
  }
  if (typeof value !== 'object') return
  if (seen.has(value)) return
  seen.add(value)

  for (const textKey of ['rawText', 'bodyProbe', 'body', 'text']) {
    if (typeof value[textKey] === 'string') {
      output.tableCandidates.push(...parseBaccaratTablesFromText(value[textKey]).map((table) => ({ ...table, __sourceIndex: sourceIndex, __sourceKind: textKey })))
    }
  }

  if (Array.isArray(value)) {
    if (value.some(isTableLike)) output.tableCandidates.push(...value.filter(isTableLike).map((table) => ({ ...table, __sourceIndex: sourceIndex })))
    for (const item of value) collectCandidates(item, output, seen, sourceIndex)
    return
  }

  if (isTableLike(value)) output.tableCandidates.push({ ...value, __sourceIndex: sourceIndex })
  if (isRoundLike(value)) output.roundCandidates.push(value)

  for (const key of ['tables', 'tableList', 'rooms', 'games', 'list', 'data', 'result', 'msg', 'body', 'payload', 'payloads', 'arr', 'snapshot', 'round', 'roundResult']) {
    if (value[key] != null) collectCandidates(value[key], output, seen, sourceIndex)
  }
}

function parseBaccaratTablesFromText(text = '') {
  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const tables = []
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] !== '百家樂') continue
    const tableName = lines[index + 1]
    const shoe = toNullableNumber(lines[index + 2])
    const roundLine = lines.slice(index + 2, index + 9).find((line) => /^局數\s*\d+/.test(line))
    const bankerLine = lines.slice(index + 2, index + 10).find((line) => /^莊\s*\d+/.test(line))
    const playerLine = lines.slice(index + 2, index + 10).find((line) => /^閒\s*\d+/.test(line))
    const tieLine = lines.slice(index + 2, index + 10).find((line) => /^和\s*\d+/.test(line))
    if (!tableName || !roundLine || !bankerLine || !playerLine || !tieLine) continue
    const normalized = String(tableName).padStart(2, '0')
    tables.push({
      table_id: `BAG${normalized}`,
      table_name: tableName,
      table_type: 'BAC',
      current_shoe: shoe,
      current_round: Number(roundLine.match(/\d+/)?.[0] ?? 0),
      total_round_banker: Number(bankerLine.match(/\d+/)?.[0] ?? 0),
      total_round_player: Number(playerLine.match(/\d+/)?.[0] ?? 0),
      total_round_tie: Number(tieLine.match(/\d+/)?.[0] ?? 0),
      bead_plate2: '',
      big2: '',
    })
  }
  return tables
}

function isTableLike(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const trend = value.trend && typeof value.trend === 'object' ? value.trend : {}
  const hasId = firstValue(value, ['tableId', 'table_id', 'tableID', 'id', 'code', 'gameTableId']) != null
  const tableType = String(firstValue(value, ['tableType', 'table_type', 'gameType']) ?? 'BAC').toUpperCase()
  const hasBaccaratRoad = firstValueIn([value, trend], ['beadPlateRaw', 'bead_plate2', 'bigRoadRaw', 'big2', 'bigRoad', 'road']) != null
  const hasRound = firstValueIn([value, trend], ['round', 'current_round', 'currentRound', 'roundNo', 'round_no', 'gameNo']) != null
  const hasTableName = firstValue(value, ['displayName', 'name', 'table_name', 'tableName', 'title']) != null
  return hasId && tableType.startsWith('BA') && (hasBaccaratRoad || hasRound || hasTableName)
}

function normalizeTableId(value) {
  const id = String(value ?? '').trim().toUpperCase()
  const match = id.match(/^BAG(\d{1,2})(A?)$/)
  if (!match) return id
  return `BAG${match[1].padStart(2, '0')}${match[2] ?? ''}`
}

function isWantedBaccaratTable(table) {
  return /^BAG(?:\d{2}|\d{1,2}A)$/.test(table.tableId)
    && String(table.tableType ?? '').toUpperCase().startsWith('BA')
}

function mergeTables(tables) {
  const map = new Map()
  for (const table of tables) {
    const current = map.get(table.tableId)
    if (!current || shouldReplaceTable(current, table)) {
      map.set(table.tableId, { ...current, ...table })
    }
  }
  return [...map.values()].map(stripInternalTableFields).sort((a, b) => tableSortKey(a.tableId) - tableSortKey(b.tableId))
}

function shouldReplaceTable(current, next) {
  const currentSource = Number(current.__sourceIndex ?? -1)
  const nextSource = Number(next.__sourceIndex ?? -1)
  const currentRound = Number(current.round ?? -1)
  const nextRound = Number(next.round ?? -1)
  const currentShoe = current.shoe == null ? null : String(current.shoe)
  const nextShoe = next.shoe == null ? null : String(next.shoe)

  // The live page body is collected at request time, after the retained JSON/WebSocket
  // payload buffer. If it shows a later shoe, prefer it even if older road payloads
  // contain longer bead/big-road strings.
  if (currentShoe && nextShoe && currentShoe !== nextShoe && nextSource > currentSource) return true

  // Within the same shoe, a higher round is always fresher than a richer old road.
  if ((!currentShoe || !nextShoe || currentShoe === nextShoe) && nextRound > currentRound) return true

  // If both describe the same current round, keep the richer road payload.
  if (nextRound === currentRound) return tableScore(next) >= tableScore(current)

  return false
}

function stripInternalTableFields(table) {
  const { __sourceIndex, __sourceKind, ...publicTable } = table
  return publicTable
}

function tableScore(table) {
  return (table.beadPlateRaw ? table.beadPlateRaw.length : 0)
    + (table.bigRoadRaw ? table.bigRoadRaw.length : 0)
    + (table.bigEyeRaw ? table.bigEyeRaw.length : 0)
    + (table.smallRoadRaw ? table.smallRoadRaw.length : 0)
    + (table.cockroachRaw ? table.cockroachRaw.length : 0)
    + (table.nextBankerRaw ? JSON.stringify(table.nextBankerRaw).length : 0)
    + (table.nextPlayerRaw ? JSON.stringify(table.nextPlayerRaw).length : 0)
    + (table.displayName && !/^MT百家樂第\d+桌$/.test(table.displayName) ? 10 : 0)
    + (table.round ?? 0) / 1000
}

function tableSortKey(tableId) {
  const match = String(tableId).match(/^BAG(\d+)(A)?$/)
  if (!match) return 9999
  return Number(match[1]) * 10 + (match[2] ? 1 : 0)
}

function isRoundLike(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const round = extractRoundBody(value)
  const rawResult = Array.isArray(round.result) || Array.isArray(round.rawResult)
  const rawResultValue = Array.isArray(round.result) ? round.result : Array.isArray(round.rawResult) ? round.rawResult : null
  const winnerValue = firstValue(round, ['winner', 'win', 'main_result', 'mainResult']) ?? (Array.isArray(round.result) ? null : round.result)
  return firstValue(round, ['tableId', 'table_id', 'tableID', 'id', 'gameTableId']) != null
    && firstValue(round, ['round', 'round_no', 'roundNo', 'current_round', 'gameNo']) != null
    && (normalizeWinner(winnerValue, rawResultValue) != null || (isMtRoundAction(getActionName(value.action)) && rawResult))
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

function firstValueIn(objects, keys) {
  for (const object of objects) {
    const value = firstValue(object, keys)
    if (value != null) return value
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
