import { createShoeTracker } from './card-shoe.js'
import { BUILD_VERSION } from './build-version.js'
import { isVerifiedFinalRoundAction } from '../../shared/real-card-validator.js'

const MAX_ROAD_HISTORY_ROUND = 100

export function createProxyState({ onRoundEvent, onTablesUpdated, inferSnapshotRounds = true } = {}) {
  const shoeTracker = createShoeTracker({ deckCount: 8 })
  const realRoundHistoryByTable = new Map()
  const state = {
    status: {
      service: 'Draven MT資料代理伺服器',
      version: BUILD_VERSION,
      connected: false,
      lastMessageAt: null,
      reconnectCount: 0,
      errorMessage: null,
      captureSource: 'offline',
      cloudReady: true,
    },
    tables: [],
  }

  function emitRoundEvent(round, table) {
    if (typeof onRoundEvent !== 'function') return
    try {
      void onRoundEvent(round, table)
    } catch (error) {
      state.status.persistenceError = redactSecrets(error?.message ?? String(error))
    }
  }

  return {
    setStatus(nextStatus = {}) {
      state.status = { ...state.status, ...nextStatus }
      if (nextStatus.connected === true) state.status.errorMessage = null
    },
    setTables(tables = []) {
      const previousTables = state.tables
      const inferredEvents = inferSnapshotRounds && Array.isArray(tables) ? inferRoundEventsFromSnapshots(previousTables, tables) : []
      const mergedTables = Array.isArray(tables) ? mergeExistingRoundData(tables, previousTables) : []
      pruneRealRoundHistory(realRoundHistoryByTable, mergedTables)
      state.tables = mergedTables.map((table) => applyRealRoundRoadFallback(table, getContiguousRealRoundHistory(realRoundHistoryByTable, table.tableId)))
      state.status.tableCount = state.tables.length
      for (const item of inferredEvents) emitRoundEvent(item.round, item.predictionTable)
      if (typeof onTablesUpdated === 'function') onTablesUpdated(structuredCloneSafe(state.tables))
    },
    upsertRoundEvent(event = {}) {
      const tableId = String(event.tableId ?? '')
      if (!tableId) return
      const now = new Date().toISOString()
      state.status.lastRoundAt = now
      state.status.lastMessageAt = now
      state.status.connected = true
      const index = state.tables.findIndex((table) => String(table.tableId) === tableId)
      const lastRound = {
        tableId,
        shoe: event.shoe ?? null,
        round: event.round ?? null,
        playerPoint: event.playerPoint ?? pointFromRawResult(event.rawResult, 8),
        bankerPoint: event.bankerPoint ?? pointFromRawResult(event.rawResult, 9),
        winner: event.winner ?? null,
        rawResult: event.rawResult ?? null,
        sourceAction: event.sourceAction ?? null,
        receivedAt: now,
      }
      const currentTable = index >= 0 ? state.tables[index] : null
      const matchesCurrentShoe = !currentTable?.shoe || !lastRound.shoe || String(currentTable.shoe) === String(lastRound.shoe)
      const realRoundHistory = matchesCurrentShoe
        ? recordExactRealRound(realRoundHistoryByTable, lastRound, currentTable?.shoe)
        : null
      const shoeState = shoeTracker.recordRound(lastRound)
      lastRound.cardShoe = {
        playerCards: shoeState.lastRound?.playerCards ?? null,
        bankerCards: shoeState.lastRound?.bankerCards ?? null,
        playerCardFaces: shoeState.lastRound?.playerCardFaces ?? null,
        bankerCardFaces: shoeState.lastRound?.bankerCardFaces ?? null,
        playerCardPoints: shoeState.lastRound?.playerCardPoints ?? null,
        bankerCardPoints: shoeState.lastRound?.bankerCardPoints ?? null,
        pointDiff: shoeState.lastRound?.pointDiff ?? null,
        remainingRankCounts: shoeState.remainingRankCounts,
        remainingPointCounts: shoeState.remainingPointCounts,
        cardsSeenTotal: shoeState.cardsSeenTotal,
        cardsRemainingTotal: shoeState.cardsRemainingTotal,
        shoeProgressRatio: shoeState.shoeProgressRatio,
      }
      if (index >= 0) {
        const currentRoundNo = Number(currentTable.round)
        const eventRoundNo = Number(lastRound.round)
        const advancesIdentity = matchesCurrentShoe && (!Number.isFinite(currentRoundNo) || !Number.isFinite(eventRoundNo) || eventRoundNo >= currentRoundNo)
        state.tables[index] = applyRealRoundRoadFallback({
          ...currentTable,
          shoe: advancesIdentity ? (lastRound.shoe ?? currentTable.shoe) : currentTable.shoe,
          round: advancesIdentity ? (lastRound.round ?? currentTable.round) : currentTable.round,
          lastRound: advancesIdentity || !currentTable.lastRound ? lastRound : currentTable.lastRound,
        }, realRoundHistory)
      } else {
        state.tables.push(applyRealRoundRoadFallback({ tableId, displayName: `MT百家樂${tableId}`, tableType: 'BAC', shoe: lastRound.shoe, round: lastRound.round, lastRound }, realRoundHistory))
      }
      state.status.tableCount = state.tables.length
      emitRoundEvent(lastRound, state.tables.find((item) => String(item.tableId) === tableId) ?? { tableId })
    },
    recordError(message) {
      state.status.connected = false
      state.status.errorMessage = redactSecrets(String(message ?? 'unknown error'))
    },
    snapshot() {
      return structuredCloneSafe(state)
    },
  }
}

