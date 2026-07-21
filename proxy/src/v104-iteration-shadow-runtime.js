import {
  SHADOW_HEAD_LABELS,
  V104_ITERATION_SHADOW_VERSION,
  buildV104IterationShadowPrediction,
  buildV104IterationShadowSettlement,
} from './v104-iteration-shadow-contract.js'
import { buildCycleReports, buildWeightSuggestions } from './v104-iteration-shadow-report.js'
import { renderShadowReportSvg } from './v104-iteration-shadow-svg.js'

function identityKey({ source = 'ofalive99', tableId, shoe, round }) {
  return JSON.stringify([String(source), String(tableId ?? ''), String(shoe ?? ''), Number(round), V104_ITERATION_SHADOW_VERSION])
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

export function resolveV104IterationShadowEnabled(env = process.env) {
  return env?.V104_ITERATION_SHADOW_ENABLED === 'true'
}

export function createV104IterationShadowRuntime({ enabled = false, writer = null, maxSettledKeys = 10000, maxPendingIssuances = 10000, requestTimeoutMs = 10000, artifactRetryBaseMs = 1000 } = {}) {
  const issuances = new Map()
  const issuanceOrder = []
  const issuancePromises = new Map()
  const settlementPromises = new Map()
  const issuanceStreaks = new Map()
  const tableObservationQueues = new Map()
  const settledResults = new Map()
  const settledOrder = []
  const artifactRetryTimers = new Map()
  const settledKeyLimit = positiveLimit(maxSettledKeys)
  const pendingIssuanceLimit = positiveLimit(maxPendingIssuances)
  const timeoutMs = positiveLimit(requestTimeoutMs)
  const artifactRetryMs = positiveLimit(artifactRetryBaseMs)
  let historyRows = []
  let hydrationPromise = null
  let status = enabled ? 'initializing' : 'disabled'
  let error = null

  async function ensureHydrated() {
    if (!enabled) return
    if (!hydrationPromise) {
      hydrationPromise = Promise.resolve().then(async () => {
        if (!writer?.configured || typeof writer.getV104IterationShadowHistory !== 'function') throw new Error('v104 iteration shadow history reader is unavailable')
        const rows = await withTimeout(writer.getV104IterationShadowHistory({ limit: 10000 }), timeoutMs, 'v104 iteration shadow history hydration')
        historyRows = Array.isArray(rows) ? structuredClone(rows) : []
        hydrateIssuanceStreaks(historyRows, issuanceStreaks)
        hydratePendingIssuances(historyRows, issuances, issuanceOrder, pendingIssuanceLimit)
        await recoverCompletedArtifacts()
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
    if (typeof writer?.issueV104IterationShadowPrediction !== 'function') throw new Error('v104 iteration shadow issuance writer is unavailable')
    const streakKey = tableKey({ source: 'ofalive99', tableId: table.tableId })
    const prior = issuanceStreaks.get(streakKey)
    const candidate = buildV104IterationShadowPrediction(table, historyRows, {
      priorShoe: prior?.shoe,
      priorDirection: prior?.direction,
      priorSameSideStreak: prior?.sameSideStreak,
    })
    const key = identityKey({ source: candidate.source, tableId: candidate.targetTableId, shoe: candidate.targetShoe, round: candidate.targetRound })
    if (issuances.has(key)) return structuredClone(issuances.get(key))
    if (issuancePromises.has(key)) return issuancePromises.get(key)
    const promise = Promise.resolve().then(async () => {
      const issued = await withTimeout(writer.issueV104IterationShadowPrediction(candidate), timeoutMs, 'v104 iteration shadow issuance')
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

  async function recoverCompletedArtifacts() {
    if (typeof writer?.getV104IterationShadowCounters !== 'function'
        || typeof writer?.getV104IterationShadowCycleReports !== 'function'
        || typeof writer?.getV104IterationShadowSuggestions !== 'function'
        || typeof writer?.persistV104IterationShadowArtifacts !== 'function'
        || typeof writer?.getV104IterationShadowSettledRange !== 'function'
        || typeof writer?.getV104IterationShadowHeadActionRange !== 'function') return
    const [counters, reportRows, suggestionRows] = await Promise.all([
      withTimeout(writer.getV104IterationShadowCounters(), timeoutMs, 'v104 iteration shadow recovery counters'),
      withTimeout(writer.getV104IterationShadowCycleReports({ limit: 50000 }), timeoutMs, 'v104 iteration shadow recovery reports'),
      withTimeout(writer.getV104IterationShadowSuggestions({ limit: 50000 }), timeoutMs, 'v104 iteration shadow recovery suggestions'),
    ])
    const existingReports = new Set((Array.isArray(reportRows) ? reportRows : []).map((row) => Number(row?.cycle_number)))
    const existingSuggestions = new Set((Array.isArray(suggestionRows) ? suggestionRows : []).map((row) => `${row?.head_key}:${Number(row?.action_cycle)}`))
    const counterKeys = {
      main: 'main_action_count', tie: 'tie_action_count', superSix: 'super_six_action_count',
      bankerDragon: 'banker_dragon_action_count', playerDragon: 'player_dragon_action_count',
      bankerPair: 'banker_pair_action_count', playerPair: 'player_pair_action_count',
    }
    const rowActionKeys = {
      main: 'main_action_sequence', tie: 'tie_action_sequence', superSix: 'super_six_action_sequence',
      bankerDragon: 'banker_dragon_action_sequence', playerDragon: 'player_dragon_action_sequence',
      bankerPair: 'banker_pair_action_sequence', playerPair: 'player_pair_action_sequence',
    }
    const settlementCount = Number(counters?.settlement_count ?? 0)
    for (let cycle = 1; cycle <= Math.floor(settlementCount / 1000); cycle += 1) {
      if (existingReports.has(cycle)) continue
      const rows = await withTimeout(writer.getV104IterationShadowSettledRange({ startSequence: (cycle - 1) * 1000 + 1, endSequence: cycle * 1000 }), timeoutMs, `v104 iteration shadow recover cycle ${cycle}`)
      const report = buildCycleReports(rows).find((item) => item.cycleNumber === cycle)
      if (!report) throw new Error(`v104 iteration shadow cycle ${cycle} recovery failed`)
      const reportSuggestions = []
      for (const [headKey, rowKey] of Object.entries(rowActionKeys)) {
        const actionCycles = new Set((Array.isArray(rows) ? rows : [])
          .map((row) => Number(row?.[rowKey]))
          .filter((sequence) => Number.isSafeInteger(sequence) && sequence > 0 && sequence % 1000 === 0)
          .map((sequence) => sequence / 1000))
        for (const actionCycle of actionCycles) {
          const actionRows = await withTimeout(writer.getV104IterationShadowHeadActionRange({ headKey, startAction: (actionCycle - 1) * 1000 + 1, endAction: actionCycle * 1000 }), timeoutMs, `v104 iteration shadow recover ${headKey} cycle ${actionCycle}`)
          const suggestion = buildWeightSuggestions(actionRows).find((item) => item.headKey === headKey && item.actionCycle === actionCycle)
          if (!suggestion) throw new Error(`v104 iteration shadow ${headKey} suggestion ${actionCycle} recovery failed`)
          reportSuggestions.push(suggestion)
          existingSuggestions.add(`${headKey}:${actionCycle}`)
        }
      }
      await withTimeout(writer.persistV104IterationShadowArtifacts({ report, reportSvg: renderShadowReportSvg(report, reportSuggestions), suggestions: reportSuggestions }), timeoutMs, `v104 iteration shadow recover cycle ${cycle} persistence`)
      existingReports.add(cycle)
    }
    for (const [headKey, counterKey] of Object.entries(counterKeys)) {
      const actionCount = Number(counters?.[counterKey] ?? 0)
      for (let cycle = 1; cycle <= Math.floor(actionCount / 1000); cycle += 1) {
        if (existingSuggestions.has(`${headKey}:${cycle}`)) continue
        const rows = await withTimeout(writer.getV104IterationShadowHeadActionRange({ headKey, startAction: (cycle - 1) * 1000 + 1, endAction: cycle * 1000 }), timeoutMs, `v104 iteration shadow recover ${headKey} cycle ${cycle}`)
        const suggestion = buildWeightSuggestions(rows).find((item) => item.headKey === headKey && item.actionCycle === cycle)
        if (!suggestion) throw new Error(`v104 iteration shadow ${headKey} suggestion ${cycle} recovery failed`)
        await withTimeout(writer.persistV104IterationShadowArtifacts({ report: null, reportSvg: null, suggestions: [suggestion] }), timeoutMs, `v104 iteration shadow recover ${headKey} suggestion ${cycle} persistence`)
      }
    }
  }

  function scheduleArtifactRetry(acknowledgement, attempt = 1) {
    const key = JSON.stringify([acknowledgement?.settlement_sequence, acknowledgement?.action_sequences])
    if (artifactRetryTimers.has(key)) return
    const delay = Math.min(60000, artifactRetryMs * (2 ** Math.min(attempt - 1, 6)))
    const timer = setTimeout(() => {
      artifactRetryTimers.delete(key)
      void persistCompletedArtifacts(acknowledgement).then(() => {
        status = 'ready'; error = null
      }).catch((cause) => {
        status = 'error'; error = cause?.message ?? String(cause)
        scheduleArtifactRetry(acknowledgement, attempt + 1)
      })
    }, delay)
    timer.unref?.()
    artifactRetryTimers.set(key, timer)
  }

  async function persistCompletedArtifacts(acknowledgement) {
    if (typeof writer?.persistV104IterationShadowArtifacts !== 'function'
        || typeof writer?.getV104IterationShadowSettledRange !== 'function'
        || typeof writer?.getV104IterationShadowHeadActionRange !== 'function') return
    const settlementSequence = Number(acknowledgement?.settlement_sequence)
    const actionSequences = acknowledgement?.action_sequences ?? {}
    let report = null
    const suggestions = []
    if (Number.isSafeInteger(settlementSequence) && settlementSequence > 0 && settlementSequence % 1000 === 0) {
      const rows = await withTimeout(writer.getV104IterationShadowSettledRange({
        startSequence: settlementSequence - 999, endSequence: settlementSequence,
      }), timeoutMs, 'v104 iteration shadow cycle range')
      report = buildCycleReports(rows).find((item) => item.cycleNumber === settlementSequence / 1000) ?? null
      if (!report) throw new Error('v104 iteration shadow completed cycle cannot be reconstructed')
    }
    const counters = {
      main: 'main_action_count', tie: 'tie_action_count', superSix: 'super_six_action_count',
      bankerDragon: 'banker_dragon_action_count', playerDragon: 'player_dragon_action_count',
      bankerPair: 'banker_pair_action_count', playerPair: 'player_pair_action_count',
    }
    for (const [headKey, counterKey] of Object.entries(counters)) {
      const count = Number(actionSequences[counterKey])
      if (!Number.isSafeInteger(count) || count < 1000 || count % 1000 !== 0) continue
      const rows = await withTimeout(writer.getV104IterationShadowHeadActionRange({
        headKey, startAction: count - 999, endAction: count,
      }), timeoutMs, `v104 iteration shadow ${headKey} action range`)
      const suggestion = buildWeightSuggestions(rows).find((item) => item.headKey === headKey && item.actionCycle === count / 1000)
      if (!suggestion) throw new Error(`v104 iteration shadow ${headKey} suggestion cannot be reconstructed`)
      suggestions.push(suggestion)
    }
    if (!report && suggestions.length === 0) return
    let artifactSuggestions = suggestions
    if (report && typeof writer?.getV104IterationShadowSuggestions === 'function') {
      const durableSuggestions = await withTimeout(writer.getV104IterationShadowSuggestions({ limit: 50000 }), timeoutMs, 'v104 iteration shadow pending suggestions')
      artifactSuggestions = mergePendingSuggestions(durableSuggestions, suggestions)
    }
    const reportSvg = report ? renderShadowReportSvg(report, artifactSuggestions) : null
    await withTimeout(writer.persistV104IterationShadowArtifacts({ report, reportSvg, suggestions: artifactSuggestions }), timeoutMs, 'v104 iteration shadow artifact persistence')
  }

  function settleRound(round = {}) {
    if (!enabled) return Promise.resolve(null)
    const key = identityKey({ source: round.source ?? 'ofalive99', tableId: round.tableId, shoe: round.shoe, round: round.round })
    if (settlementPromises.has(key)) return settlementPromises.get(key)
    const promise = Promise.resolve().then(() => settleRoundNow(round)).finally(() => settlementPromises.delete(key))
    settlementPromises.set(key, promise)
    return promise
  }

  async function settleRoundNow(round = {}) {
    if (!enabled) return null
    await ensureHydrated()
    const key = identityKey({ source: round.source ?? 'ofalive99', tableId: round.tableId, shoe: round.shoe, round: round.round })
    const cached = settledResults.get(key)
    if (cached) {
      const replay = buildV104IterationShadowSettlement(round, cached.issued)
      if (replay.actualResult !== cached.settlement.actualResult
        || replay.settlementStatus !== cached.settlement.settlementStatus
        || replay.settlementSourceAction !== cached.settlement.settlementSourceAction) throw new Error('conflicting v104 iteration shadow settlement')
      return { ...structuredClone(cached.result), predictionId: cached.issued.predictionId, duplicate: true }
    }
    let issued = issuances.get(key)
    if (!issued && issuancePromises.has(key)) issued = await issuancePromises.get(key)
    if (!issued && typeof writer?.readV104IterationShadowIssuance === 'function') {
      issued = await withTimeout(writer.readV104IterationShadowIssuance({ source: round.source ?? 'ofalive99', tableId: round.tableId, shoe: round.shoe, round: round.round }), timeoutMs, 'v104 iteration shadow issuance read')
      if (issued) {
        assertIssuedIdentity({ source: round.source ?? 'ofalive99', targetTableId: round.tableId, targetShoe: round.shoe, targetRound: round.round }, issued)
        issuances.set(key, Object.freeze(structuredClone(issued)))
      }
    }
    if (!issued) throw new Error('v104 iteration shadow settlement has no immutable issuance')
    if (typeof writer?.settleV104IterationShadowPrediction !== 'function') throw new Error('v104 iteration shadow settlement writer is unavailable')
    const settlement = buildV104IterationShadowSettlement(round, issued)
    let result
    try {
      result = await withTimeout(writer.settleV104IterationShadowPrediction(settlement), timeoutMs, 'v104 iteration shadow settlement')
    } catch (cause) {
      status = 'error'
      error = cause?.message ?? String(cause)
      throw cause
    }
    if (String(result?.predictionId ?? result?.prediction_id ?? '') !== String(issued.predictionId)) throw new Error('v104 iteration shadow settlement acknowledgement failed')
    try {
      await persistCompletedArtifacts(result)
    } catch (cause) {
      status = 'error'
      error = cause?.message ?? String(cause)
      scheduleArtifactRetry(result)
      throw cause
    }
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
        strategyVersion: V104_ITERATION_SHADOW_VERSION,
        status, error,
        historySource: 'v104_iteration_shadow_issuance_and_final',
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
  const ordered = rows.filter((row) => (row?.strategy_version ?? row?.strategyVersion) === V104_ITERATION_SHADOW_VERSION
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
    strategy_version: V104_ITERATION_SHADOW_VERSION, prediction_timing: 'pre_result_context',
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
    || issued.strategyVersion !== V104_ITERATION_SHADOW_VERSION
    || issued.predictionTiming !== 'pre_result_context') throw new Error('v104 iteration shadow issuance acknowledgement failed')
}

function rowTime(row) {
  return Date.parse(row?.prediction_issued_at ?? row?.predictionIssuedAt ?? '') || 0
}

function normalizeDurableSuggestion(row = {}) {
  const headKey = row.headKey ?? row.head_key
  const actionCycle = Number(row.actionCycle ?? row.action_cycle)
  return {
    ...structuredClone(row),
    id: row.id ?? row.suggestion_id ?? `${V104_ITERATION_SHADOW_VERSION}:${headKey}:${actionCycle}`,
    headKey,
    headLabel: row.headLabel ?? SHADOW_HEAD_LABELS[headKey] ?? headKey,
    actionCycle,
    sampleStartAction: Number(row.sampleStartAction ?? row.sample_start_action),
    sampleEndAction: Number(row.sampleEndAction ?? row.sample_end_action),
    modelVersion: row.modelVersion ?? row.model_version ?? V104_ITERATION_SHADOW_VERSION,
    searchMethod: row.searchMethod ?? row.search_method,
    currentWeights: structuredClone(row.currentWeights ?? row.current_weights ?? {}),
    suggestedWeights: structuredClone(row.suggestedWeights ?? row.suggested_weights ?? {}),
    baselineMetrics: structuredClone(row.baselineMetrics ?? row.baseline_metrics ?? {}),
    candidateMetrics: structuredClone(row.candidateMetrics ?? row.candidate_metrics ?? {}),
    autoApply: row.autoApply ?? row.auto_apply ?? false,
  }
}

function mergePendingSuggestions(durableRows, generatedRows) {
  const merged = new Map()
  for (const raw of Array.isArray(durableRows) ? durableRows : []) {
    const item = normalizeDurableSuggestion(raw)
    if (item.status === 'pending') merged.set(item.id, item)
  }
  for (const raw of Array.isArray(generatedRows) ? generatedRows : []) {
    const item = normalizeDurableSuggestion(raw)
    merged.set(item.id, item)
  }
  return [...merged.values()].sort((left, right) => left.actionCycle - right.actionCycle || String(left.headKey).localeCompare(String(right.headKey)))
}

function positiveLimit(value) {
  return Math.max(1, Number(value) || 10000)
}
