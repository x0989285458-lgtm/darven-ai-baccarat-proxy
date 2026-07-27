import {
  V105_SHADOW_V7_TABLE_IDS,
  V105_SHADOW_V7_VERSION,
  buildV105ShadowV7Prediction,
  buildV105ShadowV7Settlement,
} from './v105-shadow-v7-contract.js'

const TABLE_ALLOWLIST = new Set(V105_SHADOW_V7_TABLE_IDS)

export function resolveV105ShadowV7Enabled(env = process.env) {
  return env?.V105_SHADOW_V7_ENABLED !== 'false'
}

export function createV105ShadowV7Runtime({ enabled = true, writer = null, requestTimeoutMs = 10000 } = {}) {
  const issuances = new Map()
  const issuanceStreaks = new Map()
  const tableQueues = new Map()
  const issuancePromises = new Map()
  const settlementPromises = new Map()
  let historyRows = []
  let hydrationPromise = null
  let status = enabled ? 'initializing' : 'disabled'
  let error = null

  async function start() {
    if (!enabled) return
    if (!hydrationPromise) {
      hydrationPromise = Promise.resolve().then(async () => {
        if (!writer?.configured || typeof writer.getV105ShadowV7History !== 'function') throw new Error('v105 shadow v7 history reader is unavailable')
        const rows = await withTimeout(writer.getV105ShadowV7History({ limit: 10000 }), requestTimeoutMs, 'v105 shadow v7 history hydration')
        historyRows = (Array.isArray(rows) ? rows : []).filter(isOwnHistoryRow).map((row) => structuredClone(row))
        for (const row of [...historyRows].sort((a, b) => rowTime(a) - rowTime(b))) hydrateRow(row)
        status = 'ready'; error = null
      }).catch((cause) => {
        status = 'error'; error = cause?.message ?? String(cause); hydrationPromise = null
        throw cause
      })
    }
    return hydrationPromise
  }

  function hydrateRow(row) {
    const payload = row?.prediction_payload ?? row?.predictionPayload
    if (!payload || payload.strategyVersion !== V105_SHADOW_V7_VERSION) return
    const issued = deepFreeze({
      ...structuredClone(payload), predictionId: row?.prediction_id ?? row?.predictionId,
      issuedAt: row?.prediction_issued_at ?? row?.predictionIssuedAt,
    })
    if (!isValidIssued(issued)) return
    recordStreak(issued)
    if ((row?.settlement_final ?? row?.settlementFinal) !== true) issuances.set(identityKey(issued.targetTableId, issued.targetShoe, issued.targetRound), issued)
  }

  async function observeTableNow(table = {}) {
    if (!enabled || !TABLE_ALLOWLIST.has(String(table?.tableId ?? ''))) return null
    await start()
    const targetRound = Number(table.round) + 1
    const key = identityKey(table.tableId, table.shoe, targetRound)
    if (issuances.has(key)) return deepFreeze(structuredClone(issuances.get(key)))
    if (issuancePromises.has(key)) return issuancePromises.get(key)
    if (typeof writer?.issueV105ShadowV7Prediction !== 'function') throw new Error('v105 shadow v7 issuance writer is unavailable')
    const prior = issuanceStreaks.get(String(table.tableId))
    const candidate = buildV105ShadowV7Prediction(table, historyRows, {
      priorShoe: prior?.shoe, priorDirection: prior?.direction, priorSameSideStreak: prior?.sameSideStreak,
    })
    const operation = Promise.resolve().then(async () => {
      const issued = await withTimeout(writer.issueV105ShadowV7Prediction(candidate), requestTimeoutMs, 'v105 shadow v7 issuance')
      assertIssued(candidate, issued)
      const immutable = deepFreeze(structuredClone(issued))
      issuances.set(key, immutable); recordStreak(immutable); historyRows.push(historyRow(immutable))
      status = 'ready'; error = null
      return deepFreeze(structuredClone(immutable))
    }).catch((cause) => {
      status = 'error'; error = cause?.message ?? String(cause); throw cause
    }).finally(() => issuancePromises.delete(key))
    issuancePromises.set(key, operation)
    return operation
  }

  function observeTable(table = {}) {
    if (!enabled || !TABLE_ALLOWLIST.has(String(table?.tableId ?? ''))) return Promise.resolve(null)
    const tableId = String(table.tableId)
    const previous = tableQueues.get(tableId) ?? Promise.resolve()
    const operation = previous.then(() => observeTableNow(table))
    const tail = operation.then(() => undefined, () => undefined)
    tableQueues.set(tableId, tail)
    void tail.then(() => { if (tableQueues.get(tableId) === tail) tableQueues.delete(tableId) })
    return operation
  }

  function settleRound(round = {}) {
    if (!enabled || !TABLE_ALLOWLIST.has(String(round?.tableId ?? ''))) return Promise.resolve(null)
    const key = identityKey(round.tableId, round.shoe, round.round)
    if (settlementPromises.has(key)) return settlementPromises.get(key)
    const operation = Promise.resolve().then(async () => {
      await start()
      let issued = issuances.get(key)
      if (!issued && issuancePromises.has(key)) issued = await issuancePromises.get(key)
      if (!issued && typeof writer?.readV105ShadowV7Issuance === 'function') {
        issued = await withTimeout(writer.readV105ShadowV7Issuance({ source: round.source ?? 'ofalive99', tableId: round.tableId, shoe: round.shoe, round: round.round }), requestTimeoutMs, 'v105 shadow v7 issuance read')
        if (issued) assertIssued({ source: round.source ?? 'ofalive99', targetTableId: round.tableId, targetShoe: round.shoe, targetRound: round.round }, issued)
      }
      if (!issued) throw new Error('v105 shadow v7 settlement has no immutable issuance')
      if (typeof writer?.settleV105ShadowV7Prediction !== 'function') throw new Error('v105 shadow v7 settlement writer is unavailable')
      const settlement = buildV105ShadowV7Settlement(round, issued)
      const result = await withTimeout(writer.settleV105ShadowV7Prediction(settlement), requestTimeoutMs, 'v105 shadow v7 settlement')
      if (String(result?.predictionId ?? result?.prediction_id ?? '') !== String(issued.predictionId)) throw new Error('v105 shadow v7 settlement acknowledgement failed')
      issuances.delete(key); attachSettlement(settlement); status = 'ready'; error = null
      return { ...structuredClone(result), predictionId: issued.predictionId }
    }).catch((cause) => {
      status = 'error'; error = cause?.message ?? String(cause); throw cause
    }).finally(() => settlementPromises.delete(key))
    settlementPromises.set(key, operation)
    return operation
  }

  function recordStreak(issued) {
    issuanceStreaks.set(String(issued.targetTableId), {
      shoe: String(issued.targetShoe ?? ''), direction: issued.predictedResult,
      sameSideStreak: Number(issued.sameSideStreak), round: Number(issued.targetRound),
    })
  }

  function attachSettlement(settlement) {
    const row = historyRows.find((item) => String(item.prediction_id) === String(settlement.predictionId))
    if (row) Object.assign(row, { ...structuredClone(settlement), settlement_final: true })
  }

  return {
    enabled: Boolean(enabled), start, observeTable, settleRound,
    snapshot: () => ({
      strategyVersion: V105_SHADOW_V7_VERSION, status, error,
      historySource: 'v105_shadow_v7_only', historyRows: historyRows.length,
      pendingIssuances: issuances.size, activationEligible: false, memberVisible: false, writesSideActions: false,
    }),
  }
}