function pruneRealRoundHistory(historyByTable, tables = []) {
  const activeShoes = new Map(tables.map((table) => [String(table.tableId ?? ''), String(table.shoe ?? '')]))
  for (const [tableId, history] of historyByTable) {
    const activeShoe = activeShoes.get(tableId)
    if (activeShoe == null || (activeShoe && activeShoe !== history.shoe)) historyByTable.delete(tableId)
  }
}

function recordExactRealRound(historyByTable, round = {}, authoritativeShoe = null) {
  if (!isExactRealRound(round)) return null
  const tableId = String(round.tableId ?? '')
  const shoe = String(round.shoe ?? '')
  const roundNo = Number(round.round)
  if (!tableId || !shoe || !Number.isInteger(roundNo) || roundNo < 1 || roundNo > MAX_ROAD_HISTORY_ROUND) return null
  if (authoritativeShoe != null && String(authoritativeShoe) !== shoe) return null
  let history = historyByTable.get(tableId)
  if (!history || history.shoe !== shoe) {
    history = { shoe, rounds: new Map() }
    historyByTable.set(tableId, history)
  }
  const winner = String(round.winner).toLowerCase()
  const existing = history.rounds.get(roundNo)
  if (existing && existing !== winner) history.conflicted = true
  else history.rounds.set(roundNo, winner)
  return getContiguousRealRoundHistory(historyByTable, tableId)
}

function getContiguousRealRoundHistory(historyByTable, tableId) {
  const history = historyByTable.get(String(tableId ?? ''))
  if (!history) return null
  if (history.conflicted) return { shoe: history.shoe, conflicted: true }
  const ordered = [...history.rounds.entries()].sort((a, b) => a[0] - b[0])
  if (!ordered.every(([number], index) => number === index + 1)) return null
  return { shoe: history.shoe, outcomes: ordered.map(([, winner]) => winner) }
}

function isExactRealRound(round = {}) {
  if (!isVerifiedFinalRoundAction(round.sourceAction)) return false
  if (!['banker', 'player', 'tie'].includes(String(round.winner).toLowerCase())) return false
  const result = round.rawResult
  if (!Array.isArray(result) || result.length !== 10 || result.some((value) => typeof value !== 'number' || !Number.isInteger(value))) return false
  if (!result.slice(0, 4).every((value) => value >= 1 && value <= 52)) return false
  if (!result.slice(4, 6).every((value) => value >= 0 && value <= 52)) return false
  if (!result.slice(6, 8).every((value) => value >= -1 && value <= 52)) return false
  return result.slice(8, 10).every((value) => value >= 0 && value <= 9)
}

