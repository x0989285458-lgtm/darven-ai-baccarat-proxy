import { createShoeTracker } from './card-shoe.js'

export function createProxyState({ onRoundEvent } = {}) {
  const shoeTracker = createShoeTracker({ deckCount: 8 })
  const state = {
    status: {
      service: 'Draven MT資料代理伺服器',
      version: '042',
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
      const inferredEvents = Array.isArray(tables) ? inferRoundEventsFromSnapshots(previousTables, tables) : []
      state.tables = Array.isArray(tables) ? mergeExistingRoundData(tables, previousTables) : []
      state.status.tableCount = state.tables.length
      for (const item of inferredEvents) emitRoundEvent(item.round, item.predictionTable)
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
        playerPoint: event.playerPoint ?? null,
        bankerPoint: event.bankerPoint ?? null,
        winner: event.winner ?? null,
        rawResult: event.rawResult ?? null,
        sourceAction: event.sourceAction ?? null,
        receivedAt: now,
      }
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
        state.tables[index] = {
          ...state.tables[index],
          shoe: lastRound.shoe ?? state.tables[index].shoe,
          round: lastRound.round ?? state.tables[index].round,
          lastRound,
        }
      } else {
        state.tables.push({ tableId, displayName: `MT百家樂${tableId}`, tableType: 'BAC', shoe: lastRound.shoe, round: lastRound.round, lastRound })
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
      events.push({
        predictionTable: structuredCloneSafe(previous),
        round: {
          tableId: String(next.tableId),
          shoe: next.shoe ?? previous.shoe ?? null,
          round: startRound + index,
          winner,
          sideActualResults: {
            bankerPair: deltas.bankerPair > 0,
            playerPair: deltas.playerPair > 0,
            tie: winner === 'tie',
          },
          rawResult: { inferredFromTableDelta: true, inferredFromRoundDelta: winners.length > inferWinnersFromCountDeltas(deltas).length, previousCounts: compactCounts(previous), nextCounts: compactCounts(next) },
          sourceAction: 'table_snapshot_delta',
          receivedAt: new Date().toISOString(),
        },
      })
    })
  }
  return events
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
      shoe: existing.lastRound.shoe ?? table.shoe,
      round: existing.lastRound.round ?? table.round,
      lastRound: existing.lastRound,
    }
  })
}

function structuredCloneSafe(value) {
  return JSON.parse(JSON.stringify(value))
}
