import {
  V104_SHADOW_STRATEGY_VERSION,
  buildV104ShadowPrediction,
  buildV104ShadowSettlement,
} from './v104-shadow-strategy.js'

function identityKey({ source = 'ofalive99', tableId, shoe, round }) {
  return JSON.stringify([String(source), String(tableId ?? ''), String(shoe ?? ''), Number(round), V104_SHADOW_STRATEGY_VERSION])
}

function tableKey({ source = 'ofalive99', tableId }) {
  return JSON.stringify([String(source), String(tableId ?? '')])
}

function withTimeout(operation, timeoutMs, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    timer.unref?.()
  })
  return Promise.race([Promise.resolve(operation), timeout]).finally(() => clearTimeout(timer))
}

export function resolveV104ShadowEnabled(env = process.env) {
  return env?.V104_SHADOW_ENABLED === 'true'
}

export function createV104ShadowRuntime({ enabled = false, writer = null, maxSettledKeys = 10000, maxPendingIssuances = 10000, requestTimeoutMs = 10000 } = {}) {
  const issuances = new Map()
  const issuanceOrder = []
  const issuancePromises = new Map()
  const issuanceStreaks = new Map()
  const tableObservationQueues = new Map()
  const settledResults = new Map()
  const settledOrder = []
  const settledKeyLimit = positiveLimit(maxSettledKeys)
  const pendingIssuanceLimit = positiveLimit(maxPendingIssuances)
  const timeoutMs = positiveLimit(requestTimeoutMs)
  let historyRows = []
  let hydrationPromise = null
  let status = enabled ? 'initializing' : 'disabled'
  let error = null

  async function ensureHydrated() {
    if (!enabled) return
    if (!hydrationPromise) {
      hydrationPromise = Promise.resolve().then(async () => {
        if (!writer?.configured || typeof writer.getV104ShadowHistory !== 'function') throw new Error('v104 shadow history reader is unavailable')
        const rows = await withTimeout(writer.getV104ShadowHistory({ limit: 10000 }), timeoutMs, 'v104 shadow history hydration')
        historyRows = Array.isArray(rows) ? structuredClone(rows) : []
        hydrateIssuanceStreaks(historyRows, issuanceStreaks)
        hydratePendingIssuances(historyRows, issuances, issuanceOrder, pendingIssuanceLimit)
        status = 'ready'
        error = null
      }).catch((cause) => {
        status = 'error'
        error = cause?.message ?? String(cause)
        hydrationPromise = null
        throw cause
      })
    }
    return hydrationPromise
  }

  async function observeTableNow(table = {}) {
    if (!enabled) return null
    await ensureHydrated()
    const durableKey = identityKey({
      source: 'ofalive99', tableId: table.tableId, shoe: table.shoe,
      round: Number(table.round ?? 0) + 1,
    })
    if (issuances.has(durableKey)) return structuredClone(issuances.get(durableKey))
    if (typeof writer?.issueV104ShadowPrediction !== 'function') throw new Error('v104 shadow issuance writer is unavailable')
    const streakKey = tableKey({ source: 'ofalive99', tableId: table.tableId })
    const prior = issuanceStreaks.get(streakKey)
    const candidate = buildV104ShadowPrediction(table, historyRows, {
      priorShoe: prior?.shoe,
      priorDirection: prior?.direction,
      priorSameSideStreak: prior?.sameSideStreak,
    })
    const key = identityKey({ source: candidate.source, tableId: candidate.targetTableId, shoe: candidate.targetShoe, round: candidate.targetRound })
    if (issuances.has(key)) return structuredClone(issuances.get(key))
    if (issuancePromises.has(key)) return issuancePromises.get(key)
    const promise = Promise.resolve().then(async () => {
      const issued = await withTimeout(writer.issueV104ShadowPrediction(candidate), timeoutMs, 'v104 shadow issuance')
      assertIssuedIdentity(candidate, issued)
      const immutable = Object.freeze(structuredClone(issued))
      issuances.set(key, immutable)
      issuanceOrder.push(key)
      while (issuanceOrder.length > pendingIssuanceLimit) issuances.delete(issuanceOrder.shift())
      issuanceStreaks.set(streakKey, {
        shoe: String(immutable.targetShoe ?? ''),
        direction: immutable.predictedResult,
        sameSideStreak: immutable.sameSideStreak,
        round: immutable.targetRound,
      })
      appendIssuanceHistory(historyRows, immutable)
      status = 'ready'
      error = null
      return structuredClone(immutable)
    }).catch((cause) => {
      status = 'error'
      error = cause?.message ?? String(cause)
      throw cause
    }).finally(() => issuancePromises.delete(key))
    issuancePromises.set(key, promise)
    return promise
  }

  function observeTable(table = {}) {
    const key = tableKey({ source: 'ofalive99', tableId: table.tableId })
    const previous = tableObservationQueues.get(key) ?? Promise.resolve()
    const operation = previous.then(() => observeTableNow(table))
    const tail = operation.then(() => undefined, () => undefined)
    tableObservationQueues.set(key, tail)
    void tail.then(() => {
      if (tableObservationQueues.get(key) === tail) tableObservationQueues.delete(key)
    })
    return operation
  }

  async function settleRound(round = {}) {
    if (!enabled) return null
    await ensureHydrated()
    const key = identityKey({ source: round.source ?? 'ofalive99', tableId: round.tableId, shoe: round.shoe, round: round.round })
    const cached = settledResults.get(key)
    if (cached) {
      const replay = buildV104ShadowSettlement(round, cached.issued)
      if (replay.actualResult !== cached.settlement.actualResult
        || replay.settlementStatus !== cached.settlement.settlementStatus
        || replay.settlementSourceAction !== cached.settlement.settlementSourceAction) throw new Error('conflicting v104 shadow settlement')
      return { ...structuredClone(cached.result), predictionId: cached.issued.predictionId, duplicate: true }
    }
    let issued = issuances.get(key)
    if (!issued && issuancePromises.has(key)) issued = await issuancePromises.get(key)
    if (!issued && typeof writer?.readV104ShadowIssuance === 'function') {
      issued = await withTimeout(writer.readV104ShadowIssuance({ source: round.source ?? 'ofalive99', tableId: round.tableId, shoe: round.shoe, round: round.round }), timeoutMs, 'v104 shadow issuance read')
      if (issued) {
        assertIssuedIdentity({ source: round.source ?? 'ofalive99', targetTableId: round.tableId, targetShoe: round.shoe, targetRound: round.round }, issued)
        issuances.set(key, Object.freeze(structuredClone(issued)))
      }
    }
    if (!issued) throw new Error('v104 shadow settlement has no immutable issuance')
    if (typeof writer?.settleV104ShadowPrediction !== 'function') throw new Error('v104 shadow settlement writer is unavailable')
    const settlement = buildV104ShadowSettlement(round, issued)
    let result
    try {
      result = await withTimeout(writer.settleV104ShadowPrediction(settlement), timeoutMs, 'v104 shadow settlement')
    } catch (cause) {
      status = 'error'
      error = cause?.message ?? String(cause)
      throw cause
    }
    if (String(result?.predictionId ?? result?.prediction_id ?? '') !== String(issued.predictionId)) throw new Error('v104 shadow settlement acknowledgement failed')
    issuances.delete(key)
    const index = issuanceOrder.indexOf(key)
    if (index >= 0) issuanceOrder.splice(index, 1)
    settledResults.set(key, { issued: structuredClone(issued), settlement: structuredClone(settlement), result: structuredClone(result) })
    settledOrder.push(key)
    while (settledOrder.length > settledKeyLimit) settledResults.delete(settledOrder.shift())
    attachSettlementHistory(historyRows, issued, settlement)
    status = 'ready'
    error = null
    return { ...result, predictionId: issued.predictionId }
  }

  return {
    enabled: Boolean(enabled), start: ensureHydrated, observeTable, settleRound,
    snapshot() {
      return {
        strategyVersion: V104_SHADOW_STRATEGY_VERSION,
        status, error,
        historySource: 'v104_shadow_issuance_and_final',
        historyRows: historyRows.length,
        trackedTableShoes: issuanceStreaks.size,
        pendingIssuances: issuances.size,
        activationEligible: false, memberVisible: false, writesSideActions: false,
      }
    },
  }
}

