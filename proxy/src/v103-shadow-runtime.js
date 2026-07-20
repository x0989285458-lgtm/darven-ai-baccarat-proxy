import {
  V103_SHADOW_STRATEGY_VERSION,
  buildV103ShadowPrediction,
  buildV103ShadowSettlement,
} from './v103-shadow-strategy.js'

function identityKey({ source = 'ofalive99', tableId, shoe, round }) {
  return JSON.stringify([String(source), String(tableId ?? ''), String(shoe ?? ''), Number(round), V103_SHADOW_STRATEGY_VERSION])
}

function withTimeout(operation, timeoutMs, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    timer.unref?.()
  })
  return Promise.race([Promise.resolve(operation), timeout]).finally(() => clearTimeout(timer))
}

export function resolveV103ShadowEnabled(env = process.env) {
  return env?.V103_SHADOW_ENABLED === 'true'
}

export function createV103ShadowRuntime({ enabled = false, writer = null, maxSettledKeys = 10000, maxPendingIssuances = 10000, requestTimeoutMs = 10000 } = {}) {
  const issuances = new Map()
  const issuanceOrder = []
  const issuancePromises = new Map()
  const settledResults = new Map()
  const settledOrder = []
  const settledKeyLimit = Math.max(1, Number(maxSettledKeys) || 10000)
  const pendingIssuanceLimit = Math.max(1, Number(maxPendingIssuances) || 10000)
  const timeoutMs = Math.max(1, Number(requestTimeoutMs) || 10000)
  let historyRows = []
  let hydrationPromise = null
  let status = enabled ? 'initializing' : 'disabled'
  let error = null

  async function ensureHydrated() {
    if (!enabled) return
    if (!hydrationPromise) {
      hydrationPromise = Promise.resolve().then(async () => {
        if (!writer?.configured || typeof writer.getV103ShadowHistory !== 'function') throw new Error('v103 shadow history reader is unavailable')
        const rows = await withTimeout(writer.getV103ShadowHistory({ limit: 10000 }), timeoutMs, 'v103 shadow history hydration')
        historyRows = Array.isArray(rows) ? structuredClone(rows) : []
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

  async function observeTable(table = {}) {
    if (!enabled) return null
    await ensureHydrated()
    if (typeof writer?.issueV103ShadowPrediction !== 'function') throw new Error('v103 shadow issuance writer is unavailable')
    const candidate = buildV103ShadowPrediction(table, historyRows)
    const key = identityKey({ source: candidate.source, tableId: candidate.targetTableId, shoe: candidate.targetShoe, round: candidate.targetRound })
    if (issuances.has(key)) return structuredClone(issuances.get(key))
    if (issuancePromises.has(key)) return issuancePromises.get(key)
    const promise = Promise.resolve().then(async () => {
      const issued = await withTimeout(writer.issueV103ShadowPrediction(candidate), timeoutMs, 'v103 shadow issuance')
      assertIssuedIdentity(candidate, issued)
      const immutable = Object.freeze(structuredClone(issued))
      issuances.set(key, immutable)
      issuanceOrder.push(key)
      while (issuanceOrder.length > pendingIssuanceLimit) issuances.delete(issuanceOrder.shift())
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

  async function settleRound(round = {}) {
    if (!enabled) return null
    await ensureHydrated()
    const key = identityKey({ source: round.source ?? 'ofalive99', tableId: round.tableId, shoe: round.shoe, round: round.round })
    const cached = settledResults.get(key)
    if (cached) {
      const replay = buildV103ShadowSettlement(round, cached.issued)
      if (replay.actualResult !== cached.settlement.actualResult
        || replay.settlementStatus !== cached.settlement.settlementStatus
        || replay.settlementSourceAction !== cached.settlement.settlementSourceAction) {
        throw new Error('conflicting v103 shadow settlement')
      }
      return { ...structuredClone(cached.result), predictionId: cached.issued.predictionId, duplicate: true }
    }
    let issued = issuances.get(key)
    if (!issued && issuancePromises.has(key)) issued = await issuancePromises.get(key)
    if (!issued && typeof writer?.readV103ShadowIssuance === 'function') {
      try {
        issued = await withTimeout(writer.readV103ShadowIssuance({ source: round.source ?? 'ofalive99', tableId: round.tableId, shoe: round.shoe, round: round.round }), timeoutMs, 'v103 shadow issuance read')
      } catch (cause) {
        status = 'error'
        error = cause?.message ?? String(cause)
        throw cause
      }
      if (issued) {
        assertIssuedIdentity({ source: round.source ?? 'ofalive99', targetTableId: round.tableId, targetShoe: round.shoe, targetRound: round.round, strategyVersion: V103_SHADOW_STRATEGY_VERSION }, issued)
        issuances.set(key, Object.freeze(structuredClone(issued)))
      }
    }
    if (!issued) throw new Error('v103 shadow settlement has no immutable issuance')
    if (typeof writer?.settleV103ShadowPrediction !== 'function') throw new Error('v103 shadow settlement writer is unavailable')
    const settlement = buildV103ShadowSettlement(round, issued)
    let result
    try {
      result = await withTimeout(writer.settleV103ShadowPrediction(settlement), timeoutMs, 'v103 shadow settlement')
    } catch (cause) {
      status = 'error'
      error = cause?.message ?? String(cause)
      throw cause
    }
    if (String(result?.predictionId ?? result?.prediction_id ?? '') !== String(issued.predictionId)) throw new Error('v103 shadow settlement acknowledgement failed')
    issuances.delete(key)
    const issuanceIndex = issuanceOrder.indexOf(key)
    if (issuanceIndex >= 0) issuanceOrder.splice(issuanceIndex, 1)
    settledResults.set(key, {
      issued: structuredClone(issued),
      settlement: structuredClone(settlement),
      result: structuredClone(result),
    })
    settledOrder.push(key)
    while (settledOrder.length > settledKeyLimit) settledResults.delete(settledOrder.shift())
    if (!historyRows.some((row) => String(row.prediction_id ?? row.predictionId ?? '') === String(issued.predictionId))) {
      historyRows.push({
        prediction_id: issued.predictionId,
        source: issued.source,
        table_id: issued.targetTableId,
        shoe_no: issued.targetShoe,
        round_no: issued.targetRound,
        strategy_version: V103_SHADOW_STRATEGY_VERSION,
        prediction_timing: 'pre_result_context',
        prediction_issued_at: issued.issuedAt,
        settlement_final: true,
        predicted_result: issued.predictedResult,
        actual_result: settlement.actualResult,
        settlement_status: settlement.settlementStatus,
        resolved_at: settlement.resolvedAt,
      })
      while (historyRows.length > 10000) historyRows.shift()
    }
    status = 'ready'
    error = null
    return { ...result, predictionId: issued.predictionId }
  }

  return {
    enabled: Boolean(enabled),
    start: ensureHydrated,
    observeTable,
    settleRound,
    snapshot() {
      return {
        strategyVersion: V103_SHADOW_STRATEGY_VERSION,
        status,
        error,
        historySource: 'v103_shadow_final_only',
        historyRows: historyRows.length,
        pendingIssuances: issuances.size,
        activationEligible: false,
        memberVisible: false,
        writesSideActions: false,
      }
    },
  }
}

function assertIssuedIdentity(candidate, issued) {
  if (!issued?.predictionId || !issued?.issuedAt
    || String(issued.source ?? '') !== String(candidate.source ?? '')
    || String(issued.targetTableId ?? '') !== String(candidate.targetTableId ?? '')
    || String(issued.targetShoe ?? '') !== String(candidate.targetShoe ?? '')
    || Number(issued.targetRound) !== Number(candidate.targetRound)
    || issued.strategyVersion !== V103_SHADOW_STRATEGY_VERSION
    || issued.predictionTiming !== 'pre_result_context') {
    throw new Error('v103 shadow issuance acknowledgement failed')
  }
}
