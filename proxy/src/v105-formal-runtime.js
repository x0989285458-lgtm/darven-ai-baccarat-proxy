import { V105_FORMAL_STRATEGY_VERSION } from './v105-formal-strategy.js'
import { buildV105V10MainPrediction } from './v105-v10-main-strategy.js'

const HISTORY_LIMIT = 1000

export function createV105FormalRuntime({ writer = null, requestTimeoutMs = 60000, allowUnconfigured = false, now = Date.now, retryBackoffMs = 300000 } = {}) {
  const issuanceStreaks = new Map()
  const issuancePredictionIds = new Map()
  const issuanceStrategyVersions = new Map()
  let historyRows = []
  let hydrationPromise = null
  let status = 'initializing'
  let error = null
  let retryAtMs = 0

  async function start() {
    if (status === 'error') {
      if (now() < retryAtMs) throw new Error(error ?? 'v105 formal history hydration failed')
      hydrationPromise = null
      status = 'initializing'
    }
    if (!hydrationPromise) {
      hydrationPromise = Promise.resolve().then(async () => {
        if (!writer?.configured || typeof writer.getV105FormalHistory !== 'function') {
          if (!allowUnconfigured) throw new Error('v105 formal history reader is unavailable')
          historyRows = []
          issuanceStreaks.clear()
          issuancePredictionIds.clear()
          issuanceStrategyVersions.clear()
          status = 'ready'
          error = null
          return
        }
        const rows = await withTimeout(
          writer.getV105FormalHistory({ limit: HISTORY_LIMIT, requestTimeoutMs }),
          requestTimeoutMs,
          'v105 formal history hydration',
        )
        historyRows = Array.isArray(rows) ? structuredClone(rows) : []
        hydrateIssuanceStreaks(historyRows, issuanceStreaks, issuancePredictionIds, issuanceStrategyVersions)
        status = 'ready'
        error = null
      }).catch((cause) => {
        status = 'error'
        error = cause?.message ?? String(cause)
        retryAtMs = now() + Math.max(1000, Number(retryBackoffMs) || 300000)
      })
    }
    await hydrationPromise
    if (status !== 'ready') throw new Error(error ?? 'v105 formal history hydration failed')
  }

  async function buildPrediction(table = {}) {
    await start()
    const prior = issuanceStreaks.get(tableKey(table.tableId))
    const currentShoe = table.shoe == null ? '' : String(table.shoe)
    const targetRound = Number(table.round) + 1
    const priorIssuance = prior?.shoe === currentShoe
      && Number.isSafeInteger(targetRound)
      && Number.isSafeInteger(prior?.round)
      && targetRound > prior.round
      ? prior
      : null
    return buildV105V10MainPrediction(table, historyRows, {
      priorShoe: priorIssuance?.shoe,
      priorDirection: priorIssuance?.direction,
      priorSameSideStreak: priorIssuance?.sameSideStreak,
    })
  }

  function recordIssuance(issued = {}) {
    assertFormalIssuance(issued)
    const key = tableKey(issued.targetTableId)
    const prior = issuanceStreaks.get(key)
    const shoe = String(issued.targetShoe ?? '')
    const round = Number(issued.targetRound)
    const direction = String(issued.predictedResult)
    const issuedStreak = Number(issued.sameSideStreak)
    assertForwardIssuanceIdentity(prior, { shoe, round })
    const sameTarget = prior?.shoe === shoe
      && Number.isSafeInteger(prior?.round)
      && round === prior.round
    if (sameTarget) {
      const existing = historyRows.find((row) => String(row?.table_id ?? row?.tableId ?? '') === key
        && String(row?.shoe_no ?? row?.targetShoe ?? row?.shoe ?? '') === shoe
        && Number(row?.round_no ?? row?.targetRound ?? row?.round) === round
        && (row?.strategy_version ?? row?.strategyVersion) === V105_FORMAL_STRATEGY_VERSION
        && (row?.prediction_timing ?? row?.predictionTiming) === 'pre_result_context')
      const existingPredictionId = issuancePredictionIds.get(key)
        ?? existing?.prediction_id ?? existing?.predictionId
      if (prior.direction !== direction
        || issuedStreak !== prior.sameSideStreak
        || (existingPredictionId && String(existingPredictionId) !== String(issued.predictionId))) {
        throw new Error('v105 formal issuance streak acknowledgement mismatch')
      }
      appendIssuanceHistory(historyRows, issued)
      status = 'ready'
      error = null
      return
    }
    const sameShoeForward = prior?.shoe === shoe
      && prior?.direction === direction
      && Number.isSafeInteger(prior?.round)
      && round > prior.round
    const sameSideStreak = sameShoeForward ? prior.sameSideStreak + 1 : 1
    if (issuedStreak !== sameSideStreak) {
      throw new Error('v105 formal issuance streak acknowledgement mismatch')
    }
    issuanceStreaks.set(key, { shoe, direction, sameSideStreak, round })
    issuancePredictionIds.set(key, String(issued.predictionId))
    issuanceStrategyVersions.set(key, V105_FORMAL_STRATEGY_VERSION)
    appendIssuanceHistory(historyRows, issued)
    status = 'ready'
    error = null
  }

  function recordSettlement(row = {}) {
    const strategy = row?.strategy_version ?? row?.strategyVersion
    if (strategy !== V105_FORMAL_STRATEGY_VERSION) return false
    const predictionId = row?.id ?? row?.prediction_id ?? row?.predictionId
    let target = historyRows.find((item) => String(item?.prediction_id ?? item?.predictionId ?? '') === String(predictionId ?? ''))
    if (!target) {
      target = structuredClone(row)
      target.final_v105_predicted_result = row?.predicted_result ?? row?.predictedResult
      target.predicted_result = row?.issued_prediction_payload?.baselineV104PredictedResult
        ?? row?.prediction_payload?.baselineV104PredictedResult
        ?? target.predicted_result
      historyRows.push(target)
    } else {
      const baselineDirection = target.predicted_result
      const finalDirection = row?.predicted_result ?? row?.predictedResult
      Object.assign(target, structuredClone(row))
      target.predicted_result = baselineDirection
      target.final_v105_predicted_result = finalDirection
    }
    trimHistory(historyRows)
    return true
  }

  return {
    start,
    buildPrediction,
    recordIssuance,
    recordSettlement,
    latestIssuance(tableId) {
      const key = tableKey(tableId)
      const latest = issuanceStreaks.get(key)
      const predictionId = issuancePredictionIds.get(key)
      if (!latest || !predictionId) return null
      return {
        predictionId,
        targetTableId: key,
        targetShoe: latest.shoe,
        targetRound: latest.round,
        strategyVersion: issuanceStrategyVersions.get(key),
        predictionTiming: 'pre_result_context',
        predictedResult: latest.direction,
        sameSideStreak: latest.sameSideStreak,
      }
    },
    snapshot() {
      return {
        strategyVersion: V105_FORMAL_STRATEGY_VERSION,
        status,
        error,
        historySource: 'v104_predecessor_plus_v105_formal_issuance_and_final',
        historyRows: historyRows.length,
        lastIssuanceByTable: Object.fromEntries([...issuanceStreaks.entries()].map(([key, value]) => [key, { ...value }])),
      }
    },
  }
}

