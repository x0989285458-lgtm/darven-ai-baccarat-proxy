import { isExactTenRawResult, normalizeExactRealCardEvent } from '../../shared/real-card-validator.js'
import { canonicalProductionTableId, PRODUCTION_TABLE_IDS } from './table-policy.js'

const DEFAULT_GAME_URL = 'wss://a1.ofalive99.net/game/ws'
const DEFAULT_CHAT_URL = 'wss://a2.ofalive99.net/chat/ws'
const MT_BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/149 Safari/537.36'

export function createMtApiClient({
  sourceOwner,
  sessionManager,
  createSocket,
  onFinal = async () => {},
  onTables = async () => {},
  onError = () => {},
  gameUrl = DEFAULT_GAME_URL,
  chatUrl = DEFAULT_CHAT_URL,
  reconnectDelayMs = 3_000,
  reconnectMaxDelayMs = 30_000,
  connectTimeoutMs = 15_000,
  authenticateTimeoutMs = connectTimeoutMs,
  tablesRefreshTimeoutMs = 10_000,
  heartbeatMs = 5_000,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  now = Date.now,
} = {}) {
  if (!sourceOwner || !sessionManager || typeof createSocket !== 'function') throw new Error('mt_api_dependencies_required')
  let generation = 0
  let lifecycleEpoch = 0
  let sockets = null
  let stopped = true
  let reconnectTimer = null
  let heartbeatTimer = null
  let eventSequence = 0
  let reconnecting = false
  let refreshPromise = null
  let refreshCycle = null
  let latestTables = null
  const latestFinalScreenByTable = new Map()
  const resolvedTablesRefreshTimeoutMs = Math.max(1_000, Number(tablesRefreshTimeoutMs) || 10_000)

  async function start() {
    stopped = false
    lifecycleEpoch += 1
    await connectGeneration(lifecycleEpoch)
  }

  async function connectGeneration(expectedLifecycleEpoch = lifecycleEpoch) {
    const lease = sourceOwner.lease?.()
    sourceOwner.assertCurrent(lease)
    const sessionValue = await sessionManager.getSessionToken()
    if (stopped || expectedLifecycleEpoch !== lifecycleEpoch) return
    sourceOwner.assertCurrent(lease)
    if (!String(sessionValue ?? '')) throw new Error('mt_session_token_unavailable')
    let game = null
    let chat = null
    try {
      game = createSocket(gameUrl, socketOptions('game'))
      chat = createSocket(chatUrl, socketOptions('chat'))
    } catch (error) {
      game?.close?.()
      chat?.close?.()
      throw error
    }
    generation += 1
    const current = {
      id: generation,
      lease,
      sessionValue,
      authenticated: { game: false, chat: false },
      opened: { game: false, chat: false },
      joinRequested: { game: false, chat: false },
      joined: { game: false, chat: false },
      openTimers: { game: null, chat: null },
      authTimers: { game: null, chat: null },
      pendingTables: null,
      tablesRefreshRequestedAtMs: null,
      lastMessageAt: null,
      reconnectScheduled: false,
      reconnectAttempt: 0,
      messageChain: Promise.resolve(),
      game,
      chat,
    }
    sockets = current
    attach(current, 'game')
    attach(current, 'chat')
  }

  function attach(current, kind) {
    const socket = current[kind]
    const timeout = Math.max(0, Number(connectTimeoutMs) || 0)
    if (timeout > 0) {
      current.openTimers[kind] = setTimeoutFn(() => {
        current.openTimers[kind] = null
        if (!isCurrent(current) || current.opened[kind]) return
        handleError(new Error(`mt_socket_open_timeout:${kind}`))
        scheduleReconnect(current)
      }, timeout)
      current.openTimers[kind]?.unref?.()
    }
    socket.on('open', () => {
      if (!isCurrent(current)) return
      clearTimeoutFn(current.openTimers[kind])
      current.openTimers[kind] = null
      current.opened[kind] = true
      send(socket, authenticatePacket(kind, current.sessionValue))
      const authTimeout = Math.max(0, Number(authenticateTimeoutMs) || 0)
      if (authTimeout > 0) {
        current.authTimers[kind] = setTimeoutFn(() => {
          current.authTimers[kind] = null
          if (!isCurrent(current) || current.authenticated[kind]) return
          const reason = `mt_authenticate_timeout:${kind}`
          handleError(new Error(reason))
          void refreshGeneration(current, { reason })
        }, authTimeout)
        current.authTimers[kind]?.unref?.()
      }
    })
    socket.on('message', (raw) => {
      current.messageChain = current.messageChain
        .then(() => handleMessage(current, kind, raw))
        .catch((error) => {
          try { handleError(error) } catch {}
          scheduleReconnect(current)
        })
      void current.messageChain
    })
    socket.on('error', handleError)
    socket.on('close', () => {
      current.opened[kind] = false
      current.authenticated[kind] = false
      current.joined[kind] = false
      scheduleReconnect(current)
    })
  }

  async function handleMessage(current, kind, raw) {
    if (!isCurrent(current)) return
    const payload = parseJson(raw)
    if (!payload) return
    current.lastMessageAt = new Date(Number(now())).toISOString()
    const action = actionName(payload)
    if (isAuthenticateAction(kind, action)) {
      if (Number(payload.err) !== 0) {
        await refreshGeneration(current, { reason: `authenticate_err_${Number(payload.err)}` })
        return
      }
      current.authenticated[kind] = true
      clearTimeoutFn(current.authTimers[kind])
      current.authTimers[kind] = null
      send(current[kind], memberPacket(kind))
      if (kind === 'game') requestTables(current)
      joinWhenReady(current)
      return
    }
    const joinKind = joinActionKind(action)
    if (joinKind) {
      if (joinKind !== kind || !current.authenticated[kind] || !current.joinRequested[kind]) {
        handleError(new Error(`mt_join_ack_protocol_violation:${joinKind}`))
        scheduleReconnect(current)
        return
      }
      if (Number(payload.err) !== 0) {
        scheduleReconnect(current)
        return
      }
      current.joined[joinKind] = true
      if (current.joined.game && current.joined.chat) {
        reconnecting = false
        await deliverPendingTables(current)
      }
      return
    }
    if (Array.isArray(payload?.msg?.tables)) {
      current.tablesRefreshRequestedAtMs = null
      const validated = validateExactTables(payload.msg.tables)
      if (validated) {
        const merged = mergeExactTablesMonotonic(latestTables, validated, latestFinalScreenByTable)
        latestTables = merged
        if (exactJoinComplete(current)) await onTables(merged)
        else current.pendingTables = merged
      }
    }
    if (kind !== 'game') return
    const finalAction = finalActionName(action)
    if (!finalAction) return
    const final = normalizeFinalPayload(payload, finalAction)
    if (!final) return
    if (!exactJoinComplete(current)) return
    refreshGenerationLease(current)
    eventSequence += 1
    const source = typeof sourceOwner.nextEventSource === 'function'
      ? await sourceOwner.nextEventSource(current.lease)
      : sourceOwner.eventSource(eventSequence, current.lease)
    refreshGenerationLease(current)
    if (source?.mode !== current.lease.mode || source?.ownerId !== current.lease.ownerId
      || Number(source?.epoch) !== Number(current.lease.epoch) || source?.fence !== current.lease.fence) {
      throw new Error('stale_source_fence')
    }
    await onFinal({ ...final, source })
    const previousFinalScreen = latestFinalScreenByTable.get(final.tableId)
    if (isStrictlyNewerScreen(previousFinalScreen, final)) {
      latestFinalScreenByTable.set(final.tableId, { shoe: final.shoe, round: final.round })
    }
    if (latestTables) {
      latestTables = advanceExactTableFromFinal(latestTables, final, now)
      await onTables(latestTables)
    }
    requestTables(current)
  }

  function joinWhenReady(current) {
    if (!isCurrent(current) || (current.joinRequested.game && current.joinRequested.chat)
      || !current.authenticated.game || !current.authenticated.chat) return
    refreshGenerationLease(current)
    if (!current.joinRequested.chat && send(current.chat, chatJoinPacket())) {
      current.joinRequested.chat = true
      current.joined.chat = true
    }
    if (!current.joinRequested.game && send(current.game, multipleJoinPacket())) current.joinRequested.game = true
    if (current.joinRequested.game && current.joinRequested.chat) startHeartbeat(current)
  }

  async function deliverPendingTables(current) {
    if (!isCurrent(current) || !exactJoinComplete(current) || !current.pendingTables) return
    const pending = current.pendingTables
    current.pendingTables = null
    latestTables = pending
    await onTables(pending)
  }

  function requestTables(current) {
    if (!isCurrent(current)) return false
    const currentTimeMs = Number(now())
    if (current.tablesRefreshRequestedAtMs != null
      && currentTimeMs - Number(current.tablesRefreshRequestedAtMs) < resolvedTablesRefreshTimeoutMs) return false
    if (!send(current.game, tablesPacket())) return false
    current.tablesRefreshRequestedAtMs = currentTimeMs
    return true
  }

  function startHeartbeat(current) {
    clearIntervalFn(heartbeatTimer)
    heartbeatTimer = setIntervalFn(() => {
      if (!isCurrent(current)) return
      refreshGenerationLease(current)
      send(current.game, pingPacket())
      send(current.chat, pingPacket())
    }, Math.max(1, Number(heartbeatMs) || 1))
    heartbeatTimer?.unref?.()
  }

  function refreshGenerationLease(current) {
    const renewed = sourceOwner.lease?.() ?? current.lease
    if (!renewed || renewed.mode !== current.lease?.mode || renewed.ownerId !== current.lease?.ownerId
      || Number(renewed.epoch) !== Number(current.lease?.epoch) || renewed.fence !== current.lease?.fence) {
      throw new Error('stale_source_fence')
    }
    current.lease = renewed
    sourceOwner.assertCurrent(current.lease)
    return current.lease
  }

  function scheduleReconnect(current) {
    if (stopped || !isCurrent(current) || current.reconnectScheduled) return
    current.reconnectScheduled = true
    reconnecting = true
    clearIntervalFn(heartbeatTimer)
    heartbeatTimer = null
    closeGeneration(current)
    clearTimeoutFn(reconnectTimer)
    const baseDelay = Math.max(0, Number(reconnectDelayMs) || 0)
    const maxDelay = Math.max(baseDelay, Number(reconnectMaxDelayMs) || baseDelay)
    const delay = Math.min(maxDelay, baseDelay * (2 ** Math.min(current.reconnectAttempt, 30)))
    reconnectTimer = setTimeoutFn(async () => {
      reconnectTimer = null
      if (stopped || !isCurrent(current)) return
      current.reconnectScheduled = false
      try {
        await connectGeneration()
      } catch (error) {
        handleError(error)
        if (!stopped && isCurrent(current)) {
          current.reconnectAttempt += 1
          scheduleReconnect(current)
        }
      }
    }, delay)
    reconnectTimer?.unref?.()
  }

  function refreshGeneration(current, reason) {
    if (!isCurrent(current)) return refreshPromise ?? Promise.resolve()
    if (refreshPromise) return refreshPromise
    clearTimeoutFn(reconnectTimer)
    clearIntervalFn(heartbeatTimer)
    reconnectTimer = null
    heartbeatTimer = null
    generation += 1
    sockets = null
    closeGeneration(current)
    refreshCycle = { reason, retryAttempt: 0 }
    return runRefreshAttempt(refreshCycle)
  }

  function runRefreshAttempt(cycle) {
    if (stopped || refreshCycle !== cycle) return Promise.resolve()
    refreshPromise = (async () => {
      try {
        if (typeof sessionManager.refresh !== 'function') throw new Error('mt_session_refresh_unavailable')
        await sessionManager.refresh(cycle.reason)
        if (stopped || refreshCycle !== cycle) return
        await connectGeneration()
        if (stopped || refreshCycle !== cycle) return
        refreshCycle = null
        reconnecting = false
      } catch (error) {
        handleError(error)
        scheduleRefreshRetry(cycle)
      } finally {
        refreshPromise = null
      }
    })()
    return refreshPromise
  }

  function scheduleRefreshRetry(cycle) {
    if (stopped || refreshCycle !== cycle) return
    reconnecting = true
    clearTimeoutFn(reconnectTimer)
    const baseDelay = Math.max(0, Number(reconnectDelayMs) || 0)
    const maxDelay = Math.max(baseDelay, Number(reconnectMaxDelayMs) || baseDelay)
    const delay = Math.min(maxDelay, baseDelay * (2 ** Math.min(cycle.retryAttempt, 30)))
    cycle.retryAttempt += 1
    reconnectTimer = setTimeoutFn(async () => {
      reconnectTimer = null
      if (stopped || refreshCycle !== cycle) return
      await runRefreshAttempt(cycle)
    }, delay)
    reconnectTimer?.unref?.()
  }

  function stop() {
    stopped = true
    lifecycleEpoch += 1
    refreshCycle = null
    clearTimeoutFn(reconnectTimer)
    clearIntervalFn(heartbeatTimer)
    reconnectTimer = null
    heartbeatTimer = null
    closeGeneration(sockets)
    sockets = null
    reconnecting = false
  }

  function closeGeneration(current) {
    if (current?.openTimers) {
      clearTimeoutFn(current.openTimers.game)
      clearTimeoutFn(current.openTimers.chat)
      current.openTimers.game = null
      current.openTimers.chat = null
    }
    if (current?.authTimers) {
      clearTimeoutFn(current.authTimers.game)
      clearTimeoutFn(current.authTimers.chat)
      current.authTimers.game = null
      current.authTimers.chat = null
    }
    current?.game?.close?.()
    current?.chat?.close?.()
  }

  function isCurrent(current) {
    return !stopped && sockets === current && current.id === generation
  }

  function handleError(error) {
    try { onError(String(error?.message ?? error)) } catch {}
  }

  return {
    start,
    stop,
    snapshot: () => ({
      generation,
      connected: Boolean(sockets?.opened.game && sockets?.opened.chat),
      authenticated: Boolean(sockets?.authenticated.game && sockets?.authenticated.chat),
      joined: Boolean(sockets && exactJoinComplete(sockets)),
      lastMessageAt: sockets?.lastMessageAt ?? null,
      reconnecting,
      refreshing: Boolean(refreshPromise),
    }),
  }
}

