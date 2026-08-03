import {
  V105_SHADOW_V10_TABLE_IDS,
  V105_SHADOW_V10_VERSION,
  buildV105ShadowV10Prediction,
  buildV105ShadowV10Settlement,
} from './v105-shadow-v10-contract.js'

const TABLE_ALLOWLIST = new Set(V105_SHADOW_V10_TABLE_IDS)

export function resolveV105ShadowV10Enabled(env = process.env) {
  return env?.V105_SHADOW_V10_ENABLED !== 'false'
}

export function createV105ShadowV10Runtime({
  enabled = true,
  writer = null,
  requestTimeoutMs = 30000,
  maxPendingIssuances = 2000,
  maxHistoryRows = 600,
  maxQueuedObservationsPerTable = 2,
} = {}) {
  const issuances = new Map()
  const issuanceStreaks = new Map()
  const tableQueues = new Map()
  const tableQueueDepths = new Map()
  const issuancePromises = new Map()
  const settlementPromises = new Map()
  const pendingIssuanceLimit = Math.max(1, Number(maxPendingIssuances) || 2000)
  const historyRowLimit = Math.min(600, Math.max(1, Number(maxHistoryRows) || 600))
  const tableQueueLimit = Math.max(1, Number(maxQueuedObservationsPerTable) || 2)
  let historyRows = []
  let hydrationPromise = null
  let status = enabled ? 'initializing' : 'disabled'
  let error = null
  let rejectedObservations = 0

  async function start() {
    if (!enabled) return
    if (!hydrationPromise) {
      hydrationPromise = Promise.resolve().then(async () => {
        if (!writer?.configured || typeof writer.getV105ShadowV10History !== 'function') throw new Error('v105 shadow v10 history reader is unavailable')
        const rows = await writer.getV105ShadowV10History({ perTableLimit: 60, requestTimeoutMs })
        historyRows = (Array.isArray(rows) ? rows : [])
          .filter(isOwnHistoryRow)
          .map(toCompactHistoryRow)
          .filter(Boolean)
          .sort(compareHistoryRows)
        trimCompactHistory(historyRows, historyRowLimit)
        for (const row of historyRows) hydrateRow(row)
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

  function hydrateRow(row) {
    const issued = deepFreeze({
      predictionId: row.prediction_id, issuedAt: row.prediction_issued_at,
      source: row.source, strategyVersion: row.strategy_version, predictionTiming: row.prediction_timing,
      targetTableId: row.table_id, targetShoe: row.shoe_no, targetRound: row.round_no,
      predictedResult: row.predicted_result, sameSideStreak: row.same_side_streak,
    })
    if (!isValidIssued(issued)) return
    recordStreak(issued)
  }

  async function observeTableNow(table = {}) {
    if (!enabled || !TABLE_ALLOWLIST.has(String(table?.tableId ?? ''))) return null
    await start()
    const targetRound = Number(table.round) + 1
    const key = identityKey(table.tableId, table.shoe, targetRound)
    if (issuances.has(key)) return deepFreeze(structuredClone(issuances.get(key)))
    if (issuancePromises.has(key)) return issuancePromises.get(key)
    if (typeof writer?.issueV105ShadowV10Prediction !== 'function') throw new Error('v105 shadow v10 issuance writer is unavailable')
    const prior = issuanceStreaks.get(String(table.tableId))
    const candidate = buildV105ShadowV10Prediction(table, historyRows, {
      priorShoe: prior?.shoe,
      priorDirection: prior?.direction,
      priorSameSideStreak: prior?.sameSideStreak,
    })
    const operation = Promise.resolve().then(async () => {
      const issued = await withTimeout(writer.issueV105ShadowV10Prediction(candidate), requestTimeoutMs, 'v105 shadow v10 issuance')
      assertIssued(candidate, issued)
      const immutable = deepFreeze(structuredClone(issued))
      rememberPendingIssuance(key, immutable)
      recordStreak(immutable)
      upsertPendingHistoryRow(historyRows, immutable, historyRowLimit)
      status = 'ready'
      error = null
      return deepFreeze(structuredClone(immutable))
    }).catch((cause) => {
      status = 'error'
      error = cause?.message ?? String(cause)
      throw cause
    }).finally(() => issuancePromises.delete(key))
    issuancePromises.set(key, operation)
    return operation
  }

  function observeTable(table = {}) {
    if (!enabled || !TABLE_ALLOWLIST.has(String(table?.tableId ?? ''))) return Promise.resolve(null)
    const tableId = String(table.tableId)
    const depth = tableQueueDepths.get(tableId) ?? 0
    if (depth >= tableQueueLimit + 1) {
      const cause = new Error('v105 shadow v10 observation queue is full')
      cause.code = 'SHADOW_RUNTIME_QUEUE_FULL'
      status = 'error'
      error = cause.message
      rejectedObservations += 1
      return Promise.reject(cause)
    }
    tableQueueDepths.set(tableId, depth + 1)
    const previous = tableQueues.get(tableId) ?? Promise.resolve()
    const operation = previous.then(() => observeTableNow(table))
    const tail = operation.then(() => undefined, () => undefined)
    tableQueues.set(tableId, tail)
    void tail.then(() => {
      const remaining = Math.max(0, (tableQueueDepths.get(tableId) ?? 1) - 1)
      if (remaining > 0) tableQueueDepths.set(tableId, remaining)
      else tableQueueDepths.delete(tableId)
      if (tableQueues.get(tableId) === tail) tableQueues.delete(tableId)
    })
    return operation
  }

  function settleRound(round = {}) {
    if (!enabled || !TABLE_ALLOWLIST.has(String(round?.tableId ?? ''))) return Promise.resolve(null)
    const key = identityKey(round.tableId, round.shoe, round.round)
    const fingerprint = settlementInputFingerprint(round)
    const inFlight = settlementPromises.get(key)
    if (inFlight) {
      if (inFlight.fingerprint !== fingerprint) return Promise.reject(new Error('v105 shadow v10 conflicting in-flight Final'))
      return inFlight.promise
    }
    const operation = Promise.resolve().then(async () => {
      await start()
      let issued = issuances.get(key)
      if (!issued && issuancePromises.has(key)) issued = await issuancePromises.get(key)
      if (!issued && typeof writer?.readV105ShadowV10Issuance === 'function') {
        issued = await withTimeout(writer.readV105ShadowV10Issuance({
          source: round.source ?? 'ofalive99', tableId: round.tableId, shoe: round.shoe, round: round.round,
        }), requestTimeoutMs, 'v105 shadow v10 issuance read')
        if (issued) assertIssued({ source: round.source ?? 'ofalive99', targetTableId: round.tableId, targetShoe: round.shoe, targetRound: round.round }, issued)
      }
      if (!issued) throw new Error('v105 shadow v10 settlement has no immutable issuance')
      if (typeof writer?.settleV105ShadowV10Prediction !== 'function') throw new Error('v105 shadow v10 settlement writer is unavailable')
      const settlement = buildV105ShadowV10Settlement(round, issued)
      const result = await withTimeout(writer.settleV105ShadowV10Prediction(settlement), requestTimeoutMs, 'v105 shadow v10 settlement')
      if (String(result?.predictionId ?? result?.prediction_id ?? '') !== String(issued.predictionId)) throw new Error('v105 shadow v10 settlement acknowledgement failed')
      issuances.delete(key)
      attachSettlement(issued, settlement)
      status = 'ready'
      error = null
      return { ...structuredClone(result), predictionId: issued.predictionId }
    }).catch((cause) => {
      status = 'error'
      error = cause?.message ?? String(cause)
      throw cause
    }).finally(() => {
      if (settlementPromises.get(key)?.promise === operation) settlementPromises.delete(key)
    })
    settlementPromises.set(key, { fingerprint, promise: operation })
    return operation
  }

  function recordStreak(issued) {
    issuanceStreaks.set(String(issued.targetTableId), {
      shoe: String(issued.targetShoe ?? ''), direction: issued.predictedResult,
      sameSideStreak: Number(issued.sameSideStreak), round: Number(issued.targetRound),
    })
  }

  function rememberPendingIssuance(key, issued) {
    issuances.delete(key)
    issuances.set(key, issued)
    while (issuances.size > pendingIssuanceLimit) issuances.delete(issuances.keys().next().value)
  }

  function attachSettlement(issued, settlement) {
    const row = finalHistoryRow(issued, settlement)
    const index = historyRows.findIndex((item) => String(item.prediction_id) === String(issued.predictionId))
    if (index >= 0) historyRows[index] = row
    else historyRows.push(row)
    trimCompactHistory(historyRows, historyRowLimit)
  }

  function getIssuanceContext(tableId) {
    const context = issuanceStreaks.get(String(tableId ?? ''))
    return context ? structuredClone(context) : null
  }

  return {
    enabled: Boolean(enabled),
    start,
    observeTable,
    settleRound,
    getIssuanceContext,
    snapshot: () => ({
      strategyVersion: V105_SHADOW_V10_VERSION,
      status,
      error,
      historySource: 'v105_shadow_v10_big_road_only',
      historyRows: historyRows.length,
      pendingIssuances: issuances.size,
      queuedObservations: [...tableQueueDepths.values()].reduce((sum, depth) => sum + depth, 0),
      rejectedObservations,
      activationEligible: false,
      memberVisible: false,
      writesSideActions: false,
    }),
  }
}

function isOwnHistoryRow(row) {
  return (row?.strategy_version ?? row?.strategyVersion) === V105_SHADOW_V10_VERSION
    && (row?.prediction_timing ?? row?.predictionTiming) === 'pre_result_context'
    && Boolean(row?.prediction_issued_at ?? row?.predictionIssuedAt)
}

function isValidIssued(issued) {
  return Boolean(issued?.predictionId && issued?.issuedAt && issued?.strategyVersion === V105_SHADOW_V10_VERSION && issued?.predictionTiming === 'pre_result_context')
}

function assertIssued(expected, issued) {
  if (!isValidIssued(issued)
    || String(issued.source ?? '') !== String(expected.source ?? '')
    || String(issued.targetTableId ?? '') !== String(expected.targetTableId ?? '')
    || String(issued.targetShoe ?? '') !== String(expected.targetShoe ?? '')
    || Number(issued.targetRound) !== Number(expected.targetRound)) {
    throw new Error('v105 shadow v10 issuance acknowledgement failed')
  }
}

function finalHistoryRow(issued, settlement) {
  return {
    prediction_id: issued.predictionId,
    source: issued.source,
    table_id: issued.targetTableId,
    shoe_no: String(issued.targetShoe),
    round_no: issued.targetRound,
    strategy_version: V105_SHADOW_V10_VERSION,
    prediction_timing: 'pre_result_context',
    prediction_issued_at: issued.issuedAt,
    predicted_result: issued.predictedResult,
    same_side_streak: issued.sameSideStreak,
    actual_result: settlement.actualResult,
    settlement_final: true,
  }
}

function identityKey(tableId, shoe, round) {
  return JSON.stringify(['ofalive99', String(tableId ?? ''), String(shoe ?? ''), Number(round), V105_SHADOW_V10_VERSION])
}

function settlementInputFingerprint(round = {}) {
  return JSON.stringify(canonicalValue(round))
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value instanceof Date) return value.toISOString()
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().flatMap((key) => {
      const nested = value[key]
      return nested === undefined || typeof nested === 'function' || typeof nested === 'symbol'
        ? []
        : [[key, canonicalValue(nested)]]
    }))
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value)
  return value
}

function rowTime(row) {
  return Date.parse(row?.prediction_issued_at ?? row?.predictionIssuedAt ?? '') || 0
}

function pendingHistoryRow(issued) {
  return {
    prediction_id: issued.predictionId,
    source: issued.source,
    table_id: issued.targetTableId,
    shoe_no: String(issued.targetShoe),
    round_no: issued.targetRound,
    strategy_version: V105_SHADOW_V10_VERSION,
    prediction_timing: 'pre_result_context',
    prediction_issued_at: issued.issuedAt,
    predicted_result: issued.predictedResult,
    same_side_streak: issued.sameSideStreak,
    actual_result: null,
    settlement_final: false,
  }
}

function upsertPendingHistoryRow(rows, issued, historyRowLimit) {
  const tableId = String(issued.targetTableId)
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (String(rows[index].table_id) === tableId && rows[index].settlement_final === false) rows.splice(index, 1)
  }
  rows.push(pendingHistoryRow(issued))
  trimCompactHistory(rows, historyRowLimit)
}