function hydrateIssuanceStreaks(rows, state, predictionIds, strategyVersions) {
  const ordered = rows.filter((row) => ['v104', V105_FORMAL_STRATEGY_VERSION].includes(row?.strategy_version ?? row?.strategyVersion)
      && (row?.prediction_timing ?? row?.predictionTiming) === 'pre_result_context'
      && Boolean(row?.prediction_issued_at ?? row?.predictionIssuedAt))
    .sort((left, right) => rowTime(left) - rowTime(right))
  for (const row of ordered) {
    const tableId = row?.table_id ?? row?.tableId
    const predictionId = String(row?.prediction_id ?? row?.predictionId ?? '')
    const shoe = String(row?.shoe_no ?? row?.targetShoe ?? row?.shoe ?? '')
    const round = Number(row?.round_no ?? row?.targetRound ?? row?.round)
    const strategyVersion = row?.strategy_version ?? row?.strategyVersion
    const finalDirection = row?.final_v105_predicted_result
      ?? row?.prediction_payload?.predictedResult
      ?? row?.predictionPayload?.predictedResult
    const direction = String(strategyVersion === V105_FORMAL_STRATEGY_VERSION
      ? (finalDirection ?? row?.predicted_result ?? row?.predictedResult ?? '')
      : (row?.predicted_result ?? row?.predictedResult ?? ''))
    if (!tableId || !predictionId || !Number.isSafeInteger(round) || !['banker', 'player'].includes(direction)) continue
    const key = tableKey(tableId)
    const prior = state.get(key)
    assertForwardIssuanceIdentity(prior, { shoe, round })
    const sameShoeForward = prior?.shoe === shoe && prior?.direction === direction && round > prior.round
    const finalIssuedStreak = row?.issued_same_side_streak
      ?? row?.prediction_payload?.sameSideStreak
      ?? row?.predictionPayload?.sameSideStreak
    const persistedStreak = Number(strategyVersion === V105_FORMAL_STRATEGY_VERSION
      ? (finalIssuedStreak ?? row?.same_side_streak ?? row?.sameSideStreak)
      : (row?.same_side_streak ?? row?.sameSideStreak))
    const hasPersistedStreak = Number.isSafeInteger(persistedStreak) && persistedStreak >= 1
    const sameTarget = prior?.shoe === shoe && prior?.round === round
    if (sameTarget) {
      if (predictionIds.get(key) !== predictionId
        || prior.direction !== direction
        || (hasPersistedStreak && prior.sameSideStreak !== persistedStreak)) {
        throw new Error('v105 formal hydration found a conflicting duplicate issuance identity')
      }
      continue
    }
    const derivedStreak = sameShoeForward ? prior.sameSideStreak + 1 : 1
    const sameSideStreak = !prior
      ? (hasPersistedStreak ? persistedStreak : 1)
      : (sameShoeForward ? Math.max(hasPersistedStreak ? persistedStreak : 1, derivedStreak) : 1)
    state.set(key, { shoe, direction, sameSideStreak, round })
    predictionIds.set(key, predictionId)
    strategyVersions.set(key, strategyVersion)
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
    strategy_version: V105_FORMAL_STRATEGY_VERSION,
    prediction_timing: 'pre_result_context',
    prediction_issued_at: issued.issuedAt,
    predicted_result: issued.baselineV104PredictedResult ?? issued.predictedResult,
    final_v105_predicted_result: issued.predictedResult,
    same_side_streak: issued.baselineV104SameSideStreak ?? issued.sameSideStreak,
    issued_same_side_streak: issued.sameSideStreak,
    settlement_final: false,
    prediction_payload: structuredClone(issued),
  })
  trimHistory(rows)
}

function assertFormalIssuance(issued) {
  if (!issued?.predictionId || !issued?.issuedAt
    || issued.strategyVersion !== V105_FORMAL_STRATEGY_VERSION
    || issued.predictionTiming !== 'pre_result_context'
    || !issued.targetTableId || issued.targetShoe == null
    || !Number.isSafeInteger(Number(issued.targetRound))
    || !['banker', 'player'].includes(issued.predictedResult)) {
    throw new Error('v105 formal issuance acknowledgement failed')
  }
}

function assertForwardIssuanceIdentity(prior, { shoe, round }) {
  if (!prior) return
  if (prior.shoe === shoe) {
    if (Number.isSafeInteger(prior.round) && round < prior.round) {
      throw new Error('v105 formal issuance cannot move backward within the same shoe')
    }
    return
  }
  const candidateNumericShoe = /^\d+$/.test(String(shoe)) ? BigInt(shoe) : null
  const priorNumericShoe = /^\d+$/.test(String(prior.shoe)) ? BigInt(prior.shoe) : null
  if (candidateNumericShoe != null && priorNumericShoe != null && candidateNumericShoe <= priorNumericShoe) {
    throw new Error('v105 formal issuance cannot move to an older shoe')
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
