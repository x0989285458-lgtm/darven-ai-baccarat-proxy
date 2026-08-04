import {
  buildLivePrediction,
  calculateV100MainPrediction,
  calculateV100SidePrediction,
} from './supabase-writer.js'

function identityKey(source, tableId, shoe) {
  return JSON.stringify([String(source ?? ''), String(tableId ?? ''), String(shoe ?? '')])
}

const MAX_FORMAL_IDENTITY_CONCURRENCY = 1
const yieldToServiceRequests = () => new Promise((resolve) => setImmediate(resolve))

async function settleWithConcurrency(items, task, concurrency = MAX_FORMAL_IDENTITY_CONCURRENCY) {
  const results = new Array(items.length)
  let nextIndex = 0
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      try {
        results[index] = { status: 'fulfilled', value: await task(items[index], index) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
      await yieldToServiceRequests()
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()))
  return results
}

function createConcurrencyPermit(limit) {
  let active = 0
  const waiters = []
  const acquire = () => {
    if (active < limit) {
      active += 1
      return Promise.resolve()
    }
    return new Promise((resolve) => waiters.push(resolve))
  }
  const release = () => {
    const next = waiters.shift()
    if (next) next()
    else active -= 1
  }
  return async (task) => {
    await acquire()
    try {
      return await task()
    } finally {
      release()
    }
  }
}

export function resolveV100FormalEnabled(env = process.env) {
  return env?.V100_RELEASE_ENABLED === 'true'
}

