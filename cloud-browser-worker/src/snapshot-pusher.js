import path from 'node:path'
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { gzip, gunzip } from 'node:zlib'
import { sanitizeProductionSnapshot } from './table-policy.js'
import { BUILD_VERSION } from './runtime-config.js'

const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)

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
  maxRoundsPerEnvelope = 5,
  maxRoundsPerDelivery = maxRoundsPerEnvelope,
  queueCompressionThresholdBytes = 1024 * 1024,
  queueJournalThresholdEntries = 100,
  isRoundDeliverable = () => true,
  now = Date.now,
} = {}) {
  const roundLimit = Math.max(1, Number(maxRoundsPerEnvelope) || 5)
  const deliveryRoundLimit = Math.max(roundLimit, Number(maxRoundsPerDelivery) || roundLimit)
  const journalThreshold = Math.max(1, Number(queueJournalThresholdEntries) || 100)
  const journalPath = `${queuePath}.journal`
  let timer = null
  let failures = 0
  let nextAttemptAt = 0
  let lastSequence = 0
  let active = false
  let restored = false
  let stateInvalid = false
  let queue = []
  let queueNeedsSave = false
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

      const delivery = buildDeliveryEnvelope(timestamp)
      const envelope = delivery.envelope
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
        queue.splice(0, delivery.entryCount)
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

  function buildDeliveryEnvelope(timestamp) {
    const head = queue[0]
    if (!head) return { envelope: null, entryCount: 0 }
    if (!Array.isArray(head.roundKeys) || head.roundKeys.length === 0) {
      return { envelope: { ...head, timestamp }, entryCount: 1 }
    }
    let entryCount = 0
    let roundKeys = []
    let rounds = []
    let envelope = { ...head, timestamp }
    for (const entry of queue.slice(0, deliveryRoundLimit)) {
      if (entry.sessionId !== head.sessionId || entry.protocolVersion !== head.protocolVersion) break
      const entryKeys = Array.isArray(entry.roundKeys) ? entry.roundKeys : []
      const entryRounds = Array.isArray(entry.snapshot?.rounds) ? entry.snapshot.rounds : []
      if (roundKeys.length + entryKeys.length > deliveryRoundLimit) break
      const candidate = {
        ...entry,
        timestamp,
        sequence: entry.sequence,
        roundKeys: [...roundKeys, ...entryKeys],
        snapshot: { ...entry.snapshot, rounds: [...rounds, ...entryRounds] },
      }
      if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > 768 * 1024) break
      envelope = candidate
      roundKeys = candidate.roundKeys
      rounds = candidate.snapshot.rounds
      entryCount += 1
    }
    return { envelope, entryCount: Math.max(1, entryCount) }
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
      const useJournal = queue.length + Math.ceil(pendingKeys.length / roundLimit) >= journalThreshold
      const journalEntries = []
      for (let offset = 0; offset < pendingKeys.length;) {
        const tail = queue.at(-1)
        const tailSpace = !useJournal && queue.length >= 2 && tail?.sessionId === String(snapshot?.sessionId ?? '')
          ? Math.max(0, roundLimit - tail.roundKeys.length)
          : 0
        if (tailSpace > 0) {
          const count = Math.min(tailSpace, pendingKeys.length - offset)
          const mergedTail = {
            ...tail,
            timestamp,
            captureTimestamp: timestamp,
            roundKeys: [...tail.roundKeys, ...pendingKeys.slice(offset, offset + count)],
            snapshot: { ...snapshot, rounds: [...(tail.snapshot?.rounds ?? []), ...pendingRounds.slice(offset, offset + count)] },
          }
          if (Buffer.byteLength(JSON.stringify(mergedTail), 'utf8') <= 768 * 1024) {
            queue[queue.length - 1] = mergedTail
            offset += count
            continue
          }
        }
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
    await saveCursor()
    if (pending.length === 0 && queue.length === 0) {
      queue.push(createEnvelope(snapshot, [], [], timestamp))
      await saveQueue()
    }
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
    const serialized = JSON.stringify({ version: 2, entries: queue })
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