function hydratePendingIssuances(rows, issuances, issuanceOrder, limit) {
  for (const row of rows) {
    const final = row?.settlement_final ?? row?.settlementFinal
    const payload = row?.prediction_payload ?? row?.predictionPayload
    if (final === true || !payload || typeof payload !== 'object' || Array.isArray(payload)) continue
    const issued = {
      ...structuredClone(payload),
      predictionId: row?.prediction_id ?? row?.predictionId,
      issuedAt: row?.prediction_issued_at ?? row?.predictionIssuedAt,
    }
    try {
      assertIssuedIdentity(payload, issued)
    } catch {
      continue
    }
    const key = identityKey({
      source: issued.source, tableId: issued.targetTableId,
      shoe: issued.targetShoe, round: issued.targetRound,
    })
    issuances.set(key, Object.freeze(structuredClone(issued)))
    issuanceOrder.push(key)
    while (issuanceOrder.length > limit) issuances.delete(issuanceOrder.shift())
  }
}

function hydrateIssuanceStreaks(rows, state) {
  const ordered = rows.filter((row) => (row?.strategy_version ?? row?.strategyVersion) === V104_SHADOW_STRATEGY_VERSION
    && (row?.prediction_timing ?? row?.predictionTiming) === 'pre_result_context'
    && Boolean(row?.prediction_issued_at ?? row?.predictionIssuedAt))
    .sort((left, right) => rowTime(left) - rowTime(right))
  for (const row of ordered) {
    const source = row?.source ?? 'ofalive99'
    const tableId = row?.table_id ?? row?.tableId
    const shoe = String(row?.shoe_no ?? row?.targetShoe ?? row?.shoe ?? '')
    const direction = row?.predicted_result ?? row?.predictedResult
    if (!['banker', 'player'].includes(direction)) continue
    const key = tableKey({ source, tableId })
    const prior = state.get(key)
    const round = Number(row?.round_no ?? row?.targetRound ?? row?.round ?? 0)
    const contiguous = prior?.shoe === shoe
      && prior?.direction === direction
      && Number.isSafeInteger(round)
      && Number.isSafeInteger(prior?.round)
      && round === prior.round + 1
    state.set(key, {
      shoe,
      direction,
      sameSideStreak: contiguous ? prior.sameSideStreak + 1 : 1,
      round,
    })
  }
}