function applyRealRoundRoadFallback(table = {}, history = null) {
  if (!history || String(table.shoe ?? '') !== history.shoe) return table
  if (history.conflicted) {
    const fallbackFields = new Set(Array.isArray(table.roadFallbackFields) ? table.roadFallbackFields : [])
    const next = { ...table }
    for (const field of fallbackFields) next[field] = ''
    delete next.roadSource
    delete next.roadFallbackFields
    return next
  }
  const currentRound = Number(table.round)
  if (!Number.isInteger(currentRound) || currentRound < 1 || history.outcomes.length !== currentRound) return table
  const fallbackFields = new Set(Array.isArray(table.roadFallbackFields) ? table.roadFallbackFields : [])
  const missingBeadPlate = !table.beadPlateRaw || fallbackFields.has('beadPlateRaw')
  const missingBigRoad = !table.bigRoadRaw || fallbackFields.has('bigRoadRaw')
  if (!missingBeadPlate && !missingBigRoad) return table
  const counts = history.outcomes.reduce((totals, outcome) => ({ ...totals, [outcome]: totals[outcome] + 1 }), { banker: 0, player: 0, tie: 0 })
  return {
    ...table,
    bankerCount: Number(table.bankerCount) > 0 ? table.bankerCount : counts.banker,
    playerCount: Number(table.playerCount) > 0 ? table.playerCount : counts.player,
    tieCount: Number(table.tieCount) > 0 ? table.tieCount : counts.tie,
    beadPlateRaw: missingBeadPlate ? history.outcomes.map(outcomeCode).join('') : table.beadPlateRaw,
    bigRoadRaw: missingBigRoad ? buildFallbackBigRoad(history.outcomes) : table.bigRoadRaw,
    roadSource: 'real_round_fallback',
    roadFallbackFields: [
      ...(missingBeadPlate ? ['beadPlateRaw'] : []),
      ...(missingBigRoad ? ['bigRoadRaw'] : []),
    ],
  }
}

function outcomeCode(outcome) {
  return outcome === 'player' ? '01' : outcome === 'banker' ? '02' : '03'
}

function buildFallbackBigRoad(outcomes = []) {
  const occupied = new Map()
  let previousOutcome = null
  let streakStartColumn = -1
  let column = -1
  let row = -1
  for (const outcome of outcomes) {
    if (outcome === 'tie') continue
    if (outcome !== previousOutcome) {
      streakStartColumn += 1
      column = streakStartColumn
      row = 0
      while (occupied.has(`${column}:0`)) column += 1
      streakStartColumn = column
    } else if (row < 5 && !occupied.has(`${column}:${row + 1}`)) {
      row += 1
    } else {
      column += 1
      while (occupied.has(`${column}:${row}`)) column += 1
    }
    occupied.set(`${column}:${row}`, outcomeCode(outcome))
    previousOutcome = outcome
  }
  if (occupied.size === 0) return ''
  const maxColumn = Math.max(...[...occupied.keys()].map((key) => Number(key.split(':')[0])))
  return Array.from({ length: maxColumn + 1 }, (_, currentColumn) => {
    const cells = Array.from({ length: 6 }, (_, currentRow) => occupied.get(`${currentColumn}:${currentRow}`) ?? '')
    while (cells.at(-1) === '') cells.pop()
    return cells.join(',')
  }).join('#')
}

function pointFromRawResult(rawResult, index) {
  if (!Array.isArray(rawResult)) return null
  const value = Number(rawResult[index])
  return Number.isFinite(value) ? value : null
}

export function redactSecrets(message) {
  return message
    .replace(/token=([^\s&]+)/gi, 'token=[redacted]')
    .replace(/secret=([^\s&]+)/gi, 'secret=[redacted]')
    .replace(/(sb_secret_[A-Za-z0-9._-]+)/g, '[redacted]')
}

