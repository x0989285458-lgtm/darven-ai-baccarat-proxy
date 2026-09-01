import crypto from 'node:crypto'
import path from 'node:path'
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { gzip, gunzip } from 'node:zlib'
import { PRODUCTION_TABLE_IDS, sanitizeProductionSnapshot } from './table-policy.js'
import { BUILD_VERSION } from './runtime-config.js'

const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)

export function createSnapshotPusher({
  targetUrl,
  key,
  getSnapshot,
  fetchImpl = globalThis.fetch,
  queuePath = './data/latest-snapshot.json',
  historicalArchivePath = `${queuePath}.historical.jsonl`,
  cursorPath = `${queuePath}.cursor.json`,
  maxCursorEntries = 10000,
  maxDrainPerTick = 1,
  intervalMs = 5000,
  baseBackoffMs = 1000,
  maxBackoffMs = 60000,
  requestTimeoutMs = 15000,
  maxRoundsPerEnvelope = 5,
  maxRoundsPerDelivery = maxRoundsPerEnvelope,
  queueCompressionThresholdBytes = 1024 * 1024,
  queueJournalThresholdEntries = 100,
  isRoundDeliverable = () => true,
  onAcknowledged = async () => {},
  onArchived = async () => {},
  onRebindQueue = null,
  faultInjector = async () => {},
  now = Date.now,
} = {}) {
  const roundLimit = Math.max(1, Number(maxRoundsPerEnvelope) || 5)
  void maxRoundsPerDelivery
  const journalThreshold = Math.max(1, Number(queueJournalThresholdEntries) || 100)
  const journalPath = `${queuePath}.journal`
  let timer = null
  let failures = 0
  let nextAttemptAt = 0
  let lastSequence = 0
  let active = false
  let restored = false
  let stateInvalid = false
  let legacyMutableQueueDetected = false
  let queue = []
  let queueNeedsSave = false
  let queueNeedsResequence = false
  let cursorInitialized = false
  const observedRoundKeys = new Set()
  const acknowledgedRoundKeys = new Set()
  let lastAttemptAtMs = null
  let lastSuccessAtMs = null
  let lastError = null
  let lastAcknowledgedSessionId = null
  let lastAcknowledgedSequence = null
  let stopped = false
  let currentTickPromise = null
  let currentController = null
  let triggerRequested = false
  let triggerLoopPromise = null
  let archivedRoundKeyCount = 0
  let lastCompactionAtMs = null
  let lastCompactionArchivedCount = 0

  function tick() {
    if (stopped || !targetUrl || !key || typeof getSnapshot !== 'function' || active || stateInvalid) return Promise.resolve(false)
    const promise = runTick()
    currentTickPromise = promise
    const clear = () => {
      if (currentTickPromise === promise) currentTickPromise = null
    }
    promise.then(clear, clear)
    return promise
  }

  function trigger() {
    if (stopped || !targetUrl || !key || typeof getSnapshot !== 'function' || stateInvalid) return Promise.resolve(false)
    triggerRequested = true
    if (triggerLoopPromise) return triggerLoopPromise
    const loop = runTriggeredTicks()
    const promise = loop.finally(() => {
      if (triggerLoopPromise === promise) triggerLoopPromise = null
      if (triggerRequested && !stopped && !stateInvalid) return trigger()
      return undefined
    })
    triggerLoopPromise = promise
    return promise
  }

  async function runTriggeredTicks() {
    let progressed = false
    do {
      triggerRequested = false
      const inFlight = currentTickPromise
      if (inFlight) progressed = (await inFlight) || progressed
      if (stopped || stateInvalid) break
      progressed = (await tick()) || progressed
    } while (triggerRequested)
    await faultInjector('trigger_loop_idle')
    return progressed
  }

  async function runTick() {
    active = true
    try {
      await restoreState()
      if (stateInvalid) return false
      if (await recoverRemoteAcknowledgement()) return true
      let timestamp = Number(now())
      const snapshot = await collectSnapshot(timestamp)
      if (timestamp < nextAttemptAt || queue.length === 0) return false

      const drainLimit = Math.max(1, Number(maxDrainPerTick) || 1)
      let acknowledgedAny = false
      for (let drained = 0; drained < drainLimit && queue.length > 0; drained += 1) {
        const requestTimestamp = Math.max(timestamp, Number(now()) || timestamp)
        const delivery = buildDeliveryEnvelope(requestTimestamp)
        const envelope = delivery.envelope
        if (!envelope) break
        const retryingAttemptedEnvelope = queue[0]?.deliveryState === 'attempted'
        if (envelope.roundKeys.length > 0 && queue[0]?.deliveryState !== 'attempted') {
          queue[0] = { ...queue[0], deliveryState: 'attempted' }
          await saveQueue()
        }
        lastAttemptAtMs = requestTimestamp
        const controller = new AbortController()
        currentController = controller
        const timeout = setTimeout(() => controller.abort(), requestTimeoutMs)
        try {
          const request = {
            method: 'POST',
            redirect: 'error',
            headers: { 'content-type': 'application/json', 'x-worker-key': key },
            body: JSON.stringify(envelope),
            signal: controller.signal,
          }
          const response = await fetchImpl(targetUrl, request)
          let acknowledgement = await readAcknowledgement(response, envelope)
          if (!acknowledgement && retryingAttemptedEnvelope && await isStaleFenceResponse(response)) {
            const reconciliation = await fetchImpl(`${String(targetUrl).replace(/\/$/, '')}/reconcile`, request)
            acknowledgement = await readAcknowledgement(reconciliation, envelope)
            if (!acknowledgement && await isReconciliationNotFoundResponse(reconciliation)) {
              await rebindQueuedTransport(snapshot, requestTimestamp, { notFoundEnvelope: envelope })
              failures = 0
              nextAttemptAt = 0
              lastError = null
              drained -= 1
              continue
            }
          }
          if (!acknowledgement) throw new Error(`push failed with invalid acknowledgement (${response?.status ?? 'unknown'})`)
          const receipt = {
            sessionId: String(envelope.sessionId ?? ''),
            sequence: Number(envelope.sequence),
            acceptedRoundKeys: acknowledgement.acceptedRoundKeys,
            ...(envelope.source ? { source: structuredClone(envelope.source) } : {}),
            acknowledgedAtMs: requestTimestamp,
          }
          queue[0] = { ...queue[0], deliveryState: 'remote_ack_pending', remoteAckReceipt: receipt }
          await saveQueue()
          await faultInjector('after_remote_ack_checkpoint', structuredClone(receipt))
          await finalizeRemoteAcknowledgement(queue[0])
          failures = 0
          nextAttemptAt = 0
          lastSuccessAtMs = requestTimestamp
          lastError = null
          lastAcknowledgedSessionId = String(envelope.sessionId ?? '') || null
          lastAcknowledgedSequence = Number(envelope.sequence)
          acknowledgedAny = true
        } catch (error) {
          failures += 1
          lastError = sanitizePusherError(error?.message ?? error)
          const failureTimestamp = Math.max(timestamp, Number(now()) || timestamp)
          nextAttemptAt = failureTimestamp + Math.min(maxBackoffMs, baseBackoffMs * (2 ** (failures - 1)))
          return acknowledgedAny
        } finally {
          clearTimeout(timeout)
          if (currentController === controller) currentController = null
        }
      }
      return acknowledgedAny
    } catch (error) {
      stateInvalid = true
      throw error
    } finally {
      active = false
    }
  }

  function buildDeliveryEnvelope(timestamp) {
    const head = queue[0]
    if (!head) return { envelope: null, entryCount: 0 }
    const { deliveryState: _deliveryState, remoteAckReceipt: _remoteAckReceipt, ...durableEnvelope } = head
    return { envelope: { ...durableEnvelope, timestamp }, entryCount: 1 }
  }

  async function collectSnapshot(timestamp) {
    const snapshot = hydrateSnapshotTableScreens(sanitizeProductionSnapshot(await getSnapshot()))
    await compactHistoricalBacklog(snapshot, timestamp)
    await rebindQueuedTransport(snapshot, timestamp)
    const rounds = Array.isArray(snapshot?.rounds) ? snapshot.rounds : []
    const candidates = uniqueRoundCandidates(rounds
      .filter((round) => isRoundDeliverable(round))
      .map((round) => ({ round, key: roundKey(round) }))
      .filter((candidate) => candidate.key))

    if (!cursorInitialized) cursorInitialized = true

    const queuedRoundKeys = new Set(queue.flatMap((entry) => entry.roundKeys))
    const pending = candidates.filter(({ key: roundKeyValue }) => (
      !observedRoundKeys.has(roundKeyValue)
      && !acknowledgedRoundKeys.has(roundKeyValue)
      && !queuedRoundKeys.has(roundKeyValue)
    ))
    for (const candidate of candidates) observedRoundKeys.add(candidate.key)
    trimCursor()

    if (pending.length > 0) {
      const pendingRounds = pending.map(({ round }, index) => normalizeRoundForEnvelope(round, pending[index].key))
      const pendingKeys = pending.map(({ key: roundKeyValue }) => roundKeyValue)
      const useJournal = queue.length + Math.ceil(pendingKeys.length / roundLimit) >= journalThreshold
      const journalEntries = []
      for (let offset = 0; offset < pendingKeys.length;) {
        const count = Math.min(roundLimit, pendingKeys.length - offset)
        const entry = createEnvelope(
          snapshot,
          pendingRounds.slice(offset, offset + count),
          pendingKeys.slice(offset, offset + count),
          timestamp,
        )
        queue.push(entry)
        if (useJournal) journalEntries.push(entry)
        offset += count
      }
      if (useJournal) await appendQueueJournal(journalEntries)
      else await saveQueue()
    }
    await compactHistoricalBacklog(snapshot, timestamp)
    await prioritizeLiveQueue(snapshot, timestamp)
    await saveCursor()
    if (pending.length === 0 && queue.length === 0) {
      queue.push(createEnvelope(snapshot, [], [], timestamp))
      await saveQueue()
    }
    return snapshot
  }

  async function recoverRemoteAcknowledgement() {
    if (queue[0]?.deliveryState !== 'remote_ack_pending') return false
    await finalizeRemoteAcknowledgement(queue[0])
    failures = 0
    nextAttemptAt = 0
    lastError = null
    return true
  }

  async function finalizeRemoteAcknowledgement(entry) {
    const receipt = normalizeRemoteAckReceipt(entry)
    const journalReceipt = {
      sessionId: receipt.sessionId,
      sequence: receipt.sequence,
      acceptedRoundKeys: [...receipt.acceptedRoundKeys],
      ...(receipt.source ? { source: structuredClone(receipt.source) } : {}),
    }
    await onAcknowledged(journalReceipt)
    await faultInjector('after_journal_ack', structuredClone(receipt))
    for (const roundKeyValue of receipt.acceptedRoundKeys) acknowledgedRoundKeys.add(roundKeyValue)
    trimCursor()
    await saveCursor()
    if (queue[0]?.sequence !== entry.sequence || queue[0]?.deliveryState !== 'remote_ack_pending') {
      throw new Error('remote_ack_pending_head_changed')
    }
    queue.shift()
    await saveQueue()
    lastSuccessAtMs = receipt.acknowledgedAtMs
    lastAcknowledgedSessionId = receipt.sessionId || null
    lastAcknowledgedSequence = receipt.sequence
  }

  async function compactHistoricalBacklog(snapshot, timestamp) {
    const confirmedShoes = observeConfirmedShoes(snapshot)
    const prioritizeCurrentRound = hasExactTenTableScreens(snapshot)
    if (queue.length === 0 || confirmedShoes.size === 0) return

    const archiveRecords = []
    const retainedQueue = []
    for (const entry of queue) {
      if (entry.deliveryState) {
        retainedQueue.push(entry)
        continue
      }
      const rounds = Array.isArray(entry.snapshot?.rounds) ? entry.snapshot.rounds : []
      if (rounds.length === 0) {
        retainedQueue.push(entry)
        continue
      }
      const retainedRounds = []
      const retainedKeys = []
      for (const round of rounds) {
        const keyValue = roundKey(round)
        const currentObservation = confirmedShoes.get(canonicalTableId(round?.tableId))
        const currentShoe = currentObservation?.shoe ?? null
        const roundShoe = normalizeShoeIdentity(round?.shoe)
        const historicalShoe = isClearlyHistoricalShoe(roundShoe, currentObservation)
        const supersededRound = prioritizeCurrentRound && !historicalShoe
          && currentObservation?.roundKey && keyValue !== currentObservation.roundKey
        if (!historicalShoe && !supersededRound) {
          retainedRounds.push(round)
          retainedKeys.push(keyValue)
          continue
        }
        archiveRecords.push({
          version: 1,
          archiveId: `${String(entry.sessionId ?? '')}:${Number(entry.sequence)}:${keyValue}`,
          archivedAt: Number(timestamp),
          reason: historicalShoe ? 'historical_shoe_backlog' : 'superseded_round_backlog',
          roundKey: keyValue,
          currentShoe,
          sessionId: String(entry.sessionId ?? ''),
          sequence: Number(entry.sequence),
          source: entry.source ?? null,
          round,
        })
      }
      if (retainedRounds.length > 0) {
        retainedQueue.push({
          ...entry,
          roundKeys: retainedKeys,
          snapshot: { ...entry.snapshot, rounds: retainedRounds },
        })
      }
    }
    if (archiveRecords.length === 0) return
    await appendHistoricalArchive(archiveRecords)
    queue = retainedQueue
    archivedRoundKeyCount += archiveRecords.length
    lastCompactionAtMs = Number(timestamp)
    lastCompactionArchivedCount = archiveRecords.length
    await saveQueue()
    await onArchived({
      roundKeys: archiveRecords.map((record) => record.roundKey),
      records: structuredClone(archiveRecords),
    })
    await completeHistoricalArchive(archiveRecords, timestamp)
  }

  function observeConfirmedShoes(snapshot) {
    const confirmed = new Map()
    const activeSource = normalizeSource(snapshot?.source)
    let chronology = 0
    const observeRound = (round) => {
      const tableId = canonicalTableId(round?.tableId)
      const shoe = normalizeShoeIdentity(round?.shoe)
      if (!tableId || shoe == null) return
      chronology += 1
      const source = normalizeEventSource(round?.capturedSource ?? round?.source)
      const current = confirmed.get(tableId)
      if (current) {
        const candidateIsActive = sameSourceTransport(source, activeSource)
        const currentIsActive = sameSourceTransport(current.source, activeSource)
        if (!candidateIsActive && currentIsActive) return
        if (candidateIsActive === currentIsActive
          && compareEventSourceChronology(source, current.source ?? null) !== 1) return
      }
      confirmed.set(tableId, {
        shoe, roundKey: roundKey(round), chronology, count: Number.MAX_SAFE_INTEGER, source,
      })
    }
    for (const entry of queue) {
      for (const round of Array.isArray(entry?.snapshot?.rounds) ? entry.snapshot.rounds : []) observeRound(round)
    }
    for (const round of Array.isArray(snapshot?.rounds) ? snapshot.rounds : []) observeRound(round)
    for (const table of Array.isArray(snapshot?.tables) ? snapshot.tables : []) {
      const tableId = canonicalTableId(table?.tableId)
      const shoe = normalizeShoeIdentity(table?.shoe)
      if (tableId && shoe != null && !confirmed.has(tableId)) confirmed.set(tableId, { shoe, chronology: 0, count: 1 })
    }
    return confirmed
  }

  function isClearlyHistoricalShoe(roundShoe, currentObservation) {
    const currentShoe = currentObservation?.shoe ?? null
    if (currentShoe == null || roundShoe == null || roundShoe === currentShoe) return false
    return true
  }

  function hydrateSnapshotTableScreens(snapshot) {
    const lifecycles = new Map()
    const observeLifecycle = (value, { authoritative = false } = {}) => {
      const tableId = canonicalTableId(value?.tableId)
      const activeShoe = Number(value?.activeShoe)
      const screenShoe = Number(value?.currentScreen?.shoe)
      const screenRound = Number(value?.currentScreen?.round)
      const retiredShoes = Array.isArray(value?.retiredShoes) ? value.retiredShoes.map(Number) : null
      const source = normalizeEventSource(value?.source)
      if (!tableId || activeShoe !== screenShoe || !Number.isSafeInteger(activeShoe)
        || !Number.isSafeInteger(screenRound) || !retiredShoes || !retiredShoes.every(Number.isSafeInteger)
        || retiredShoes.includes(activeShoe) || !source) return
      const candidate = {
        tableId, activeShoe, retiredShoes: [...new Set(retiredShoes)],
        currentScreen: { shoe: screenShoe, round: screenRound }, source,
      }
      const current = lifecycles.get(tableId)
      if (authoritative || !current || compareEventSourceChronology(source, current.source) === 1) {
        lifecycles.set(tableId, candidate)
      }
    }
    for (const entry of queue) {
      for (const round of Array.isArray(entry?.snapshot?.rounds) ? entry.snapshot.rounds : []) {
        if (round?.shoeLifecycle) observeLifecycle(round.shoeLifecycle)
      }
    }
    for (const round of Array.isArray(snapshot?.rounds) ? snapshot.rounds : []) {
      if (round?.shoeLifecycle) observeLifecycle(round.shoeLifecycle)
    }
    for (const lifecycle of Array.isArray(snapshot?.shoeLifecycles) ? snapshot.shoeLifecycles : []) {
      observeLifecycle(lifecycle, { authoritative: true })
    }
    const { shoeLifecycles: _shoeLifecycles, ...publicSnapshot } = snapshot
    return {
      ...publicSnapshot,
      rounds: (Array.isArray(snapshot?.rounds) ? snapshot.rounds : []).map(({ shoeLifecycle: _proof, ...round }) => round),
      tables: (Array.isArray(snapshot?.tables) ? snapshot.tables : []).map((table) => {
        const tableId = canonicalTableId(table?.tableId)
        const proof = lifecycles.get(tableId)
        if (!proof) return table
        const shoe = Number(table?.shoe)
        const round = Number(table?.round)
        const missingScreen = !Number.isSafeInteger(shoe) || !Number.isSafeInteger(round)
        const unconfirmedShoe = shoe !== proof.activeShoe
        const staleActiveScreen = shoe === proof.activeShoe && round < proof.currentScreen.round
        if (missingScreen || unconfirmedShoe || staleActiveScreen) {
          return { ...table, shoe: proof.currentScreen.shoe, round: proof.currentScreen.round }
        }
        return table
      }),
    }
  }

  async function prioritizeLiveQueue(snapshot, timestamp) {
    if (queue.length < 2 || queue.some((entry) => entry.deliveryState) || !hasExactTenTableScreens(snapshot)) return
    const grouped = new Map()
    const tableChronology = new Map()
    let chronology = 0
    for (const entry of queue) {
      for (const round of Array.isArray(entry?.snapshot?.rounds) ? entry.snapshot.rounds : []) {
        const tableId = canonicalTableId(round?.tableId)
        if (!tableId) continue
        chronology += 1
        if (!grouped.has(tableId)) grouped.set(tableId, [])
        grouped.get(tableId).push(round)
        tableChronology.set(tableId, chronology)
      }
    }
    for (const round of Array.isArray(snapshot?.rounds) ? snapshot.rounds : []) {
      const tableId = canonicalTableId(round?.tableId)
      if (tableId) tableChronology.set(tableId, ++chronology)
    }
    const prioritizedRounds = [...grouped.entries()]
      .sort(([left], [right]) => (tableChronology.get(right) ?? 0) - (tableChronology.get(left) ?? 0))
      .flatMap(([, rounds]) => rounds)
    const prioritizedKeys = prioritizedRounds.map((round) => roundKey(round))
    const currentKeys = queue.flatMap((entry) => entry.roundKeys.map(String))
    const hasEmptyEnvelope = queue.some((entry) => entry.roundKeys.length === 0)
    if (!hasEmptyEnvelope && JSON.stringify(prioritizedKeys) === JSON.stringify(currentKeys)) return
    const rebuilt = []
    for (let offset = 0; offset < prioritizedRounds.length; offset += roundLimit) {
      const rounds = prioritizedRounds.slice(offset, offset + roundLimit)
      rebuilt.push(createEnvelope(snapshot, rounds, rounds.map((round) => roundKey(round)), timestamp))
    }
    queue = rebuilt
    await saveQueue()
  }

  function hasExactTenTableScreens(snapshot) {
    const tables = Array.isArray(snapshot?.tables) ? snapshot.tables : []
    if (tables.length !== PRODUCTION_TABLE_IDS.length) return false
    const ids = new Set()
    for (const table of tables) {
      const tableId = canonicalTableId(table?.tableId)
      if (!PRODUCTION_TABLE_IDS.includes(tableId) || ids.has(tableId)
        || !Number.isSafeInteger(Number(table?.shoe)) || !Number.isSafeInteger(Number(table?.round))) return false
      ids.add(tableId)
    }
    return ids.size === PRODUCTION_TABLE_IDS.length
  }

  function normalizeShoeIdentity(value) {
    if (value == null || value === '') return null
    const numeric = Number(value)
    return Number.isFinite(numeric) ? String(numeric) : String(value)
  }

  async function appendHistoricalArchive(records) {
    await mkdir(path.dirname(historicalArchivePath), { recursive: true })
    const handle = await open(historicalArchivePath, 'a', 0o600)
    try {
      await handle.writeFile(records.map((record) => JSON.stringify(record)).join('\n') + '\n')
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  async function completeHistoricalArchive(records, timestamp) {
    if (!Array.isArray(records) || records.length === 0) return
    const completedIds = new Set(records.map(archiveRecordIdentity))
    const activeRecords = await readHistoricalArchiveRecords()
    const completed = activeRecords.filter((record) => completedIds.has(archiveRecordIdentity(record)))
    if (completed.length === 0) return
    const serialized = completed.map((record) => JSON.stringify(record)).join('\n') + '\n'
    const digest = crypto.createHash('sha256').update(serialized).digest('hex').slice(0, 16)
    const completedPath = `${historicalArchivePath}.completed-${Number(timestamp)}-${digest}.jsonl.gz`
    await saveBytes(completedPath, await gzipAsync(Buffer.from(serialized), { level: 1 }))
    const remaining = activeRecords.filter((record) => !completedIds.has(archiveRecordIdentity(record)))
    if (remaining.length > 0) {
      await saveBytes(historicalArchivePath, remaining.map((record) => JSON.stringify(record)).join('\n') + '\n')
    } else await rm(historicalArchivePath, { force: true })
  }

  function archiveRecordIdentity(record) {
    return String(record?.archiveId ?? `${String(record?.sessionId ?? '')}:${Number(record?.sequence)}:${String(record?.roundKey ?? '')}`)
  }

  async function rebindQueuedTransport(snapshot, timestamp, { notFoundEnvelope = null } = {}) {
    const targetSource = normalizeSource(snapshot?.source)
    const targetSessionId = String(snapshot?.sessionId ?? '')
    if (queue.length === 0 || !targetSource) return
    const recoveringMissingAttempt = notFoundEnvelope != null
    if (recoveringMissingAttempt) {
      const head = queue[0]
      const exactAttemptedHead = head?.deliveryState === 'attempted'
        && String(head.sessionId ?? '') === String(notFoundEnvelope?.sessionId ?? '')
        && Number(head.sequence) === Number(notFoundEnvelope?.sequence)
        && JSON.stringify(head.roundKeys ?? []) === JSON.stringify(notFoundEnvelope?.roundKeys ?? [])
        && JSON.stringify(normalizeSource(head.source)) === JSON.stringify(normalizeSource(notFoundEnvelope?.source))
        && JSON.stringify(head.snapshot) === JSON.stringify(notFoundEnvelope?.snapshot)
      if (!exactAttemptedHead || queue.slice(1).some((entry) => entry.deliveryState)) {
        throw new Error('attempted_reconciliation_not_found_identity_mismatch')
      }
    } else if (queue.some((entry) => entry.deliveryState)) return
    const needsRebind = queue.some((entry) => (
      JSON.stringify(normalizeSource(entry.source)) !== JSON.stringify(targetSource)
      || String(entry.sessionId ?? '') !== targetSessionId
    ))
    if (!needsRebind) {
      if (recoveringMissingAttempt) throw new Error('attempted_reconciliation_not_found_target_unchanged')
      return
    }
    if (typeof onRebindQueue !== 'function') throw new Error('queued_source_rebind_required')
    const roundKeys = queue.flatMap((entry) => entry.roundKeys.map(String))
    const reboundRounds = await onRebindQueue({
      roundKeys: [...roundKeys], source: structuredClone(targetSource), sessionId: targetSessionId,
      snapshot: structuredClone(snapshot),
    })
    if (!Array.isArray(reboundRounds) || reboundRounds.length !== roundKeys.length) throw new Error('queued_source_rebind_incomplete')
    const byIdentity = new Map()
    for (const round of reboundRounds) {
      const keyValue = roundKey(round)
      if (!keyValue || byIdentity.has(keyValue)) throw new Error('queued_source_rebind_incomplete')
      const eventSource = normalizeEventSource(round?.source)
      if (!eventSource || JSON.stringify(normalizeSource(eventSource)) !== JSON.stringify(targetSource)) throw new Error('queued_source_rebind_mismatch')
      byIdentity.set(keyValue, round)
    }
    let nextSequence = Math.max(lastSequence, Number(timestamp) || 0)
    const reboundQueue = queue.map((entry) => {
      const { deliveryState: _deliveryState, remoteAckReceipt: _remoteAckReceipt, ...durableEntry } = entry
      const rounds = entry.snapshot.rounds.map((oldRound) => {
        const identity = roundKey(oldRound)
        const rebound = byIdentity.get(identity)
        if (!rebound || JSON.stringify(withoutTransport(rebound)) !== JSON.stringify(withoutTransport(oldRound))) {
          throw new Error('queued_source_rebind_payload_changed')
        }
        return {
          ...oldRound,
          capturedSource: structuredClone(rebound.capturedSource ?? oldRound.capturedSource ?? oldRound.source),
          source: structuredClone(normalizeEventSource(rebound.source)),
        }
      })
      nextSequence += 1
      return {
        ...durableEntry,
        capturedSource: structuredClone(entry.capturedSource ?? entry.source),
        source: structuredClone(targetSource),
        sessionId: targetSessionId,
        sequence: nextSequence,
        snapshot: {
          ...entry.snapshot,
          ...snapshot,
          sessionId: targetSessionId,
          source: structuredClone(targetSource),
          rounds,
        },
      }
    })
    queue = reboundQueue
    lastSequence = nextSequence
    await saveQueue()
    await saveCursor()
  }

  function splitOversizedQueueEntries(entries) {
    const bounded = []
    let changed = false
    for (const entry of entries) {
      const rounds = Array.isArray(entry.snapshot?.rounds) ? entry.snapshot.rounds : []
      if (rounds.length <= roundLimit) {
        const previousSequence = bounded.at(-1)?.sequence ?? 0
        const sequence = bounded.length === 0 ? entry.sequence : Math.max(entry.sequence, previousSequence + 1)
        bounded.push(sequence === entry.sequence ? entry : { ...entry, sequence })
        changed ||= sequence !== entry.sequence
        continue
      }
      changed = true
      for (let offset = 0; offset < rounds.length; offset += roundLimit) {
        const previousSequence = bounded.at(-1)?.sequence ?? 0
        const sequence = bounded.length === 0 && offset === 0
          ? entry.sequence
          : Math.max(entry.sequence + Math.floor(offset / roundLimit), previousSequence + 1)
        bounded.push({
          ...entry,
          sequence,
          roundKeys: entry.roundKeys.slice(offset, offset + roundLimit),
          snapshot: { ...entry.snapshot, rounds: rounds.slice(offset, offset + roundLimit) },
        })
      }
    }
    return { entries: bounded, changed }
  }

  function createEnvelope(snapshot, rounds, roundKeys, timestamp) {
    const sequence = Math.max(lastSequence + 1, timestamp)
    lastSequence = sequence
    return {
      protocolVersion: 'v105',
      sessionId: String(snapshot?.sessionId ?? ''),
      ...(normalizeSource(snapshot?.source) ? { source: normalizeSource(snapshot.source) } : {}),
      timestamp,
      captureTimestamp: timestamp,
      sequence,
      roundKeys,
      snapshot: { ...snapshot, rounds },
    }
  }

  async function restoreState() {
    if (restored) return
    restored = true
    let migratingLegacyCursor = false
    try {
      const queued = await readStateFile(queuePath, 'queue')
      if (queued) {
        try {
          const entries = Array.isArray(queued.entries) ? queued.entries : [queued]
          const legacyV105DataQueue = Number(queued.version ?? 1) < 3
            && entries.some((entry) => entry?.protocolVersion === 'v105'
              && Array.isArray(entry?.roundKeys) && entry.roundKeys.length > 0)
          if (legacyV105DataQueue) {
            queue = entries
            legacyMutableQueueDetected = true
            stateInvalid = true
            return
          }
          const normalizedEntries = entries.map(normalizeQueuedEnvelope)
          const retainedEntries = normalizedEntries.filter((item) => !item.drop).map((item) => item.envelope)
          const bounded = splitOversizedQueueEntries(retainedEntries)
          queue = bounded.entries
          queueNeedsSave = normalizedEntries.some((item) => item.changed) || bounded.changed
          queueNeedsResequence = normalizedEntries.some((item) => item.resequence)
          for (const entry of queue) lastSequence = Math.max(lastSequence, entry.sequence)
        } catch (error) {
          await quarantineState(queuePath, 'queue', error)
        }
      }
      const journalEntries = await readQueueJournal()
      if (journalEntries.length > 0) {
        const seenSequences = new Set(queue.map((entry) => entry.sequence))
        for (const rawEntry of journalEntries) {
          const normalized = normalizeQueuedEnvelope(rawEntry)
          if (normalized.drop || seenSequences.has(normalized.envelope.sequence)) continue
          const boundedJournalEntries = splitOversizedQueueEntries([normalized.envelope]).entries
          for (const entry of boundedJournalEntries) {
            if (seenSequences.has(entry.sequence)) continue
            queue.push(entry)
            seenSequences.add(entry.sequence)
            lastSequence = Math.max(lastSequence, entry.sequence)
          }
        }
      }
      const cursor = await readStateFile(cursorPath, 'cursor')
      if (cursor) {
        try {
          if (typeof cursor.initialized !== 'boolean'
            || !Array.isArray(cursor.observedRoundKeys ?? [])
            || !Array.isArray(cursor.acknowledgedRoundKeys ?? [])
            || (cursor.lastSequence != null && !Number.isSafeInteger(cursor.lastSequence))) throw new Error('invalid cursor state')
          const cursorVersion = Number(cursor.version ?? 1)
          migratingLegacyCursor = cursorVersion < 3
          cursorInitialized = cursor.initialized
          lastSequence = Math.max(lastSequence, Number(cursor.lastSequence ?? 0))
          const acknowledged = cursor.acknowledgedRoundKeys ?? []
          const observed = cursorVersion >= 3 ? (cursor.observedRoundKeys ?? acknowledged) : acknowledged
          for (const roundKeyValue of observed) observedRoundKeys.add(String(roundKeyValue))
          for (const roundKeyValue of cursor.acknowledgedRoundKeys ?? []) acknowledgedRoundKeys.add(String(roundKeyValue))
        } catch (error) {
          await quarantineState(cursorPath, 'cursor', error)
        }
      }
      const archivedRecords = await readHistoricalArchiveRecords()
      if (archivedRecords.length > 0) {
        const activeRoundKeys = new Set(queue.flatMap((entry) => entry.roundKeys ?? []).map(String))
        const uniqueByRoundKey = new Map()
        for (const record of archivedRecords) {
          const keyValue = String(record.roundKey)
          if (!activeRoundKeys.has(keyValue)) uniqueByRoundKey.set(keyValue, record)
        }
        const records = [...uniqueByRoundKey.values()]
        archivedRoundKeyCount = new Set(archivedRecords.map((record) => String(record.roundKey))).size
        lastCompactionAtMs = Math.max(...archivedRecords.map((record) => Number(record.archivedAt) || 0)) || null
        if (records.length > 0) {
          await onArchived({ roundKeys: [...uniqueByRoundKey.keys()], records: structuredClone(records) })
          await completeHistoricalArchive(records, lastCompactionAtMs ?? Number(now()))
        }
      }
      if (migratingLegacyCursor) {
        for (const entry of queue) {
          for (const roundKeyValue of entry.roundKeys ?? []) observedRoundKeys.add(String(roundKeyValue))
        }
      }
      trimCursor()
      if (queueNeedsResequence) {
        if (queue.length > 0) {
          const current = Number(now())
          if (!Number.isSafeInteger(current)) throw new Error('invalid clock while migrating queued envelopes')
          let sequence = Math.max(lastSequence, current)
          queue = queue.map((entry) => ({ ...entry, sequence: ++sequence }))
          lastSequence = sequence
        }
        queueNeedsResequence = false
      }
      if (queueNeedsSave) {
        queueNeedsSave = false
        await saveQueue()
      }
    } catch (error) {
      stateInvalid = true
      throw error
    }
  }

  async function readStateFile(filePath, label) {
    let text
    try {
      const bytes = await readFile(filePath)
      const compressed = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
      text = (compressed ? await gunzipAsync(bytes) : bytes).toString('utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
    try {
      const value = JSON.parse(text)
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid ${label} state`)
      return value
    } catch (error) {
      await quarantineState(filePath, label, error)
    }
  }

  async function readHistoricalArchiveRecords() {
    let text
    try {
      text = await readFile(historicalArchivePath, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
    try {
      return text.split(/\r?\n/).filter(Boolean).map((line) => {
        const record = JSON.parse(line)
        if (!record || typeof record !== 'object' || !String(record.roundKey ?? '')) throw new Error('invalid historical archive receipt')
        return record
      })
    } catch (error) {
      const quarantinePath = `${historicalArchivePath}.corrupt-${Number(now())}`
      await rename(historicalArchivePath, quarantinePath)
      throw new Error(`corrupt historical archive quarantined at ${quarantinePath}`, { cause: error })
    }
  }

  async function readQueueJournal() {
    let text
    try {
      text = await readFile(journalPath, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
    try {
      return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    } catch (error) {
      await quarantineState(journalPath, 'queue journal', error)
    }
  }

  async function appendQueueJournal(entries) {
    if (entries.length === 0) return
    await mkdir(path.dirname(journalPath), { recursive: true })
    const handle = await open(journalPath, 'a', 0o600)
    try {
      await handle.writeFile(entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n')
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  async function quarantineState(filePath, label, error) {
    const quarantinePath = `${filePath}.corrupt-${Number(now())}`
    await rename(filePath, quarantinePath)
    throw new Error(`corrupt ${label} state quarantined at ${quarantinePath}`, { cause: error })
  }

  function normalizeQueuedEnvelope(envelope) {
    if (!envelope?.snapshot || !Number.isSafeInteger(envelope.sequence)) throw new Error('corrupt queue state: invalid envelope')
    const originalSnapshot = envelope.snapshot
    const originalRounds = Array.isArray(originalSnapshot.rounds) ? originalSnapshot.rounds : []
    const originalKeys = Array.isArray(envelope.roundKeys) ? envelope.roundKeys.map(String) : originalRounds.map((round) => roundKey(round))
    const snapshot = sanitizeProductionSnapshot(originalSnapshot)
    const rounds = (Array.isArray(snapshot.rounds) ? snapshot.rounds : []).filter((round) => isRoundDeliverable(round))
    const seenKeys = new Set()
    const keyedRounds = []
    for (const round of rounds) {
      const key = roundKey(round)
      if (!key) throw new Error('corrupt queue state: completed round has no durable key')
      if (seenKeys.has(key)) continue
      seenKeys.add(key)
      keyedRounds.push({ round, key })
    }
    const keys = keyedRounds.map((item) => item.key)
    const captureTimestamp = Number(envelope.captureTimestamp ?? envelope.timestamp)
    const normalizedEnvelope = {
      ...envelope,
      protocolVersion: 'v105',
      sessionId: String(envelope.sessionId ?? snapshot.sessionId ?? ''),
      ...(normalizeSource(envelope.source ?? snapshot.source) ? { source: normalizeSource(envelope.source ?? snapshot.source) } : {}),
      timestamp: Number(envelope.timestamp),
      captureTimestamp,
      sequence: Number(envelope.sequence),
      roundKeys: keys,
      snapshot: {
        ...snapshot,
        buildVersion: BUILD_VERSION,
        rounds: keyedRounds.map(({ round, key }) => normalizeRoundForEnvelope(round, key)),
      },
    }
    if (envelope.deliveryState != null && !['attempted', 'remote_ack_pending'].includes(envelope.deliveryState)) {
      throw new Error('corrupt queue state: invalid delivery state')
    }
    if (envelope.deliveryState === 'remote_ack_pending') {
      normalizedEnvelope.deliveryState = 'remote_ack_pending'
      normalizedEnvelope.remoteAckReceipt = normalizeRemoteAckReceipt(normalizedEnvelope)
    } else if (envelope.deliveryState === 'attempted') {
      normalizedEnvelope.deliveryState = 'attempted'
      delete normalizedEnvelope.remoteAckReceipt
    } else {
      delete normalizedEnvelope.deliveryState
      delete normalizedEnvelope.remoteAckReceipt
    }
    const originalPayload = { ...originalSnapshot }
    const normalizedPayload = { ...normalizedEnvelope.snapshot }
    delete originalPayload.buildVersion
    delete normalizedPayload.buildVersion
    const payloadChanged = JSON.stringify(normalizedPayload) !== JSON.stringify(originalPayload)
      || JSON.stringify(keys) !== JSON.stringify(originalKeys)
    const changed = normalizedEnvelope.protocolVersion !== envelope.protocolVersion
      || normalizedEnvelope.snapshot.buildVersion !== originalSnapshot.buildVersion
      || payloadChanged
    return {
      envelope: normalizedEnvelope,
      changed,
      resequence: payloadChanged,
      drop: originalRounds.length > 0 && keyedRounds.length === 0,
    }
  }

  async function saveJson(filePath, value) {
    await saveBytes(filePath, JSON.stringify(value))
  }

  async function saveBytes(filePath, value) {
    await mkdir(path.dirname(filePath), { recursive: true })
    const temporary = `${filePath}.tmp`
    await writeFile(temporary, value, { mode: 0o600 })
    await rename(temporary, filePath)
  }

  async function saveQueue() {
    if (queue.length === 0) {
      await rm(queuePath, { force: true })
      await rm(journalPath, { force: true })
      return
    }
    const serialized = JSON.stringify({ version: 3, entries: queue })
    const threshold = Math.max(1, Number(queueCompressionThresholdBytes) || 1024 * 1024)
    const content = Buffer.byteLength(serialized, 'utf8') >= threshold
      ? await gzipAsync(Buffer.from(serialized), { level: 1 })
      : serialized
    await saveBytes(queuePath, content)
    await rm(journalPath, { force: true })
  }

  async function saveCursor() {
    await saveJson(cursorPath, {
      version: 3,
      initialized: cursorInitialized,
      lastSequence,
      observedRoundKeys: [...observedRoundKeys],
      acknowledgedRoundKeys: [...acknowledgedRoundKeys],
    })
  }

  function trimCursor() {
    const limit = Math.max(1, Number(maxCursorEntries) || 10000)
    while (observedRoundKeys.size > limit) observedRoundKeys.delete(observedRoundKeys.values().next().value)
    while (acknowledgedRoundKeys.size > limit) acknowledgedRoundKeys.delete(acknowledgedRoundKeys.values().next().value)
  }

  function start() {
    if (timer || !targetUrl || !key || stateInvalid) return
    stopped = false
    void tick().catch(() => { void stop() })
    timer = setInterval(() => { void tick().catch(() => { void stop() }) }, Math.max(1000, Number(intervalMs) || 5000))
    timer.unref?.()
  }

  function stopTimer() {
    if (timer) clearInterval(timer)
    timer = null
  }

  async function drain({ maxTicks = 100 } = {}) {
    stopTimer()
    if (currentTickPromise) await currentTickPromise
    const limit = Math.max(1, Number(maxTicks) || 100)
    for (let attempt = 0; attempt < limit; attempt += 1) {
      const progressed = await tick()
      if (queue.length === 0) return snapshot()
      if (!progressed) throw new Error('snapshot_pusher_drain_incomplete')
    }
    throw new Error('snapshot_pusher_drain_limit_exceeded')
  }

  async function stopAndWait({ abortAfterTimeout = requestTimeoutMs } = {}) {
    stopped = true
    stopTimer()
    const pending = currentTickPromise
    if (pending) {
      const delay = Math.max(0, Number(abortAfterTimeout) || 0)
      let abortTimer = null
      if (delay === 0) currentController?.abort()
      else {
        abortTimer = setTimeout(() => currentController?.abort(), delay)
        abortTimer.unref?.()
      }
      try { await pending } catch {}
      finally { if (abortTimer) clearTimeout(abortTimer) }
    }
    return snapshot()
  }

  async function stop(options) {
    return stopAndWait(options)
  }

  function snapshot() {
    const head = queue[0] ?? null
    return {
      active,
      inFlight: currentTickPromise ? 1 : 0,
      stopped,
      stateInvalid,
      legacyMutableQueueDetected,
      queueEntryCount: queue.length,
      queuedRoundKeyCount: queue.reduce((total, entry) => total + (entry.roundKeys?.length ?? 0), 0),
      headSessionId: head?.sessionId == null ? null : String(head.sessionId),
      headSequence: Number.isSafeInteger(Number(head?.sequence)) ? Number(head.sequence) : null,
      consecutiveFailures: failures,
      nextAttemptAtMs: nextAttemptAt || null,
      lastAttemptAtMs,
      lastSuccessAtMs,
      lastError,
      lastAcknowledgedSessionId,
      lastAcknowledgedSequence,
      archivedRoundKeyCount,
      lastCompactionAtMs,
      lastCompactionArchivedCount,
    }
  }

  return {
    tick,
    trigger,
    start,
    stop,
    drain,
    stopAndWait,
    isRunning: () => Boolean(timer),
    snapshot,
  }
}

function sanitizePusherError(value) {
  return String(value ?? 'push_failed')
    .replace(/([?&](?:token|key|secret|password|auth|authorization)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\b(?:authorization\s*:\s*)?bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Authorization: Bearer [redacted]')
    .replace(/\b(token|key|secret|password|authorization)=\S+/gi, '$1=[redacted]')
    .slice(0, 240)
}

function uniqueRoundCandidates(candidates = []) {
  const seen = new Set()
  return candidates.filter((candidate) => {
    if (seen.has(candidate.key)) return false
    seen.add(candidate.key)
    return true
  })
}

function roundKey(round = {}) {
  const tableId = canonicalTableId(round.tableId)
  if (!tableId || round.shoe == null || round.shoe === '' || round.round == null || round.round === '') return null
  return `${tableId}:${round.shoe}:${round.round}`
}

function canonicalTableId(tableId) {
  const id = String(tableId ?? '').trim().toUpperCase()
  const match = id.match(/^BAG(\d{1,2})(A?)$/)
  if (!match) return id
  return `BAG${match[1].padStart(2, '0')}${match[2]}`
}

function normalizeRoundForEnvelope(round = {}, key = '') {
  const [tableId] = String(key).split(':')
  return { ...round, tableId: tableId || canonicalTableId(round.tableId) }
}

async function readAcknowledgement(response, envelope) {
  const status = Number(response?.status)
  if (!Number.isInteger(status) || status < 200 || status >= 300 || typeof response?.json !== 'function') return null
  let body
  try { body = await response.json() } catch { return null }
  const expectedKeys = Array.isArray(envelope?.roundKeys) ? envelope.roundKeys.map(String) : []
  const acceptedKeys = Array.isArray(body?.acceptedRoundKeys) ? body.acceptedRoundKeys.map(String) : []
  if (body?.accepted !== true
    || String(body?.sessionId ?? '') !== String(envelope?.sessionId ?? '')
    || Number(body?.sequence) !== Number(envelope?.sequence)
    || acceptedKeys.length !== expectedKeys.length
    || acceptedKeys.some((roundKeyValue, index) => roundKeyValue !== expectedKeys[index])) return null
  if (envelope?.source && JSON.stringify(normalizeSource(body?.source)) !== JSON.stringify(normalizeSource(envelope.source))) return null
  return { acceptedRoundKeys: acceptedKeys }
}

async function isStaleFenceResponse(response) {
  if (Number(response?.status) !== 409 || typeof response?.json !== 'function') return false
  let body
  try { body = await response.json() } catch { return false }
  return body?.error === 'stale_source_epoch'
}

async function isReconciliationNotFoundResponse(response) {
  if (Number(response?.status) !== 409 || typeof response?.json !== 'function') return false
  let body
  try { body = await response.json() } catch { return false }
  return body?.accepted === false && body?.error === 'capture_reconciliation_not_found'
}

function normalizeRemoteAckReceipt(envelope) {
  const receipt = envelope?.remoteAckReceipt
  const expectedKeys = Array.isArray(envelope?.roundKeys) ? envelope.roundKeys.map(String) : []
  const acceptedRoundKeys = Array.isArray(receipt?.acceptedRoundKeys) ? receipt.acceptedRoundKeys.map(String) : []
  const acknowledgedAtMs = Number(receipt?.acknowledgedAtMs)
  if (String(receipt?.sessionId ?? '') !== String(envelope?.sessionId ?? '')
    || Number(receipt?.sequence) !== Number(envelope?.sequence)
    || acceptedRoundKeys.length !== expectedKeys.length
    || acceptedRoundKeys.some((keyValue, index) => keyValue !== expectedKeys[index])
    || !Number.isSafeInteger(acknowledgedAtMs)) throw new Error('remote_ack_pending_receipt_invalid')
  const normalized = {
    sessionId: String(receipt.sessionId), sequence: Number(receipt.sequence), acceptedRoundKeys, acknowledgedAtMs,
  }
  if (envelope?.source) {
    const source = normalizeSource(receipt?.source)
    if (JSON.stringify(source) !== JSON.stringify(normalizeSource(envelope.source))) throw new Error('remote_ack_pending_receipt_invalid')
    normalized.source = source
  }
  return normalized
}

function normalizeSource(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null
  const normalized = {
    mode: String(source.mode ?? ''), ownerId: String(source.ownerId ?? ''),
    epoch: Number(source.epoch), fence: String(source.fence ?? ''),
  }
  if (!['api', 'browser', 'replay'].includes(normalized.mode)
    || !normalized.ownerId
    || !Number.isSafeInteger(normalized.epoch) || normalized.epoch < 1
    || !normalized.fence) return null
  return normalized
}

function normalizeEventSource(source) {
  const transport = normalizeSource(source)
  const sequence = Number(source?.sequence)
  if (!transport || !Number.isSafeInteger(sequence) || sequence < 1) return null
  return { ...transport, sequence }
}

function sameSourceTransport(eventSource, transportSource) {
  return Boolean(eventSource && transportSource
    && eventSource.mode === transportSource.mode
    && eventSource.ownerId === transportSource.ownerId
    && eventSource.epoch === transportSource.epoch
    && eventSource.fence === transportSource.fence)
}

function compareEventSourceChronology(candidate, current) {
  if (!candidate && !current) return 1
  if (candidate && !current) return 1
  if (!candidate || !current || candidate.mode !== current.mode || candidate.ownerId !== current.ownerId) return null
  if (candidate.epoch !== current.epoch) return candidate.epoch < current.epoch ? -1 : 1
  if (candidate.sequence === current.sequence) return 0
  return candidate.sequence < current.sequence ? -1 : 1
}

function withoutTransport(round = {}) {
  const value = structuredClone(round)
  delete value.source
  delete value.capturedSource
  return value
}