export function multipleJoinPacket(tableIds = PRODUCTION_TABLE_IDS) {
  const exact = tableIds.map(canonicalProductionTableId)
  if (exact.length !== PRODUCTION_TABLE_IDS.length || exact.some((value, index) => value !== PRODUCTION_TABLE_IDS[index])) {
    throw new Error('mt_api_exact_ten_tables_required')
  }
  return { method: 'GET', action: { name: '/api/v1/gametype/*/game/*/room/*/mulitple_join', data: { table_id: exact.join(',') } } }
}

function authenticatePacket(kind, sessionValue) {
  const name = kind === 'chat' ? '/api/v1/chat/authenticate' : '/api/v1/authenticate'
  return {
    method: 'POST',
    action: kind === 'chat' ? { name, path: name } : { name },
    body: { type: 3, token: sessionValue },
  }
}

function memberPacket(kind) {
  const action = { name: '/api/v1/member/me' }
  if (kind === 'chat') action.path = '/api/v1/member/me'
  return { method: 'POST', action, ...(kind === 'game' ? { body: { lang: 'zhtw' } } : {}) }
}

function tablesPacket() {
  return { method: 'GET', action: { name: '/api/v1/gametype/*/game/*/room/*/tables', data: { gametype_id: 3, game_id: 1, room_id: 1 } } }
}

