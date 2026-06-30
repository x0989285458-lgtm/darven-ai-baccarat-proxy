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

  return {
    setStatus(nextStatus = {}) {
      state.status = { ...state.status, ...nextStatus }
      if (nextStatus.connected === true) state.status.errorMessage = null
    },
    setTables(tables = []) {
      state.tables = Array.isArray(tables) ? mergeExistingRoundData(tables, state.tables) : []
      state.status.tableCount = state.tables.length
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
      if (typeof onRoundEvent === 'function') {
        try {
          const table = state.tables.find((item) => String(item.tableId) === tableId) ?? { tableId }
          void onRoundEvent(lastRound, table)
        } catch (error) {
          state.status.persistenceError = redactSecrets(error?.message ?? String(error))
        }
      }
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
