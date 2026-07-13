import path from 'node:path'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'

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
  now = Date.now,
} = {}) {
  let timer = null
  let failures = 0
  let nextAttemptAt = 0
  let lastSequence = 0
  let active = false
  let restored = false
  let queueInvalid = false
  let pendingEnvelope = null
  const acknowledgedRoundKeys = new Set()
  const missingShoeRoundShoes = new Map()
  let cursorInitialized = false

  async function tick() {
    if (!targetUrl || !key || typeof getSnapshot !== 'function' || active) return false
    active = true
    try {
      await restoreState()
      if (queueInvalid) return false
      const timestamp = Number(now())
      if (timestamp < nextAttemptAt) return false

      if (!pendingEnvelope) {
        const snapshot = await getSnapshot()
        const rounds = Array.isArray(snapshot?.rounds) ? snapshot.rounds : []
        const roundKeys = rounds.map((round) => roundKey(round, snapshot, missingShoeRoundShoes))
        if (!cursorInitialized) {
          for (const key of roundKeys) if (key) acknowledgedRoundKeys.add(key)
          cursorInitialized = true
        }
        trimCursor()
        await saveCursor()
        const sequence = Math.max(lastSequence + 1, timestamp)
        lastSequence = sequence
        const pendingIndexes = roundKeys.map((_key, index) => index).filter((index) => roundKeys[index] && !acknowledgedRoundKeys.has(roundKeys[index]))
        const pendingRoundKeys = pendingIndexes.map((index) => roundKeys[index])
        const pendingRounds = pendingIndexes.map((index) => normalizeRoundForEnvelope(rounds[index], roundKeys[index]))
        pendingEnvelope = {
          protocolVersion: 'v098',
          sessionId: String(snapshot?.sessionId ?? ''),
          timestamp,
          sequence,
          roundKeys: pendingRoundKeys,
          snapshot: { ...snapshot, rounds: pendingRounds },
        }
        await saveJson(queuePath, pendingEnvelope)
      }

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs)
      try {
        const response = await fetchImpl(targetUrl, {
          method: 'POST',
          redirect: 'error',
          headers: { 'content-type': 'application/json', 'x-worker-key': key },
          body: JSON.stringify(pendingEnvelope),
          signal: controller.signal,
        })
        const acknowledgement = await readAcknowledgement(response, pendingEnvelope)
        if (!acknowledgement) throw new Error(`push failed with invalid acknowledgement (${response?.status ?? 'unknown'})`)
        for (const key of acknowledgement.acceptedRoundKeys) acknowledgedRoundKeys.add(key)
        trimCursor()
        await saveCursor()
        failures = 0
        nextAttemptAt = 0
        await rm(queuePath, { force: true })
        pendingEnvelope = null
        return true
      } catch {
        failures += 1
        nextAttemptAt = timestamp + Math.min(maxBackoffMs, baseBackoffMs * (2 ** (failures - 1)))
        return false
      } finally {
        clearTimeout(timeout)
      }
    } finally {
      active = false
    }
  }

  async function saveJson(filePath, value) {
    await mkdir(path.dirname(filePath), { recursive: true })
    const temporary = `${filePath}.tmp`
    await writeFile(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, filePath)
  }

  async function restoreState() {
    if (restored) return
    restored = true
    try {
      const queued = JSON.parse(await readFile(queuePath, 'utf8'))
      if (queued && typeof queued === 'object' && queued.snapshot) pendingEnvelope = queued
      if (Number.isSafeInteger(queued?.sequence)) lastSequence = queued.sequence
    } catch {}
    try {
      const cursor = JSON.parse(await readFile(cursorPath, 'utf8'))
      cursorInitialized = cursor?.initialized === true
      for (const key of cursor?.acknowledgedRoundKeys ?? []) acknowledgedRoundKeys.add(String(key))
      for (const [key, shoe] of cursor?.missingShoeRoundShoes ?? []) missingShoeRoundShoes.set(String(key), String(shoe))
      trimCursor()
    } catch {}
    if (pendingEnvelope) {
      const snapshot = pendingEnvelope.snapshot ?? {}
      const rounds = Array.isArray(snapshot.rounds) ? snapshot.rounds : []
      const keys = rounds.map((round) => roundKey(round, snapshot, missingShoeRoundShoes)).filter(Boolean)
      if (keys.length !== rounds.length) {
        queueInvalid = true
      } else {
        pendingEnvelope = {
          ...pendingEnvelope,
          protocolVersion: 'v098',
          sessionId: String(pendingEnvelope.sessionId ?? snapshot.sessionId ?? ''),
          roundKeys: keys,
          snapshot: { ...snapshot, rounds: rounds.map((round, index) => normalizeRoundForEnvelope(round, keys[index])) },
        }
        await saveJson(queuePath, pendingEnvelope)
      }
    }
  }

  async function saveCursor() {
    await saveJson(cursorPath, {
      version: 1,
      initialized: cursorInitialized,
      acknowledgedRoundKeys: [...acknowledgedRoundKeys],
      missingShoeRoundShoes: [...missingShoeRoundShoes],
    })
  }

  function trimCursor() {
    const limit = Math.max(1, Number(maxCursorEntries) || 10000)
    while (acknowledgedRoundKeys.size > limit) {
      acknowledgedRoundKeys.delete(acknowledgedRoundKeys.values().next().value)
    }
    while (missingShoeRoundShoes.size > limit) {
      missingShoeRoundShoes.delete(missingShoeRoundShoes.keys().next().value)
    }
  }

  function start() {
    if (timer || !targetUrl || !key) return
    void tick()
    timer = setInterval(() => { void tick() }, Math.max(1000, Number(intervalMs) || 5000))
    timer.unref?.()
  }

  function stop() {
    if (timer) clearInterval(timer)
    timer = null
  }

  return { tick, start, stop, isRunning: () => Boolean(timer) }
}