function chatJoinPacket() {
  return {
    method: 'POST',
    action: { name: '/api/v1/chat/room/*/table/*/join', path: '/api/v1/chat/room/1/table/0/join', data: { room_id: 1, table_id: 0 } },
    body: { role_type: 3 },
  }
}

function pingPacket() {
  return { method: 'POST', action: { name: '/api/v1/ping' } }
}

function socketOptions(kind) {
  return { kind, headers: { Origin: 'https://gsa.ofalive99.net', 'User-Agent': MT_BROWSER_USER_AGENT } }
}

function send(socket, packet) {
  if (socket?.readyState !== 1) return false
  socket.send(JSON.stringify(packet))
  return true
}

function parseJson(raw) {
  try { return JSON.parse(raw.toString()) } catch { return null }
}

function actionName(payload) {
  return String(typeof payload?.action === 'object' ? payload.action.name ?? payload.action.path ?? '' : payload?.action ?? '')
}

function isAuthenticateAction(kind, action) {
  return action === (kind === 'chat' ? '/api/v1/chat/authenticate' : '/api/v1/authenticate')
}

function joinActionKind(action) {
  if (action.endsWith('/mulitple_join')) return 'game'
  if (action.endsWith('/chat/room/*/table/*/join') || /\/chat\/room\/[^/]+\/table\/[^/]+\/join$/.test(action)) return 'chat'
  return null
}

