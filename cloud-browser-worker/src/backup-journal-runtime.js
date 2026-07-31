import { readFile } from 'node:fs/promises'
import { sessionTokenFingerprint } from './record-replay.js'
import { canonicalProductionTableId, sortProductionTables } from './table-policy.js'
import { updateSourceProgressTracker } from './worker-health.js'

export function createBackupJournalRuntime({
  tokenFile,
  journal,
  ownerId,
  createApiClient,
  now = () => new Date().toISOString(),
  readToken = () => readFile(String(tokenFile ?? ''), 'utf8'),
} = {}) {
  const owner = String(ownerId ?? '').trim()
  if (!journal || typeof journal.writeHeader !== 'function' || typeof journal.append !== 'function'
    || !owner || typeof createApiClient !== 'function') throw new Error('backup_journal_runtime_dependencies_required')
  let client = null
  let started = false
  let token = null
  let fingerprint = null
  let sequence = 0
  let tables = []
  let lastFinalAt = null
  let lastError = null
  let sourceProgressTracker = null
  const observedTables = new Map()
  const pendingClosures = new Map()

  async function start() {
    if (started) return
    try {
      if (!String(tokenFile ?? '').trim()) throw new Error('second_independent_session_token_required')
      token = String(await readToken()).trim()
      if (!token) throw new Error('second_independent_session_token_required')
      fingerprint = sessionTokenFingerprint(token)
      await journal.writeHeader({ sessionFingerprint: fingerprint, ownerId: owner })
      sequence = journal.pending().reduce((maximum, entry) => (
        entry?.event?.source?.ownerId === owner ? Math.max(maximum, Number(entry.event.source.sequence) || 0) : maximum
      ), 0)
      const sourceOwner = createReadOnlyJournalSource()
      const sessionManager = {
        getSessionToken: async () => token,
        refresh: async () => { throw new Error('backup_session_refresh_requires_external_token_rotation') },
      }
      client = createApiClient({ sourceOwner, sessionManager, onFinal, onTables, onError })
      await client.start()
      started = true
      lastError = null
    } catch (error) {
      client?.stop?.()
      client = null
      started = false
      token = null
      fingerprint = null
      lastError = normalizeError(error)
      if (lastError !== 'second_independent_session_token_required' && /ENOENT|session_token_required/.test(String(error?.message ?? error))) {
        lastError = 'second_independent_session_token_required'
      }
      throw new Error(lastError, { cause: error })
    }
  }

  async function stop() {
    client?.stop?.()
    client = null
    token = null
    started = false
  }

  async function onFinal(event) {
    const source = await createReadOnlyJournalSource().nextEventSource()
    await journal.append({ ...event, source })
    lastFinalAt = now()
    sourceProgressTracker = updateSourceProgressTracker(sourceProgressTracker, { snapshotAt: lastFinalAt, tables, rounds: [event] })
  }

  async function onTables(nextTables) {
    tables = uniqueTables(sortProductionTables((Array.isArray(nextTables) ? nextTables : []).map((table) => ({
      ...table,
      tableId: canonicalProductionTableId(table?.tableId ?? table?.table_id),
      shoe: Number(table?.shoe),
      round: Number(table?.round),
    }))))
    for (const table of tables) {
      const previous = observedTables.get(table.tableId)
      if (previous && Number(table.shoe) > Number(previous.shoe) && Number.isSafeInteger(Number(previous.round)) && Number(previous.round) >= 1) {
        pendingClosures.set(`${table.tableId}:${previous.shoe}`, { tableId: table.tableId, shoe: Number(previous.shoe), finalRound: Number(previous.round) })
      }
      if (!previous || Number(table.shoe) >= Number(previous.shoe)) observedTables.set(table.tableId, { shoe: Number(table.shoe), round: Number(table.round) })
    }
    await closeContinuousShoes()
    sourceProgressTracker = updateSourceProgressTracker(sourceProgressTracker, { snapshotAt: now(), tables, rounds: [] })
  }

  async function closeContinuousShoes() {
    const available = new Set(journal.pending().map((entry) => entry.identity))
    for (const [key, marker] of pendingClosures) {
      let continuous = true
      for (let round = 1; round <= marker.finalRound; round += 1) {
        if (!available.has(`${marker.tableId}:${marker.shoe}:${round}`)) { continuous = false; break }
      }
      if (!continuous) continue
      await journal.closeShoe(marker)
      pendingClosures.delete(key)
    }
  }

  function createReadOnlyJournalSource() {
    return {
      lease: () => ({ mode: 'backup', ownerId: owner, epoch: 1, fence: fingerprint, status: 'active', expiresAt: Number.MAX_SAFE_INTEGER }),
      assertCurrent: () => true,
      async nextEventSource() {
        sequence += 1
        return { mode: 'backup', ownerId: owner, epoch: 1, fence: fingerprint, sequence }
      },
    }
  }

  function onError(value) {
    lastError = normalizeError(value)
  }

  function snapshot() {
    const api = client?.snapshot?.() ?? {}
    return {
      role: 'backup-journal',
      started,
      connected: api.connected === true,
      authenticated: api.authenticated === true,
      joined: api.joined === true,
      tableCount: tables.length,
      lastMessageAt: api.lastMessageAt ?? null,
      lastFinalAt,
      ...(sourceProgressTracker?.sourceProgressAt ? { sourceProgressAt: sourceProgressTracker.sourceProgressAt } : {}),
      lastError,
    }
  }

  return { start, stop, snapshot }
}

function normalizeError(error) {
  const value = String(error?.message ?? error ?? 'backup_journal_runtime_failed')
  return /ENOENT|session_token_required/.test(value) ? 'second_independent_session_token_required' : value.slice(0, 160)
}

function uniqueTables(values) {
  return [...new Map(values.map((table) => [table.tableId, table])).values()]
}
