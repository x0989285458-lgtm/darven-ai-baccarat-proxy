import { canonicalProductionTableId, PRODUCTION_TABLE_IDS, sortProductionTables } from './table-policy.js'
import { updateSourceProgressTracker } from './worker-health.js'

export function createWorkerSourceRuntime({
  sourceOwner,
  journal,
  gapDetector,
  replayProvider,
  createApiClient,
  startBrowser = async () => {},
  now = () => new Date().toISOString(),
  leaseRenewalMs = 5_000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  allowFreshBaseline = false,
  allowGapDelivery = false,
  freshBaselineWarmupMs = 0,
  clockMs = Date.now,
  signalFinalReady = () => {},
} = {}) {
  if (!sourceOwner || !journal || !gapDetector || !replayProvider || typeof createApiClient !== 'function') {
    throw new Error('worker_source_runtime_dependencies_required')
  }
  let lease = null
  let apiClient = null
  let tables = []
  let gaps = []
  let started = false
  let lastReplayGate = null
  const bypassedGaps = []
  const crossShoeCoverage = new Set()
  let leaseTimer = null
  let leaseRenewTail = Promise.resolve()
  let leaseRenewalError = null
  let sourceProgressTracker = null
  const freshBaselineTables = new Set(allowFreshBaseline ? PRODUCTION_TABLE_IDS : [])
  let freshBaselineReadyAt = null
  void startBrowser

  async function start() {
    if (started) return
    lease = typeof sourceOwner.acquireOrRecover === 'function'
      ? await sourceOwner.acquireOrRecover()
      : await sourceOwner.acquire()
    leaseRenewalError = null
    leaseRenewTail = Promise.resolve()
    leaseTimer = setIntervalFn(() => {
      leaseRenewTail = leaseRenewTail.then(async () => {
        if (leaseRenewalError) return
        try {
          lease = await sourceOwner.renew(sourceOwner.lease?.() ?? lease)
        } catch (error) {
          leaseRenewalError = error
          apiClient?.stop?.()
          lastReplayGate = 'source_lease_renewal_failed'
          started = false
        }
      })
      return leaseRenewTail
    }, Math.max(1, Number(leaseRenewalMs) || 1))
    leaseTimer?.unref?.()
    try {
      if (typeof journal.rebindPending === 'function') {
        await journal.rebindPending(
          () => sourceOwner.nextEventSource(sourceOwner.lease?.() ?? lease),
          { mode: lease.mode, ownerId: lease.ownerId, epoch: lease.epoch, fence: lease.fence },
        )
        lease = sourceOwner.lease?.() ?? lease
      }
      if (leaseRenewalError) throw leaseRenewalError
      apiClient = createApiClient({ onFinal, onTables })
      await apiClient.start()
      await leaseRenewTail
      if (leaseRenewalError) throw leaseRenewalError
      started = true
    } catch (error) {
      if (leaseTimer) clearIntervalFn(leaseTimer)
      leaseTimer = null
      await leaseRenewTail
      apiClient?.stop?.()
      const current = sourceOwner.lease?.()
      if (current) {
        try { await sourceOwner.stop(current) } catch {}
      }
      apiClient = null
      started = false
      throw error
    }
  }

  async function stop() {
    if (leaseTimer) clearIntervalFn(leaseTimer)
    leaseTimer = null
    await leaseRenewTail
    apiClient?.stop?.()
    const current = sourceOwner.lease?.()
    if (current) await sourceOwner.stop(current)
    apiClient = null
    started = false
  }

  async function onFinal(event) {
    const tableId = canonicalProductionTableId(event?.tableId ?? event?.table_id)
    const initialCursor = journal.cursor(tableId)
    const identity = `${tableId}:${Number(event?.shoe)}:${Number(event?.round)}`
    if (initialCursor?.origin === 'snapshot-pusher-exact-ack-cursor' && identity === initialCursor.identity) {
      const currentLease = sourceOwner.lease?.() ?? lease
      sourceOwner.assertCurrent?.(currentLease)
      const source = event?.source
      if (!source || source.mode !== currentLease?.mode || source.ownerId !== currentLease?.ownerId
        || Number(source.epoch) !== Number(currentLease?.epoch) || source.fence !== currentLease?.fence) throw new Error('stale_source_fence')
      return
    }
    if (freshBaselineTables.has(tableId) && Number(freshBaselineWarmupMs) > 0) {
      if (freshBaselineReadyAt == null) freshBaselineReadyAt = Number(clockMs()) + Math.max(0, Number(freshBaselineWarmupMs) || 0)
      if (Number(clockMs()) < freshBaselineReadyAt) {
      sourceProgressTracker = updateSourceProgressTracker(sourceProgressTracker, {
        snapshotAt: now(), tables, rounds: [event],
      })
      return
      }
    }
    const continuityGap = freshBaselineTables.has(tableId) ? null : detectLiveFinalGap(event)
    if (continuityGap) {
      if (allowGapDelivery) {
        rememberBypassedGap(continuityGap)
        gaps = []
        lastReplayGate = null
      } else {
        gaps = [continuityGap]
        lastReplayGate = 'live_final_continuity_gap'
        try {
          await resolveGaps()
        } catch (error) {
          if (leaseTimer) clearIntervalFn(leaseTimer)
          leaseTimer = null
          apiClient?.stop?.()
          started = false
          throw error
        }
        const cursor = journal.cursor(canonicalProductionTableId(event?.tableId ?? event?.table_id))
        if (cursor?.origin === 'snapshot-pusher-exact-ack-cursor'
          && (Number(event?.shoe) !== Number(cursor.shoe) || Number(event?.round) !== Number(cursor.round) + 1)) {
          lastReplayGate = 'bootstrap_cursor_ack_required'
          if (leaseTimer) clearIntervalFn(leaseTimer)
          leaseTimer = null
          apiClient?.stop?.()
          started = false
          throw new Error('live_ack_blocked:bootstrap_cursor_ack_required')
        }
      }
    }
    await journal.append(event)
    sourceProgressTracker = updateSourceProgressTracker(sourceProgressTracker, {
      snapshotAt: now(), tables, rounds: [event],
    })
    try {
      const signal = signalFinalReady({ tableId, identity })
      if (signal && typeof signal.catch === 'function') void signal.catch(() => {})
    } catch {}
  }

  function detectLiveFinalGap(event) {
    const tableId = canonicalProductionTableId(event?.tableId ?? event?.table_id)
    const cursor = journal.cursor(tableId)
    if (!cursor) {
      if (Number(event?.round) === 1) return null
      const round = Number(event?.round)
      return {
        type: 'baseline_missing', tableId, shoe: Number(event?.shoe),
        rounds: Number.isSafeInteger(round) && round > 1 ? Array.from({ length: round - 1 }, (_, index) => index + 1) : [],
      }
    }
    const shoe = Number(event?.shoe)
    const round = Number(event?.round)
    if (!Number.isSafeInteger(shoe) || !Number.isSafeInteger(round)) return {
      type: 'unknown', tableId, from: { shoe: Number(cursor.shoe), round: Number(cursor.round) },
      to: { shoe, round },
    }
    const identity = `${tableId}:${shoe}:${round}`
    const durableStatus = journal.status?.(identity)
    if (durableStatus?.acknowledged === true) return null
    if (identity === cursor.identity || (shoe === Number(cursor.shoe) && round === Number(cursor.round) + 1)) return null
    return gapDetector.detect({
      tables: [{ tableId, shoe, round }],
      cursors: new Map([[tableId, cursor]]),
    })[0] ?? {
      type: 'unknown', tableId, from: { shoe: Number(cursor.shoe), round: Number(cursor.round) },
      to: { shoe, round },
    }
  }

  async function onTables(nextTables) {
    tables = uniqueTables(sortProductionTables((Array.isArray(nextTables) ? nextTables : []).map((table) => ({
      ...table,
      tableId: canonicalProductionTableId(table?.tableId ?? table?.table_id),
    }))))
    sourceProgressTracker = updateSourceProgressTracker(sourceProgressTracker, {
      snapshotAt: now(), tables, rounds: [],
    })
    updateGaps()
  }

  async function getDeliverySnapshot() {
    await resolveGaps()
    const pending = journal.pending()
    const deliverable = gaps.length === 0 ? pending : selectGapPending(pending, gaps)
    if (gaps.length > 0 && deliverable.length === 0) throw new Error(`live_ack_blocked:${lastReplayGate ?? 'replay_incomplete'}`)
    const source = currentSource()
    const apiState = apiClient?.snapshot?.() ?? {}
    return {
      buildVersion: '105',
      sessionId: `worker-${source.ownerId}-${source.epoch}`,
      connected: apiState.connected === true,
      authenticated: apiState.authenticated === true,
      joined: apiState.joined === true,
      lastMessageAt: apiState.lastMessageAt ?? null,
      reconnecting: apiState.reconnecting === true,
      refreshing: apiState.refreshing === true,
      source,
      snapshotAt: now(),
      sourceProgressAt: sourceProgressTracker?.sourceProgressAt ?? null,
      tableCount: tables.length,
      tables: structuredClone(tables),
      rounds: deliverable.map((entry) => structuredClone(entry.event)),
    }
  }

  async function acknowledge(receipt = {}) {
    const accepted = new Set((receipt.acceptedRoundKeys ?? []).map(String))
    for (const entry of journal.pending()) {
      if (accepted.has(entry.identity)) {
        await journal.ack(entry.identity, entry.hash)
        freshBaselineTables.delete(canonicalProductionTableId(entry.event?.tableId))
      }
    }
    updateGaps()
  }

  async function rebindDeliveryQueue(roundKeys = []) {
    const pendingByIdentity = new Map(journal.pending().map((entry) => [entry.identity, entry.event]))
    return roundKeys.map((identity) => {
      const event = pendingByIdentity.get(String(identity))
      if (!event) throw new Error('queued_source_rebind_incomplete')
      return structuredClone(event)
    })
  }

  async function resolveGaps() {
    if (gaps.length === 0) { lastReplayGate = null; return }
    if (gaps.some((gap) => gap.type === 'baseline_missing')) {
      lastReplayGate = 'journal_cursor_baseline_missing'
      throw new Error('live_ack_blocked:journal_cursor_baseline_missing')
    }
    const pending = journal.pending()
    const missing = gaps.filter((gap) => !gapCovered(gap, pending))
    for (const gap of missing) {
      const result = await replayProvider.replay(structuredClone(gap))
      if (!result?.ok) {
        lastReplayGate = result?.liveGate ?? 'authoritative_replay_unavailable'
        throw new Error(`live_ack_blocked:${lastReplayGate}`)
      }
      if (gap.type === 'cross_shoe' && !sameCrossShoeCoverage(result.coverage, gap)) {
        lastReplayGate = 'replay_incomplete'
        throw new Error('live_ack_blocked:replay_incomplete')
      }
      for (const event of result.events ?? []) {
        const source = await sourceOwner.nextEventSource(sourceOwner.lease?.())
        await journal.append({ ...event, deliveryKind: 'replay', source })
      }
      if (gap.type === 'cross_shoe') crossShoeCoverage.add(crossShoeGapKey(gap))
    }
    const after = journal.pending()
    if (gaps.some((gap) => !gapCovered(gap, after))) {
      lastReplayGate = 'replay_incomplete'
      throw new Error('live_ack_blocked:replay_incomplete')
    }
    lastReplayGate = null
  }

  function gapCovered(gap, pending) {
    if (gap.type === 'cross_shoe') return crossShoeCoverage.has(crossShoeGapKey(gap))
    if (gap.type === 'same_shoe') return gapCoveredByPending(gap, pending)
    return false
  }

  function updateGaps() {
    const cursors = new Map(tables.map((table) => [table.tableId, journal.cursor(table.tableId)]).filter(([, cursor]) => cursor))
    const detected = gapDetector.detect({ tables, cursors })
    if (allowGapDelivery) {
      for (const gap of detected) rememberBypassedGap(gap)
      gaps = []
      lastReplayGate = null
      return
    }
    gaps = detected
  }

  function rememberBypassedGap(gap) {
    const key = JSON.stringify(gap)
    if (bypassedGaps.some((candidate) => JSON.stringify(candidate) === key)) return
    bypassedGaps.push(structuredClone(gap))
    if (bypassedGaps.length > 100) bypassedGaps.shift()
  }

  function currentSource() {
    lease = sourceOwner.lease?.() ?? lease
    sourceOwner.assertCurrent(lease)
    return { mode: lease.mode, ownerId: lease.ownerId, epoch: lease.epoch, fence: lease.fence }
  }

  return {
    start, stop, onFinal, onTables, getDeliverySnapshot, acknowledge, rebindDeliveryQueue,
    snapshot: () => ({
      started, source: lease && currentSource(), gaps: structuredClone(gaps), liveGate: lastReplayGate,
      bypassedGaps: structuredClone(bypassedGaps),
      ...(apiClient?.snapshot?.() ?? {}), tableCount: tables.length,
      sourceProgressAt: sourceProgressTracker?.sourceProgressAt ?? null,
    }),
  }
}

