import { buildV106FormalPrediction, V106_FORMAL_STRATEGY_VERSION } from './v106-formal-strategy.js'

const HISTORY_LIMIT = 1000

export function createV106FormalRuntime({ writer = null, requestTimeoutMs = 60000, allowUnconfigured = false } = {}) {
  const issuances = new Map()
  const issuanceStreaks = new Map()
  let historyRows = []
  let startPromise = null
  let status = 'initializing'
  let error = null

  async function start() {
    if (!startPromise) startPromise = Promise.resolve().then(async () => {
      if (!writer?.configured || typeof writer.getV106FormalHistory !== 'function') {
        if (!allowUnconfigured) throw new Error('v106 formal history reader is unavailable')
        historyRows = []
      } else {
        historyRows = await withTimeout(writer.getV106FormalHistory({ limit: HISTORY_LIMIT, requestTimeoutMs }), requestTimeoutMs)
        if (!Array.isArray(historyRows)) historyRows = []
      }
      historyRows = historyRows.filter(isCompatibleHistory).map((row) => structuredClone(row))
      for (const row of [...historyRows].reverse()) rememberHydratedIssuance(row)
      status = 'ready'
      error = null
    }).catch((cause) => {
      status = 'error'
      error = cause?.message ?? String(cause)
      throw cause
    })
    return startPromise
  }

  async function buildPrediction(table = {}) {
    await start()
    const prior = issuanceStreaks.get(String(table.tableId ?? ''))
    return buildV106FormalPrediction(table, historyRows, {
      priorShoe: prior?.shoe,
      priorDirection: prior?.direction,
      priorSameSideStreak: prior?.sameSideStreak,
    })
  }

  function recordIssuance(issued = {}) {
    assertIssuance(issued)
    const id = String(issued.predictionId)
    const fingerprint = JSON.stringify(issued)
    if (issuances.has(id)) {
      if (issuances.get(id) !== fingerprint) throw new Error('conflicting immutable v106 formal issuance')
      return false
    }
    issuances.set(id, fingerprint)
    issuanceStreaks.set(String(issued.targetTableId), {
      shoe: String(issued.targetShoe), round: Number(issued.targetRound),
      direction: issued.predictedResult, sameSideStreak: Number(issued.sameSideStreak),
    })
    historyRows.push({
      prediction_id: id, strategy_version: V106_FORMAL_STRATEGY_VERSION,
      prediction_timing: 'pre_result_context', prediction_issued_at: issued.issuedAt,
      table_id: issued.targetTableId, shoe_no: issued.targetShoe, round_no: issued.targetRound,
      predicted_result: issued.predictedResult, same_side_streak: issued.sameSideStreak,
      settlement_final: false, issued_prediction_payload: structuredClone(issued),
    })
    trim()
    return true
  }

  function recordSettlement(row = {}) {
    if ((row.settlement_final ?? row.settlementFinal) !== true) return false
    const strategyVersion = row.strategy_version ?? row.strategyVersion
    if (!['v105', V106_FORMAL_STRATEGY_VERSION].includes(strategyVersion)) return false
    const id = String(row.id ?? row.prediction_id ?? row.predictionId ?? '')
    const target = historyRows.find((item) => String(item.prediction_id ?? item.id ?? '') === id)
    if (!target || (target.strategy_version ?? target.strategyVersion) !== strategyVersion) return false
    Object.assign(target, structuredClone(row), { settlement_final: true })
    return true
  }

  function rememberHydratedIssuance(row) {
    const payload = row.issued_prediction_payload ?? row.prediction_payload
    if (payload?.predictionId) issuances.set(String(payload.predictionId), JSON.stringify(payload))
    const tableId = row.table_id ?? row.tableId
    const direction = row.predicted_result ?? row.predictedResult
    if (tableId && ['banker', 'player'].includes(direction)) issuanceStreaks.set(String(tableId), {
      shoe: String(row.shoe_no ?? row.targetShoe ?? ''), round: Number(row.round_no ?? row.targetRound),
      direction, sameSideStreak: Number(row.same_side_streak ?? row.sameSideStreak) || 1,
    })
  }

  function trim() { while (historyRows.length > HISTORY_LIMIT) historyRows.shift() }
  return {
    start, buildPrediction, recordIssuance, recordSettlement,
    snapshot: () => ({
      strategyVersion: V106_FORMAL_STRATEGY_VERSION, status, error,
      historySource: 'v106_formal_with_v105_read_only_calibration_history', historyRows: historyRows.length,
      lastIssuanceByTable: Object.fromEntries([...issuanceStreaks].map(([key, value]) => [key, { ...value }])),
    }),
  }
}

function isCompatibleHistory(row) {
  const version = row?.strategy_version ?? row?.strategyVersion
  return ['v105', V106_FORMAL_STRATEGY_VERSION].includes(version)
    && (row?.prediction_timing ?? row?.predictionTiming) === 'pre_result_context'
    && Boolean(row?.prediction_issued_at ?? row?.predictionIssuedAt)
}

function assertIssuance(issued) {
  if (!issued?.predictionId || !issued?.issuedAt || issued.strategyVersion !== V106_FORMAL_STRATEGY_VERSION
    || issued.predictionTiming !== 'pre_result_context' || !issued.targetTableId || issued.targetShoe == null
    || !Number.isSafeInteger(Number(issued.targetRound)) || !['banker', 'player'].includes(issued.predictedResult)) {
    throw new Error('v106 formal issuance acknowledgement failed')
  }
}

function withTimeout(operation, timeoutMs) {
  const limit = Math.max(1, Number(timeoutMs) || 60000)
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`v106 formal history hydration timed out after ${limit}ms`)), limit)
    timer.unref?.()
  })
  return Promise.race([Promise.resolve(operation), timeout]).finally(() => clearTimeout(timer))
}