function inferRoundEventsFromSnapshots(previousTables = [], nextTables = []) {
  const previousById = new Map(previousTables.map((table) => [String(table.tableId), table]))
  const events = []
  for (const next of nextTables) {
    const previous = previousById.get(String(next.tableId))
    if (!previous) continue
    const shoeChanged = previous.shoe != null && next.shoe != null && String(previous.shoe) !== String(next.shoe)
    if (shoeChanged) continue
    if (!hasReliableSnapshotCounts(previous)) continue
    const deltas = {
      banker: countDelta(previous.bankerCount, next.bankerCount),
      player: countDelta(previous.playerCount, next.playerCount),
      tie: countDelta(previous.tieCount, next.tieCount),
      bankerPair: countDelta(previous.bankerPairCount, next.bankerPairCount),
      playerPair: countDelta(previous.playerPairCount, next.playerPairCount),
    }
    const winners = inferWinnersFromCountDeltas(deltas)
    const roundDelta = countDelta(previous.round, next.round)
    if (winners.length === 0 && roundDelta > 0) winners.push(...inferWinnersFromRoadChange(previous, next, roundDelta))
    const currentRound = Number(next.round ?? previous.round ?? 0)
    const startRound = Math.max(1, currentRound - winners.length + 1)
    winners.forEach((winner, index) => {
      const inferredRoundNo = startRound + index
      const exactRound = findMatchingRoundData([next.lastRound, previous.lastRound], next, inferredRoundNo)
      events.push({
        predictionTable: structuredCloneSafe(previous),
        round: {
          tableId: String(next.tableId),
          shoe: next.shoe ?? previous.shoe ?? null,
          round: inferredRoundNo,
          winner: exactRound?.winner ?? winner,
          playerPoint: exactRound?.playerPoint ?? null,
          bankerPoint: exactRound?.bankerPoint ?? null,
          sideActualResults: {
            bankerPair: deltas.bankerPair > 0,
            playerPair: deltas.playerPair > 0,
            tie: winner === 'tie',
          },
          rawResult: exactRound?.rawResult ?? { inferredFromTableDelta: true, inferredFromRoundDelta: winners.length > inferWinnersFromCountDeltas(deltas).length, previousCounts: compactCounts(previous), nextCounts: compactCounts(next) },
          sourceAction: 'table_snapshot_delta',
          receivedAt: new Date().toISOString(),
        },
      })
    })
  }
  return events
}

function findMatchingRoundData(candidates = [], table = {}, roundNo = null) {
  return candidates.find((round) => {
    if (!round) return false
    if (roundNo != null && round.round != null && Number(round.round) !== Number(roundNo)) return false
    if (table.shoe != null && round.shoe != null && String(round.shoe) !== String(table.shoe)) return false
    return Array.isArray(round.rawResult) || round.playerPoint != null || round.bankerPoint != null
  }) ?? null
}

function hasReliableSnapshotCounts(table = {}) {
  const total = Number(table.bankerCount ?? 0) + Number(table.playerCount ?? 0) + Number(table.tieCount ?? 0)
  const hasRoad = Boolean(table.beadPlateRaw || table.bigRoadRaw)
  return Number.isFinite(total) && total > 0 && hasRoad
}

function countDelta(before, after) {
  const delta = Number(after ?? 0) - Number(before ?? 0)
  return Number.isFinite(delta) && delta > 0 ? Math.min(5, Math.floor(delta)) : 0
}

function inferWinnersFromCountDeltas(deltas = {}) {
  return [...Array(deltas.banker ?? 0).fill('banker'), ...Array(deltas.player ?? 0).fill('player'), ...Array(deltas.tie ?? 0).fill('tie')]
}

function inferWinnersFromRoadChange(previous = {}, next = {}, roundDelta = 1) {
  const nextOutcomes = parseBeadOutcomeCodes(next.beadPlateRaw)
  const previousOutcomes = parseBeadOutcomeCodes(previous.beadPlateRaw)
  const added = nextOutcomes.length > previousOutcomes.length ? nextOutcomes.slice(previousOutcomes.length) : nextOutcomes.slice(-roundDelta)
  return added.slice(-roundDelta)
}

function parseBeadOutcomeCodes(raw = '') {
  return String(raw).split('#').flatMap((column) => (column.match(/\d{2}/g) ?? []).map((code) => {
    if (code[1] === '1') return 'player'
    if (code[1] === '2') return 'banker'
    if (code[1] === '3') return 'tie'
    return null
  }).filter(Boolean))
}

function compactCounts(table = {}) {
  return {
    bankerCount: Number(table.bankerCount ?? 0),
    playerCount: Number(table.playerCount ?? 0),
    tieCount: Number(table.tieCount ?? 0),
    bankerPairCount: Number(table.bankerPairCount ?? 0),
    playerPairCount: Number(table.playerPairCount ?? 0),
    round: table.round ?? null,
  }
}

function mergeExistingRoundData(nextTables, currentTables) {
  const currentById = new Map(currentTables.map((table) => [String(table.tableId), table]))
  return nextTables.map((table) => {
    const existing = currentById.get(String(table.tableId))
    if (!existing?.lastRound) return table
    return {
      ...table,
      shoe: table.shoe ?? existing.lastRound.shoe ?? null,
      round: table.round ?? existing.lastRound.round ?? null,
      lastRound: existing.lastRound,
    }
  })
}

function structuredCloneSafe(value) {
  return JSON.parse(JSON.stringify(value))
}