function roundKey(round = {}, snapshot = {}, missingShoeRoundShoes = new Map()) {
  const tableId = canonicalTableId(round.tableId)
  const table = (snapshot.tables ?? []).find((item) => canonicalTableId(item?.tableId) === tableId)
  if (round.shoe != null && round.shoe !== '') return `${tableId}:${round.shoe}:${round.round ?? ''}`

  const eventFingerprint = createHash('sha256')
    .update(stableStringify({
      sourceEventId: round.sourceEventId ?? null,
      sourceAction: round.sourceAction ?? null,
      rawResult: round.rawResult ?? null,
      winner: round.winner ?? null,
      playerPoint: round.playerPoint ?? null,
      bankerPoint: round.bankerPoint ?? null,
    }))
    .digest('hex')
  if (table?.shoe != null && table.shoe !== '') {
    const hasEventIdentity = round.sourceEventId != null
      || round.sourceAction != null
      || round.rawResult != null
      || round.playerPoint != null
      || round.bankerPoint != null
    if (!hasEventIdentity) return `${tableId}:${table.shoe}:${round.round ?? ''}`
    const eventIdentity = round.sourceEventId ?? `${snapshot.sessionId ?? ''}:${eventFingerprint}`
    const identityKey = `${tableId}:${round.round ?? ''}:${eventIdentity}`
    if (!missingShoeRoundShoes.has(identityKey)) missingShoeRoundShoes.set(identityKey, String(table.shoe))
    return `${tableId}:${missingShoeRoundShoes.get(identityKey)}:${round.round ?? ''}`
  }
  return null
}

function canonicalTableId(tableId) {
  const id = String(tableId ?? '').trim().toUpperCase()
  const match = id.match(/^BAG(\d{1,2})(A?)$/)
  if (!match) return id
  return `BAG${match[1].padStart(2, '0')}${match[2]}`
}

function normalizeRoundForEnvelope(round = {}, key = '') {
  const [tableId, shoe] = String(key).split(':')
  return {
    ...round,
    tableId: tableId || canonicalTableId(round.tableId),
    shoe: round.shoe == null || round.shoe === '' ? shoe : round.shoe,
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
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
    || acceptedKeys.some((key, index) => key !== expectedKeys[index])) return null
  return { acceptedRoundKeys: acceptedKeys }
}