export function createV100FormalRuntime({ enabled = false, writer = null, source = 'ofalive99' } = {}) {
  const ledgers = new Map()
  const loaded = new Set()
  const latest = new Map()
  const identityTails = new Map()
  const withIdentityPermit = createConcurrencyPermit(MAX_FORMAL_IDENTITY_CONCURRENCY)
  let processTail = Promise.resolve()

  function withProcessTail(task) {
    const current = processTail.catch(() => {}).then(task)
    processTail = current
    return current
  }

  function withIdentityTail(key, task) {
    const previous = identityTails.get(key) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(task)
    identityTails.set(key, current)
    return current.finally(() => {
      if (identityTails.get(key) === current) identityTails.delete(key)
    })
  }

  async function hydrateTable(table = {}) {
    const tableId = String(table.tableId ?? '')
    const shoe = String(table.shoe ?? '')
    if (!tableId || !shoe) return
    const key = identityKey(source, tableId, shoe)
    if (loaded.has(key)) return
    const ledger = await writer.readV100RankLedger({ source, tableId, shoe })
    if (ledger) ledgers.set(key, structuredClone(ledger))
    if (ledger && ledger.status !== 'gap') loaded.add(key)
  }

  async function hydrateTables(tables = []) {
    if (typeof writer?.readV100RankLedgers !== 'function') return
    const identities = []
    const requestedKeys = new Set()
    for (const table of tables) {
      const tableId = String(table?.tableId ?? '')
      const shoe = String(table?.shoe ?? '')
      if (!tableId || !shoe) continue
      const key = identityKey(source, tableId, shoe)
      if (loaded.has(key) || requestedKeys.has(key)) continue
      requestedKeys.add(key)
      identities.push({ source, tableId, shoe })
    }
    if (identities.length === 0) return
    const rows = await writer.readV100RankLedgers(identities)
    for (const row of Array.isArray(rows) ? rows : []) {
      const rowSource = String(row?.identity?.source ?? row?.source ?? '')
      const tableId = String(row?.identity?.table_id ?? row?.identity?.tableId ?? row?.table_id ?? row?.tableId ?? '')
      const shoe = String(row?.identity?.shoe ?? row?.shoe_no ?? row?.shoe ?? '')
      const key = identityKey(rowSource, tableId, shoe)
      if (!requestedKeys.has(key)) throw new Error('v100 durable rank ledger batch returned an unexpected identity')
      ledgers.set(key, structuredClone(row))
      if (row && row.status !== 'gap') loaded.add(key)
    }
  }

  async function applyIdentityRounds(key, events = []) {
    events.sort((left, right) => Number(left.round) - Number(right.round))
    for (const event of events) {
      const currentLedger = ledgers.get(key)
      const durableCompleteThrough = Number(currentLedger?.completeThroughRound ?? currentLedger?.complete_through_round)
      const canSkipVerifiedFinal = currentLedger?.status === 'contiguous'
        && currentLedger?.rankDataAvailable === true
        && Number.isSafeInteger(durableCompleteThrough)
        && durableCompleteThrough >= Number(event.round)
      if (canSkipVerifiedFinal) continue
      const ledger = await writer.applyV100RankLedgerEvent(event)
      ledgers.set(key, structuredClone(ledger))
      if (ledger && ledger.status !== 'gap') loaded.add(key)
      else {
        loaded.delete(key)
        if (typeof writer?.readV100RankLedgers === 'function') {
          await hydrateTables([{ tableId: event.tableId, shoe: event.shoe }])
        }
      }
    }
  }

  function scoreTable(table = {}) {
    const formal = buildLivePrediction(table)
    if (!formal) return null
    const key = identityKey(source, table.tableId, table.shoe)
    const durable = ledgers.get(key) ?? null
    const completeThrough = Number(durable?.completeThroughRound ?? durable?.complete_through_round)
    const targetRound = Number(formal.targetRound)
    const rankDataAvailable = durable?.status === 'contiguous'
      && durable?.rankDataAvailable === true
      && Number.isSafeInteger(targetRound)
      && completeThrough === targetRound - 1
    const v102RankLedger = durable ? { ...structuredClone(durable), rankDataAvailable, targetRound } : null
    const scoringTable = v102RankLedger ? { ...structuredClone(table), v102RankLedger } : structuredClone(table)
    const roundContext = { round: targetRound, v102RankLedger }
    const main = calculateV100MainPrediction({ round: roundContext, table: scoringTable })
    const calculatedSide = calculateV100SidePrediction({
      round: roundContext,
      table: scoringTable,
      rankAvailable: rankDataAvailable,
      rankFallback: 'renormalize',
      mainPrediction: main.predictedResult,
      baseSidePredictions: formal.sidePredictions,
    })
    const side = {
      ...calculatedSide,
      actions: structuredClone(calculatedSide.actions),
    }
    const prediction = {
      targetTableId: String(formal.targetTableId ?? table.tableId ?? ''),
      targetShoe: String(formal.targetShoe ?? table.shoe ?? ''),
      targetRound,
      rankDataAvailable,
      activationEligible: rankDataAvailable,
      activationBlockReason: rankDataAvailable ? null : 'rank_ledger_unavailable',
      v102RankLedger,
      main,
      side,
    }
    latest.set(identityKey(source, prediction.targetTableId, prediction.targetShoe), structuredClone(prediction))
    return prediction
  }

  return {
    enabled: Boolean(enabled),
    async processSnapshot({ tables = [], rounds = [] } = {}) {
      if (!enabled) return { enabled: false, predictions: [] }
      return withProcessTail(async () => {
        if (!writer?.configured || typeof writer.readV100RankLedger !== 'function' || typeof writer.applyV100RankLedgerEvent !== 'function') {
          throw new Error('v102 formal runtime requires a configured durable writer')
        }

        const workByIdentity = new Map()
        const workFor = (key) => {
          if (!workByIdentity.has(key)) workByIdentity.set(key, { tables: [], events: [] })
          return workByIdentity.get(key)
        }
        for (const table of tables) {
          workFor(identityKey(source, table.tableId, table.shoe)).tables.push(table)
        }
        for (const round of rounds) {
          const event = { ...round, source: round.source ?? source }
          workFor(identityKey(event.source, event.tableId, event.shoe)).events.push(event)
        }

        const hasBatchHydration = typeof writer.readV100RankLedgers === 'function'
        if (hasBatchHydration) await withIdentityPermit(() => hydrateTables(tables))

        const results = await settleWithConcurrency([...workByIdentity.entries()], ([key, work]) => (
          withIdentityTail(key, () => withIdentityPermit(async () => {
            if (!hasBatchHydration) for (const table of work.tables) await hydrateTable(table)
            await applyIdentityRounds(key, work.events)
            return work.tables.map(scoreTable).filter(Boolean)
          }))
        ))
        const failure = results.find((result) => result.status === 'rejected')
        if (failure) throw failure.reason

        const predictions = results.flatMap((result) => result.value)
        const predictionByIdentity = new Map(predictions.map((prediction) => [
          identityKey(source, prediction.targetTableId, prediction.targetShoe),
          prediction,
        ]))
        const formalTables = tables.map((table) => {
          const prediction = predictionByIdentity.get(identityKey(source, table.tableId, table.shoe))
          return prediction?.v102RankLedger
            ? { ...structuredClone(table), v102RankLedger: structuredClone(prediction.v102RankLedger) }
            : structuredClone(table)
        })
        return { enabled: true, predictions, tables: formalTables }
      })
    },
    snapshot() {
      return { enabled: Boolean(enabled), predictions: [...latest.values()].map((value) => structuredClone(value)) }
    },
  }
}
