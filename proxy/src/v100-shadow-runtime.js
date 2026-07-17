import {
  buildLivePrediction,
  calculateV99MainPredictionShadow,
  calculateV100SidePredictionShadow,
} from './supabase-writer.js'

function identityKey(source, tableId, shoe) {
  return JSON.stringify([String(source ?? ''), String(tableId ?? ''), String(shoe ?? '')])
}

export function resolveV100ShadowEnabled(env = process.env) {
  return env?.V100_SHADOW_ENABLED === 'true'
}

export function createV100ShadowRuntime({ enabled = false, writer = null, source = 'ofalive99' } = {}) {
  const ledgers = new Map()
  const loaded = new Set()
  const latest = new Map()

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

  async function applyRounds(rounds = []) {
    const ordered = [...rounds].sort((left, right) => {
      const leftIdentity = identityKey(left.source ?? source, left.tableId, left.shoe)
      const rightIdentity = identityKey(right.source ?? source, right.tableId, right.shoe)
      return leftIdentity.localeCompare(rightIdentity) || Number(left.round) - Number(right.round)
    })
    for (const round of ordered) {
      const event = { ...round, source: round.source ?? source }
      const ledger = await writer.applyV100RankLedgerEvent(event)
      const key = identityKey(event.source, event.tableId, event.shoe)
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
    const v100RankLedger = durable ? { ...structuredClone(durable), rankDataAvailable, targetRound } : null
    const candidateTable = v100RankLedger ? { ...structuredClone(table), v100RankLedger } : structuredClone(table)
    const roundContext = { round: targetRound, v100RankLedger }
    const main = calculateV99MainPredictionShadow({ round: roundContext, table: candidateTable })
    const calculatedSide = calculateV100SidePredictionShadow({
      round: roundContext,
      table: candidateTable,
      rankAvailable: rankDataAvailable,
      rankFallback: 'renormalize',
      mainPrediction: main.predictedResult,
      v98SidePredictions: formal.sidePredictions,
    })
    const hypotheticalActions = structuredClone(calculatedSide.actions)
    const side = {
      ...calculatedSide,
      hypotheticalActions,
      actions: Object.fromEntries(Object.keys(hypotheticalActions).map((key) => [key, false])),
    }
    const shadow = {
      targetTableId: String(formal.targetTableId ?? table.tableId ?? ''),
      targetShoe: String(formal.targetShoe ?? table.shoe ?? ''),
      targetRound,
      rankDataAvailable,
      activationEligible: false,
      activationBlockReason: 'prospective_shadow_validation_required',
      main,
      side,
    }
    latest.set(identityKey(source, shadow.targetTableId, shadow.targetShoe), structuredClone(shadow))
    return shadow
  }

  return {
    enabled: Boolean(enabled),
    async processSnapshot({ tables = [], rounds = [] } = {}) {
      if (!enabled) return { enabled: false, shadows: [] }
      if (!writer?.configured || typeof writer.readV100RankLedger !== 'function' || typeof writer.applyV100RankLedgerEvent !== 'function') {
        throw new Error('v100 shadow requires a configured durable writer')
      }
      for (const table of tables) await hydrateTable(table)
      await applyRounds(rounds)
      const shadows = tables.map(scoreTable).filter(Boolean)
      return { enabled: true, shadows }
    },
    snapshot() {
      return { enabled: Boolean(enabled), shadows: [...latest.values()].map((value) => structuredClone(value)) }
    },
  }
}