function selectGapPending(pending, gaps) {
  const identities = new Set()
  for (const gap of gaps) {
    if (gap.type === 'same_shoe') for (const round of gap.rounds) identities.add(`${gap.tableId}:${gap.shoe}:${round}`)
  }
  return pending.filter((entry) => identities.has(entry.identity) || (gaps.some((gap) => gap.type === 'cross_shoe') && entry.event?.deliveryKind === 'replay'))
}

function gapCoveredByPending(gap, pending) {
  if (gap.type === 'cross_shoe') return false
  const available = new Set(pending.map((entry) => entry.identity))
  return gap.rounds.every((round) => available.has(`${gap.tableId}:${gap.shoe}:${round}`))
}

function sameCrossShoeCoverage(proof, gap) {
  return proof?.type === 'cross_shoe' && proof.tableId === gap.tableId
    && Number(proof.from?.shoe) === Number(gap.from?.shoe) && Number(proof.from?.round) === Number(gap.from?.round)
    && Number(proof.to?.shoe) === Number(gap.to?.shoe) && Number(proof.to?.round) === Number(gap.to?.round)
}

function crossShoeGapKey(gap) {
  return `${gap.tableId}:${Number(gap.from?.shoe)}:${Number(gap.from?.round)}:${Number(gap.to?.shoe)}:${Number(gap.to?.round)}`
}

function uniqueTables(values) {
  return [...new Map(values.map((table) => [table.tableId, table])).values()]
}
