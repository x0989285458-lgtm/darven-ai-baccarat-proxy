import {
  V105_SHADOW_V9_TABLE_IDS,
  V105_SHADOW_V9_VERSION,
  buildV105ShadowV9Prediction,
  buildV105ShadowV9Settlement,
} from './v105-shadow-v9-contract.js'

const TABLE_ALLOWLIST = new Set(V105_SHADOW_V9_TABLE_IDS)

export function resolveV105ShadowV9Enabled(env = process.env) {
  return env?.V105_SHADOW_V9_ENABLED !== 'false'
}

export function createV105ShadowV9Runtime({
  enabled = true,
  writer = null,
  requestTimeoutMs = 30000,
  maxPendingIssuances = 2000,
  maxHistoryRows = 10000,
  maxQueuedObservationsPerTable = 2,
} = {}) {
  const issuances = new Map()
  const issuanceStreaks = new Map()
  const tableQueues = new Map()
  const tableQueueDepths = new Map()
  const issuancePromises = new Map()
  const settlementPromises = new Map()
  const pendingIssuanceLimit = Math.max(1, Number(maxPendingIssuances) || 2000)
  const historyRowLimit = Math.max(1, Number(maxHistoryRows) || 10000)
  const tableQueueLimit = Math.max(1, Number(maxQueuedObservationsPerTable) || 2)
  let historyRows = []
  let hydrationPromise = null
  let status = enabled ? 'initializing' : 'disabled'
  let error = null

  async function start() {
    if (!enabled) return
    if (!hydrationPromise) {
      hydrationPromise = Promise.resolve().then(async () => {
        if (!writer?.configured || typeof writer.getV105ShadowV9History !== 'function') throw new Error('v105 shadow v9 history reader is unavailable')
        const rows = await withTimeout(writer.getV105ShadowV9History({ limit: 10000 }), requestTimeoutMs, 'v105 shadow v9 history hydration')
        historyRows = (Array.isArray(rows) ? rows : [])
          .filter(isOwnHistoryRow)
          .map((row) => structuredClone(row))
          .sort((a, b) => rowTime(a) - rowTime(b))
          .slice(-historyRowLimit)
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
    const payload = row?.prediction_payload ?? row?.predictionPayload
    if (!payload || payload.strategyVersion !== V105_SHADOW_V9_VERSION) return
    const issued = deepFreeze({
      ...structuredClone(payload),
      predictionId: row?.prediction_id ?? row?.predictionId,
      issuedAt: row?.prediction_issued_at ?? row?.predictionIssuedAt,
    })
    if (!isValidIssued(issued)) return
    recordStreak(issued)
    if ((row?.settlement_final ?? row?.settlementFinal) !== true) {
      rememberPendingIssuance(identityKey(issued.targetTableId, issued.targetShoe, issued.targetRound), issued)
    }
  }

  async function observeTableNow(table = {}) {
    if (!enabled || !TABLE_ALLOWLIST.has(String(table?.tableId ?? ''))) return null
    await start()
    const targetRound = Number(table.round) + 1
    const key = identityKey(table.tableId, table.shoe, targetRound)
    if (issuances.has(key)) return deepFreeze(structuredClone(issuances.get(key)))
    if (issuancePromises.has(key)) return issuancePromises.get(key)
    if (typeof writer?.issueV105ShadowV9Prediction !== 'function') throw new Error('v105 shadow v9 issuance writer is unavailable')
    const prior = issuanceStreaks.get(String(table.tableId))
    const candidate = buildV105ShadowV9Prediction(table, historyRows, {
      priorShoe: prior?.shoe,
      priorDirection: prior?.direction,
      priorSameSideStreak: prior?.sameSideStreak,
    })
    const operation = Promise.resolve().then(async () => {
      const issued = await withTimeout(writer.issueV105ShadowV9Prediction(candidate), requestTimeoutMs, 'v105 shadow v9 issuance')
      assertIssued(candidate, issued)
      const immutable = deepFreeze(structuredClone(issued))
      rememberPendingIssuance(key, immutable)
      recordStreak(immutable)
      appendHistoryRow(historyRow(immutable))
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
    if (depth >= tableQueueLimit) return Promise.resolve(null)
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
      if (inFlight.fingerprint !== fingerprint) return Promise.reject(new Error('v105 shadow v9 conflicting in-flight Final'))
      return inFlight.promise
    }
    const operation = Promise.resolve().then(async () => {
      await start()
      let issued = issuances.get(key)
      if (!issued && issuancePromises.has(key)) issued = await issuancePromises.get(key)
      if (!issued && typeof writer?.readV105ShadowV9Issuance === 'function') {
        issued = await withTimeout(writer.readV105ShadowV9Issuance({
          source: round.source ?? 'ofalive99', tableId: round.tableId, shoe: round.shoe, round: round.round,
        }), requestTimeoutMs, 'v105 shadow v9 issuance read')
        if (issued) assertIssued({ source: round.source ?? 'ofalive99', targetTableId: round.tableId, targetShoe: round.shoe, targetRound: round.round }, issued)
      }
      if (!issued) throw new Error('v105 shadow v9 settlement has no immutable issuance')
      if (typeof writer?.settleV105ShadowV9Prediction !== 'function') throw new Error('v105 shadow v9 settlement writer is unavailable')
      const settlement = buildV105ShadowV9Settlement(round, issued)
      const result = await withTimeout(writer.settleV105ShadowV9Prediction(settlement), requestTimeoutMs, 'v105 shadow v9 settlement')
      if (String(result?.predictionId ?? result?.prediction_id ?? '') !== String(issued.predictionId)) throw new Error('v105 shadow v9 settlement acknowledgement failed')
      issuances.delete(key)
      attachSettlement(settlement)
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

  function appendHistoryRow(row) {
    historyRows.push(row)
    if (historyRows.length > historyRowLimit) historyRows.splice(0, historyRows.length - historyRowLimit)
  }

  function attachSettlement(settlement) {
    const row = historyRows.find((item) => String(item.prediction_id) === String(settlement.predictionId))
    if (row) Object.assign(row, { ...structuredClone(settlement), settlement_final: true })
  }

  return {
    enabled: Boolean(enabled),
    start,
    observeTable,
    settleRound,
    snapshot: () => ({
      strategyVersion: V105_SHADOW_V9_VERSION,
      status,
      error,
      historySource: 'v105_shadow_v9_only',
      historyRows: historyRows.length,
      pendingIssuances: issuances.size,
      queuedObservations: [...tableQueueDepths.values()].reduce((sum, depth) => sum + depth, 0),
      activationEligible: false,
      memberVisible: false,
      writesSideActions: false,
    }),
  }
}

function isOwnHistoryRow(row) {
  return (row?.strategy_version ?? row?.strategyVersion) === V105_SHADOW_V9_VERSION
    && (row?.prediction_timing ?? row?.predictionTiming) === 'pre_result_context'
    && Boolean(row?.prediction_issued_at ?? row?.predictionIssuedAt)
}

function isValidIssued(issued) {
  return Boolean(issued?.predictionId && issued?.issuedAt && issued?.strategyVersion === V105_SHADOW_V9_VERSION && issued?.predictionTiming === 'pre_result_context')
}

function assertIssued(expected, issued) {
  if (!isValidIssued(issued)
    || String(issued.source ?? '') !== String(expected.source ?? '')
    || String(issued.targetTableId ?? '') !== String(expected.targetTableId ?? '')
    || String(issued.targetShoe ?? '') !== String(expected.targetShoe ?? '')
    || Number(issued.targetRound) !== Number(expected.targetRound)) {
    throw new Error('v105 shadow v9 issuance acknowledgement failed')
  }
}

function historyRow(issued) {
  return {
    prediction_id: issued.predictionId,
    source: issued.source,
    table_id: issued.targetTableId,
    shoe_no: String(issued.targetShoe),
    round_no: issued.targetRound,
    strategy_version: V105_SHADOW_V9_VERSION,
    prediction_timing: 'pre_result_context',
    prediction_issued_at: issued.issuedAt,
    predicted_result: issued.predictedResult,
    same_side_streak: issued.sameSideStreak,
    settlement_final: false,
    prediction_payload: structuredClone(issued),
  }
}

function identityKey(tableId, shoe, round) {
  return JSON.stringify(['ofalive99', String(tableId ?? ''), String(shoe ?? ''), Number(round), V105_SHADOW_V9_VERSION])
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