function toCompactHistoryRow(row) {
  const settlementFinal = row?.settlement_final ?? row?.settlementFinal
  if (settlementFinal !== true && settlementFinal !== false) return null
  if (settlementFinal === false && (row?.actual_result ?? row?.actualResult) != null) return null
  return {
    prediction_id: row.prediction_id, source: row.source, table_id: row.table_id, shoe_no: row.shoe_no,
    round_no: row.round_no, strategy_version: row.strategy_version, prediction_timing: row.prediction_timing,
    prediction_issued_at: row.prediction_issued_at, predicted_result: row.predicted_result,
    same_side_streak: row.same_side_streak, actual_result: settlementFinal ? row.actual_result : null,
    settlement_final: settlementFinal,
  }
}

function trimCompactHistory(rows, historyRowLimit) {
  rows.sort(compareHistoryRows)
  const finalCounts = new Map()
  const pendingTables = new Set()
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const tableId = String(rows[index].table_id)
    if (rows[index].settlement_final === false) {
      if (pendingTables.has(tableId)) rows.splice(index, 1)
      else pendingTables.add(tableId)
      continue
    }
    const count = (finalCounts.get(tableId) ?? 0) + 1
    finalCounts.set(tableId, count)
    if (count > 60) rows.splice(index, 1)
  }
  let finalCount = rows.reduce((count, row) => count + (row.settlement_final === true ? 1 : 0), 0)
  for (let index = 0; finalCount > historyRowLimit && index < rows.length;) {
    if (rows[index].settlement_final === true) { rows.splice(index, 1); finalCount -= 1 }
    else index += 1
  }
}

function compareHistoryRows(a, b) {
  return rowTime(a) - rowTime(b) || compareStableText(a?.prediction_id, b?.prediction_id)
}

function compareStableText(left, right) {
  const a = String(left ?? '')
  const b = String(right ?? '')
  return a === b ? 0 : a < b ? -1 : 1
}

function withTimeout(operation, timeoutMs, label) {
  const limit = Math.max(1, Number(timeoutMs) || 10000)
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${limit}ms`)), limit)
    timer.unref?.()
  })
  return Promise.race([Promise.resolve(operation), timeout]).finally(() => clearTimeout(timer))
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}
