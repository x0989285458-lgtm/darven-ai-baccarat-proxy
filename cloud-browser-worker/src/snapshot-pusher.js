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
  let pendingEnvelope = null
  const acknowledgedRoundKeys = new Set()
  const missingShoeRoundShoes = new Map()
  let cursorInitialized = false

  async function tick() {
    if (!targetUrl || !key || typeof getSnapshot !== 'function' || active) return false
    active = true
    try {
      await restoreState()
      const timestamp = Number(now())
      if (timestamp < nextAttemptAt) return false

      if (!pendingEnvelope) {
        const snapshot = await getSnapshot()
        const rounds = Array.isArray(snapshot?.rounds) ? snapshot.rounds : []
        const roundKeys = rounds.map((round) => roundKey(round, snapshot, missingShoeRoundShoes))
        if (!cursorInitialized) {
          for (const key of roundKeys) acknowledgedRoundKeys.add(key)
          cursorInitialized = true
        }
        trimCursor()
        await saveCursor()
        const sequence = Math.max(lastSequence + 1, timestamp)
        lastSequence = sequence
        pendingEnvelope = {
          timestamp,
          sequence,
          snapshot: { ...snapshot, rounds: rounds.filter((_round, index) => !acknowledgedRoundKeys.has(roundKeys[index])) },
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
        if (!isAcknowledgement(response)) throw new Error(`push failed with HTTP ${response?.status ?? 'unknown'}`)
        for (const round of pendingEnvelope.snapshot?.rounds ?? []) {
          acknowledgedRoundKeys.add(roundKey(round, pendingEnvelope.snapshot, missingShoeRoundShoes))
        }
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
  if (round.shoe != null && round.shoe !== '') return `${tableId}:shoe:${round.shoe}:${round.round ?? ''}`

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
    if (!hasEventIdentity) return `${tableId}:shoe:${table.shoe}:${round.round ?? ''}`
    const eventIdentity = round.sourceEventId ?? `${snapshot.sessionId ?? ''}:${eventFingerprint}`
    const identityKey = `${tableId}:${round.round ?? ''}:${eventIdentity}`
    if (!missingShoeRoundShoes.has(identityKey)) missingShoeRoundShoes.set(identityKey, String(table.shoe))
    return `${tableId}:shoe:${missingShoeRoundShoes.get(identityKey)}:${round.round ?? ''}`
  }
  return `${tableId}:session:${snapshot.sessionId ?? ''}:event:${eventFingerprint}:${round.round ?? ''}`
}

function canonicalTableId(tableId) {
  const id = String(tableId ?? '').trim().toUpperCase()
  const match = id.match(/^BAG(\d{1,2})(A?)$/)
  if (!match) return id
  return `BAG${match[1].padStart(2, '0')}${match[2]}`
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function isAcknowledgement(response) {
  const status = Number(response?.status)
  return Number.isInteger(status) && status >= 200 && status < 300
}