function appendIssuanceHistory(rows, issued) {
  if (rows.some((row) => String(row?.prediction_id ?? row?.predictionId ?? '') === String(issued.predictionId))) return
  rows.push({
    prediction_id: issued.predictionId, source: issued.source,
    table_id: issued.targetTableId, shoe_no: issued.targetShoe, round_no: issued.targetRound,
    strategy_version: V104_SHADOW_STRATEGY_VERSION, prediction_timing: 'pre_result_context',
    prediction_issued_at: issued.issuedAt, predicted_result: issued.predictedResult,
    same_side_streak: issued.sameSideStreak, independent_support_count: issued.independentSupportCount,
    shoe_bias_suppressed: issued.shoeBiasSuppressed, lock_risk: issued.lockRisk,
    settlement_final: false,
  })
  while (rows.length > 10000) rows.shift()
}

function attachSettlementHistory(rows, issued, settlement) {
  let row = rows.find((entry) => String(entry?.prediction_id ?? entry?.predictionId ?? '') === String(issued.predictionId))
  if (!row) {
    appendIssuanceHistory(rows, issued)
    row = rows.find((entry) => String(entry?.prediction_id ?? entry?.predictionId ?? '') === String(issued.predictionId))
  }
  Object.assign(row, {
    settlement_final: true, actual_result: settlement.actualResult,
    settlement_status: settlement.settlementStatus, resolved_at: settlement.resolvedAt,
  })
}

function assertIssuedIdentity(candidate, issued) {
  if (!issued?.predictionId || !issued?.issuedAt
    || String(issued.source ?? '') !== String(candidate.source ?? '')
    || String(issued.targetTableId ?? '') !== String(candidate.targetTableId ?? '')
    || String(issued.targetShoe ?? '') !== String(candidate.targetShoe ?? '')
    || Number(issued.targetRound) !== Number(candidate.targetRound)
    || issued.strategyVersion !== V104_SHADOW_STRATEGY_VERSION
    || issued.predictionTiming !== 'pre_result_context') throw new Error('v104 shadow issuance acknowledgement failed')
}

function rowTime(row) {
  return Date.parse(row?.prediction_issued_at ?? row?.predictionIssuedAt ?? '') || 0
}

function positiveLimit(value) {
  return Math.max(1, Number(value) || 10000)
}
