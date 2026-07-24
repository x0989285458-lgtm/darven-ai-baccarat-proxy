import {
  buildLivePrediction,
  calculateV100MainPrediction,
  calculateV100SidePrediction,
} from './supabase-writer.js'

function identityKey(source, tableId, shoe) {
  return JSON.stringify([String(source ?? ''), String(tableId ?? ''), String(shoe ?? '')])
}

export function resolveV100FormalEnabled(env = process.env) {
  return env?.V100_RELEASE_ENABLED === 'true'
}

export function createV100FormalRuntime({ enabled = false, writer = null, source = 'ofalive99' } = {}) {
  const ledgers = new Map()
  const loaded = new Set()
  const latest = new Map()
  const identityTails = new Map()

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
    loaded.add(key)
    if (ledger) ledgers.set(key, structuredClone(ledger))
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
      loaded.add(key)
      ledgers.set(key, structuredClone(ledger))
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

      const results = await Promise.allSettled([...workByIdentity.entries()].map(([key, work]) => (
        withIdentityTail(key, async () => {
          for (const table of work.tables) await hydrateTable(table)
          await applyIdentityRounds(key, work.events)
          return work.tables.map(scoreTable).filter(Boolean)
        })
      )))
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
    },
    snapshot() {
      return { enabled: Boolean(enabled), predictions: [...latest.values()].map((value) => structuredClone(value)) }
    },
  }
}