function exactJoinComplete(current) {
  return current?.authenticated.game === true && current?.authenticated.chat === true
    && current?.joined.game === true && current?.joined.chat === true
}

function validateExactTables(tables) {
  if (!Array.isArray(tables)) return null
  const byIdentity = new Map()
  for (const table of tables) {
    const identity = canonicalProductionTableId(table?.tableId ?? table?.table_id)
    if (!PRODUCTION_TABLE_IDS.includes(identity)) continue
    if (byIdentity.has(identity)) return null
    byIdentity.set(identity, table)
  }
  if (byIdentity.size !== PRODUCTION_TABLE_IDS.length) return null
  return PRODUCTION_TABLE_IDS.map((tableId) => structuredClone(byIdentity.get(tableId)))
}

function mergeExactTablesMonotonic(previousTables, incomingTables, finalScreens = new Map()) {
  const previousById = new Map((Array.isArray(previousTables) ? previousTables : [])
    .map((table) => [canonicalProductionTableId(table?.tableId ?? table?.table_id), table]))
  return incomingTables.map((incoming) => {
    const tableId = canonicalProductionTableId(incoming?.tableId ?? incoming?.table_id)
    const previous = previousById.get(tableId)
    let selected = incoming
    const previousShoe = Number(previous?.shoe)
    const incomingShoe = Number(incoming?.shoe)
    const previousRound = Number(previous?.round)
    const incomingRound = Number(incoming?.round)
    const staleNumericShoe = previous && Number.isSafeInteger(previousShoe) && Number.isSafeInteger(incomingShoe) && incomingShoe < previousShoe
    const staleSameShoeRound = previous && String(incoming?.shoe) === String(previous?.shoe)
      && Number.isSafeInteger(previousRound) && Number.isSafeInteger(incomingRound) && incomingRound < previousRound
    if (staleNumericShoe || staleSameShoeRound) selected = previous
    const finalScreen = finalScreens.get(tableId)
    if (finalScreen && (Number(selected?.shoe) < Number(finalScreen.shoe)
      || (String(selected?.shoe) === String(finalScreen.shoe) && Number(selected?.round) < Number(finalScreen.round)))) {
      selected = { ...structuredClone(selected), shoe: finalScreen.shoe, round: finalScreen.round }
    }
    return structuredClone(selected)
  })
}

