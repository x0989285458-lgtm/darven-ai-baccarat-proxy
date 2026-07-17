import path from 'node:path'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { sanitizeProductionSnapshot } from './table-policy.js'

export function createSnapshotPusher({
  targetUrl,
  key,
  getSnapshot,
  fetchImpl = globalThis.fetch,
  queuePath = './data/latest-snapshot.json',
  cursorPath = `${queuePath}.cursor.json`,
  maxCursorEntries = 10000,
  intervalMs = 5000,
  baseBackoffMs = 1000,
  maxBackoffMs = 60000,
  requestTimeoutMs = 15000,
  isRoundDeliverable = () => true,
  now = Date.now,
} = {}) {
  let timer = null
  let failures = 0
  let nextAttemptAt = 0
  let lastSequence = 0
  let active = false
  let restored = false
  let stateInvalid = false
  let queue = []
  let queueNeedsResequence = false
  let cursorInitialized = false
  const observedRoundKeys = new Set()
  const acknowledgedRoundKeys = new Set()

  async function tick() {
    if (!targetUrl || !key || typeof getSnapshot !== 'function' || active || stateInvalid) return false
    active = true
    try {
      await restoreState()
      if (stateInvalid) return false
      const timestamp = Number(now())
      await collectSnapshot(timestamp)
      if (timestamp < nextAttemptAt || queue.length === 0) return false

      const envelope = { ...queue[0], timestamp }
      queue[0] = envelope
      await saveQueue()
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs)
      try {
        const response = await fetchImpl(targetUrl, {
          method: 'POST',
          redirect: 'error',
          headers: { 'content-type': 'application/json', 'x-worker-key': key },
          body: JSON.stringify(envelope),
          signal: controller.signal,
        })
        const acknowledgement = await readAcknowledgement(response, envelope)
        if (!acknowledgement) throw new Error(`push failed with invalid acknowledgement (${response?.status ?? 'unknown'})`)
        for (const roundKey of acknowledgement.acceptedRoundKeys) acknowledgedRoundKeys.add(roundKey)
        queue.shift()
        trimCursor()
        await saveQueue()
        await saveCursor()
        failures = 0
        nextAttemptAt = 0
        return true
      } catch {
        failures += 1
        nextAttemptAt = timestamp + Math.min(maxBackoffMs, baseBackoffMs * (2 ** (failures - 1)))
        return false
      } finally {
        clearTimeout(timeout)
      }
    } catch (error) {
      stateInvalid = true
      throw error
    } finally {
      active = false
    }
  }

  async function collectSnapshot(timestamp) {
    const snapshot = sanitizeProductionSnapshot(await getSnapshot())
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
      const tail = queue.at(-1)
      const mergedTail = queue.length >= 2 && tail?.sessionId === String(snapshot?.sessionId ?? '')
        ? {
            ...tail,
            timestamp,
            captureTimestamp: timestamp,
            roundKeys: [...tail.roundKeys, ...pendingKeys],
            snapshot: { ...snapshot, rounds: [...(tail.snapshot?.rounds ?? []), ...pendingRounds] },
          }
        : null
      if (mergedTail && Buffer.byteLength(JSON.stringify(mergedTail), 'utf8') <= 768 * 1024) queue[queue.length - 1] = mergedTail
      else queue.push(createEnvelope(snapshot, pendingRounds, pendingKeys, timestamp))
      await saveQueue()
    }
    await saveCursor()
    if (pending.length === 0 && queue.length === 0) {
      queue.push(createEnvelope(snapshot, [], [], timestamp))
      await saveQueue()
    }
  }

  function createEnvelope(snapshot, rounds, roundKeys, timestamp) {
    const sequence = Math.max(lastSequence + 1, timestamp)
    lastSequence = sequence
    return {
      protocolVersion: 'v100',
      sessionId: String(snapshot?.sessionId ?? ''),
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
          const normalizedEntries = entries.map(normalizeQueuedEnvelope)
          queue = normalizedEntries.filter((item) => !item.drop).map((item) => item.envelope)
          queueNeedsResequence = normalizedEntries.some((item) => item.changed)
          for (const entry of queue) lastSequence = Math.max(lastSequence, entry.sequence)
        } catch (error) {
          await quarantineState(queuePath, 'queue', error)
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
      text = await readFile(filePath, 'utf8')
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
      protocolVersion: 'v100',
      sessionId: String(envelope.sessionId ?? snapshot.sessionId ?? ''),
      timestamp: Number(envelope.timestamp),
      captureTimestamp,
      sequence: Number(envelope.sequence),
      roundKeys: keys,
      snapshot: { ...snapshot, rounds: keyedRounds.map(({ round, key }) => normalizeRoundForEnvelope(round, key)) },
    }
    const changed = JSON.stringify(normalizedEnvelope.snapshot) !== JSON.stringify(originalSnapshot)
      || JSON.stringify(keys) !== JSON.stringify(originalKeys)
    return { envelope: normalizedEnvelope, changed, drop: originalRounds.length > 0 && keyedRounds.length === 0 }
  }

  async function saveJson(filePath, value) {
    await mkdir(path.dirname(filePath), { recursive: true })
    const temporary = `${filePath}.tmp`
    await writeFile(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, filePath)
  }

  async function saveQueue() {
    if (queue.length === 0) {
      await rm(queuePath, { force: true })
      return
    }
    await saveJson(queuePath, { version: 2, entries: queue })
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
    void tick().catch(() => stop())
    timer = setInterval(() => { void tick().catch(() => stop()) }, Math.max(1000, Number(intervalMs) || 5000))
    timer.unref?.()
  }

  function stop() {
    if (timer) clearInterval(timer)
    timer = null
  }

  return { tick, start, stop, isRunning: () => Boolean(timer) }
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
  return { acceptedRoundKeys: acceptedKeys }
}
