import { buildV104FormalPrediction, V104_FORMAL_STRATEGY_VERSION } from './v104-formal-strategy.js'

const HISTORY_LIMIT = 1000

export function createV104FormalRuntime({ writer = null, requestTimeoutMs = 10000, allowUnconfigured = false } = {}) {
  const issuanceStreaks = new Map()
  let historyRows = []
  let hydrationPromise = null
  let status = 'initializing'
  let error = null

  async function start() {
    if (!hydrationPromise) {
      hydrationPromise = Promise.resolve().then(async () => {
        if (!writer?.configured || typeof writer.getV104FormalHistory !== 'function') {
          if (!allowUnconfigured) throw new Error('v104 formal history reader is unavailable')
          historyRows = []
          issuanceStreaks.clear()
          status = 'ready'
          error = null
          return
        }
        const rows = await withTimeout(
          writer.getV104FormalHistory({ limit: HISTORY_LIMIT, requestTimeoutMs }),
          requestTimeoutMs,
          'v104 formal history hydration',
        )
        historyRows = Array.isArray(rows) ? structuredClone(rows) : []
        hydrateIssuanceStreaks(historyRows, issuanceStreaks)
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

  async function buildPrediction(table = {}) {
    await start()
    const prior = issuanceStreaks.get(tableKey(table.tableId))
    const currentShoe = table.shoe == null ? '' : String(table.shoe)
    const targetRound = Number(table.round) + 1
    const contiguousPrior = prior?.shoe === currentShoe
      && Number.isSafeInteger(targetRound)
      && Number.isSafeInteger(prior?.round)
      && targetRound === prior.round + 1
      ? prior
      : null
    return buildV104FormalPrediction(table, historyRows, {
      priorShoe: contiguousPrior?.shoe,
      priorDirection: contiguousPrior?.direction,
      priorSameSideStreak: contiguousPrior?.sameSideStreak,
    })
  }

  function recordIssuance(issued = {}) {
    assertFormalIssuance(issued)
    const key = tableKey(issued.targetTableId)
    const prior = issuanceStreaks.get(key)
    const shoe = String(issued.targetShoe ?? '')
    const round = Number(issued.targetRound)
    const direction = String(issued.predictedResult)
    const contiguous = prior?.shoe === shoe
      && prior?.direction === direction
      && Number.isSafeInteger(prior?.round)
      && round === prior.round + 1
    const sameSideStreak = contiguous ? prior.sameSideStreak + 1 : 1
    if (Number(issued.sameSideStreak) !== sameSideStreak) {
      throw new Error('v104 formal issuance streak acknowledgement mismatch')
    }
    issuanceStreaks.set(key, { shoe, direction, sameSideStreak, round })
    appendIssuanceHistory(historyRows, issued)
    status = 'ready'
    error = null
  }

  function recordSettlement(row = {}) {
    const strategy = row?.strategy_version ?? row?.strategyVersion
    if (strategy !== V104_FORMAL_STRATEGY_VERSION) return false
    const predictionId = row?.id ?? row?.prediction_id ?? row?.predictionId
    let target = historyRows.find((item) => String(item?.prediction_id ?? item?.predictionId ?? '') === String(predictionId ?? ''))
    if (!target) {
      target = structuredClone(row)
      historyRows.push(target)
    } else {
      Object.assign(target, structuredClone(row))
    }
    trimHistory(historyRows)
    return true
  }

  return {
    start,
    buildPrediction,
    recordIssuance,
    recordSettlement,
    snapshot() {
      return {
        strategyVersion: V104_FORMAL_STRATEGY_VERSION,
        status,
        error,
        historySource: 'v104_formal_issuance_and_final_only',
        historyRows: historyRows.length,
        lastIssuanceByTable: Object.fromEntries([...issuanceStreaks.entries()].map(([key, value]) => [key, { ...value }])),
      }
    },
  }
}

function hydrateIssuanceStreaks(rows, state) {
  const ordered = rows.filter((row) => (row?.strategy_version ?? row?.strategyVersion) === V104_FORMAL_STRATEGY_VERSION
      && (row?.prediction_timing ?? row?.predictionTiming) === 'pre_result_context'
      && Boolean(row?.prediction_issued_at ?? row?.predictionIssuedAt))
    .sort((left, right) => rowTime(left) - rowTime(right))
  for (const row of ordered) {
    const tableId = row?.table_id ?? row?.tableId
    const shoe = String(row?.shoe_no ?? row?.targetShoe ?? row?.shoe ?? '')
    const round = Number(row?.round_no ?? row?.targetRound ?? row?.round)
    const direction = String(row?.predicted_result ?? row?.predictedResult ?? '')
    if (!tableId || !Number.isSafeInteger(round) || !['banker', 'player'].includes(direction)) continue
    const key = tableKey(tableId)
    const prior = state.get(key)
    const contiguous = prior?.shoe === shoe && prior?.direction === direction && round === prior.round + 1
    state.set(key, { shoe, direction, sameSideStreak: contiguous ? prior.sameSideStreak + 1 : 1, round })
  }
}

function appendIssuanceHistory(rows, issued) {
  if (rows.some((row) => String(row?.prediction_id ?? row?.predictionId ?? '') === String(issued.predictionId))) return
  rows.push({
    prediction_id: issued.predictionId,
    source: issued.source,
    table_id: issued.targetTableId,
    shoe_no: issued.targetShoe,
    round_no: issued.targetRound,
    strategy_version: V104_FORMAL_STRATEGY_VERSION,
    prediction_timing: 'pre_result_context',
    prediction_issued_at: issued.issuedAt,
    predicted_result: issued.predictedResult,
    same_side_streak: issued.sameSideStreak,
    settlement_final: false,
    prediction_payload: structuredClone(issued),
  })
  trimHistory(rows)
}

function assertFormalIssuance(issued) {
  if (!issued?.predictionId || !issued?.issuedAt
    || issued.strategyVersion !== V104_FORMAL_STRATEGY_VERSION
    || issued.predictionTiming !== 'pre_result_context'
    || !issued.targetTableId || issued.targetShoe == null
    || !Number.isSafeInteger(Number(issued.targetRound))
    || !['banker', 'player'].includes(issued.predictedResult)) {
    throw new Error('v104 formal issuance acknowledgement failed')
  }
}

function tableKey(tableId) {
  return String(tableId ?? '')
}

function rowTime(row) {
  return Date.parse(row?.prediction_issued_at ?? row?.predictionIssuedAt ?? '') || 0
}

function trimHistory(rows) {
  while (rows.length > HISTORY_LIMIT) rows.shift()
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