function advanceExactTableFromFinal(tables, final, now) {
  const finalTableId = canonicalProductionTableId(final?.tableId)
  const sourceUpdatedAt = new Date(Number(now())).toISOString()
  return tables.map((table) => canonicalProductionTableId(table?.tableId ?? table?.table_id) === finalTableId
    ? (isStrictlyNewerScreen(table, final)
        ? { ...structuredClone(table), shoe: final.shoe, round: final.round, sourceUpdatedAt }
        : structuredClone(table))
    : structuredClone(table))
}

function isStrictlyNewerScreen(previous, candidate) {
  if (!previous) return true
  const previousShoe = Number(previous?.shoe)
  const candidateShoe = Number(candidate?.shoe)
  const previousRound = Number(previous?.round)
  const candidateRound = Number(candidate?.round)
  if (![previousShoe, candidateShoe, previousRound, candidateRound].every(Number.isSafeInteger)) return false
  return candidateShoe > previousShoe || (candidateShoe === previousShoe && candidateRound > previousRound)
}

function finalActionName(action) {
  if (action.endsWith('/summary')) return 'summary'
  return null
}

function normalizeFinalPayload(payload, sourceAction) {
  const body = payload?.body
  if (!body || typeof body !== 'object') return null
  const rawResult = Array.isArray(body.result)
    ? body.result.map(Number)
    : String(body.result ?? '').split(',').filter((value) => value !== '').map(Number)
  if (!isExactTenRawResult(rawResult)) return null
  const normalized = normalizeExactRealCardEvent({ rawResult })
  const tableId = canonicalProductionTableId(body.table_id)
  if (!normalized || !PRODUCTION_TABLE_IDS.includes(tableId)) return null
  if (!Number.isSafeInteger(Number(body.shoe)) || !Number.isSafeInteger(Number(body.round)) || Number(body.round) < 1) return null
  return {
    tableId,
    roomId: Number(body.room_id),
    shoe: Number(body.shoe),
    round: Number(body.round),
    winner: normalized.result,
    playerPoint: normalized.playerPoint,
    bankerPoint: normalized.bankerPoint,
    rawResult: normalized.rawResult,
    sourceAction,
    final: true,
  }
}