function isOwnHistoryRow(row) {
  return (row?.strategy_version ?? row?.strategyVersion) === V105_SHADOW_V7_VERSION
    && (row?.prediction_timing ?? row?.predictionTiming) === 'pre_result_context'
    && Boolean(row?.prediction_issued_at ?? row?.predictionIssuedAt)
}

function isValidIssued(issued) {
  return Boolean(issued?.predictionId && issued?.issuedAt && issued?.strategyVersion === V105_SHADOW_V7_VERSION && issued?.predictionTiming === 'pre_result_context')
}

function assertIssued(expected, issued) {
  if (!isValidIssued(issued)
    || String(issued.source ?? '') !== String(expected.source ?? '')
    || String(issued.targetTableId ?? '') !== String(expected.targetTableId ?? '')
    || String(issued.targetShoe ?? '') !== String(expected.targetShoe ?? '')
    || Number(issued.targetRound) !== Number(expected.targetRound)) throw new Error('v105 shadow v7 issuance acknowledgement failed')
}

function historyRow(issued) {
  return {
    prediction_id: issued.predictionId, source: issued.source, table_id: issued.targetTableId,
    shoe_no: String(issued.targetShoe), round_no: issued.targetRound, strategy_version: V105_SHADOW_V7_VERSION,
    prediction_timing: 'pre_result_context', prediction_issued_at: issued.issuedAt,
    predicted_result: issued.predictedResult, same_side_streak: issued.sameSideStreak,
    settlement_final: false, prediction_payload: structuredClone(issued),
  }
}

function identityKey(tableId, shoe, round) {
  return JSON.stringify(['ofalive99', String(tableId ?? ''), String(shoe ?? ''), Number(round), V105_SHADOW_V7_VERSION])
}
function rowTime(row) { return Date.parse(row?.prediction_issued_at ?? row?.predictionIssuedAt ?? '') || 0 }
function withTimeout(operation, timeoutMs, label) {
  const limit = Math.max(1, Number(timeoutMs) || 10000)
  let timer
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${limit}ms`)), limit); timer.unref?.() })
  return Promise.race([Promise.resolve(operation), timeout]).finally(() => clearTimeout(timer))
}
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}
