import crypto from 'node:crypto'
import path from 'node:path'
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'

export function createMemoryLeaseStore(initial = null) {
  let state = initial == null ? null : structuredClone(initial)
  let tail = Promise.resolve()
  return {
    async read() {
      await tail
      return state == null ? null : structuredClone(state)
    },
    async transact(update) {
      const operation = tail.then(async () => {
        const next = await update(state == null ? null : structuredClone(state))
        state = next == null ? null : structuredClone(next)
        return state == null ? null : structuredClone(state)
      })
      tail = operation.catch(() => {})
      return operation
    },
  }
}

const CURRENT_PROCESS_START_IDENTITY = `node-start-${Date.now()}-${crypto.randomUUID()}`

export function createFileLeaseStore(leasePath, {
  lockRetryMs = 5,
  lockTimeoutMs = 2_000,
  processIdentity = defaultProcessIdentity,
  inspectProcessIdentity = defaultInspectProcessIdentity,
} = {}) {
  const target = String(leasePath ?? '').trim()
  if (!target) throw new Error('source_owner_lease_path_required')
  const lockPath = `${target}.lock`

  async function read() {
    try {
      return JSON.parse(await readFile(target, 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw new Error('source_owner_lease_corrupt', { cause: error })
    }
  }

  async function transact(update) {
    await mkdir(path.dirname(target), { recursive: true })
    const lock = await acquireFileLock(lockPath, { lockRetryMs, lockTimeoutMs, processIdentity, inspectProcessIdentity })
    try {
      const current = await read()
      const next = await update(current == null ? null : structuredClone(current))
      if (next == null) {
        await rm(target, { force: true })
        return null
      }
      const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
      await writeFile(temporary, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, target)
      return structuredClone(next)
    } finally {
      await lock.close().catch(() => {})
    }
  }

  return { read, transact }
}

export function createWorkerSourceOwner({
  store,
  ownerId,
  mode,
  leaseMs = 15_000,
  now = Date.now,
  createFence = () => crypto.randomUUID(),
} = {}) {
  if (!store || typeof store.read !== 'function' || typeof store.transact !== 'function') throw new Error('source_owner_store_required')
  if (!String(ownerId ?? '').trim()) throw new Error('source_owner_id_required')
  if (!['api', 'browser'].includes(mode)) throw new Error('source_owner_mode_invalid')
  let activeLease = null

  async function acquire() {
    const acquired = await store.transact((current) => {
      if (current) throw new Error('source_owner_lease_held')
      if (mode !== 'api') throw new Error('browser_requires_cold_takeover')
      return makeLease({ epoch: 1 })
    })
    activeLease = acquired
    return structuredClone(acquired)
  }

  async function acquireOrRecover() {
    const acquired = await store.transact((current) => {
      if (!current) {
        if (mode !== 'api') throw new Error('browser_requires_cold_takeover')
        return makeLease({ epoch: 1 })
      }
      if (mode !== 'api') throw new Error('browser_requires_cold_takeover')
      if (current.status === 'active' && Number(current.expiresAt) > Number(now())) throw new Error('source_owner_lease_held')
      return makeLease({ epoch: Number(current.epoch) + 1 })
    })
    activeLease = acquired
    return structuredClone(acquired)
  }

  async function renew(candidate = activeLease) {
    const renewed = await store.transact((current) => {
      assertMatches(current, candidate)
      if (current.status !== 'active') throw new Error('source_owner_not_active')
      return { ...current, expiresAt: Number(now()) + normalizedLeaseMs() }
    })
    activeLease = renewed
    return structuredClone(renewed)
  }

  async function stop(candidate = activeLease) {
    const stopped = await store.transact((current) => {
      assertMatches(current, candidate)
      return { ...current, status: 'stopped', stoppedAt: Number(now()), expiresAt: Number(now()) }
    })
    activeLease = null
    return structuredClone(stopped)
  }

  async function takeover({ previous } = {}) {
    const acquired = await store.transact((current) => {
      assertMatches(current, previous)
      if (mode !== 'browser') throw new Error('source_owner_takeover_mode_invalid')
      if (current.status !== 'stopped') throw new Error('source_owner_not_stopped')
      return makeLease({ epoch: Number(current.epoch) + 1 })
    })
    activeLease = acquired
    return structuredClone(acquired)
  }

  function assertCurrent(candidate = activeLease) {
    assertMatches(activeLease, candidate)
    if (candidate?.status !== 'active' || Number(candidate.expiresAt) <= Number(now())) throw new Error('stale_source_fence')
    return true
  }

  function eventSource(sequence, candidate = activeLease) {
    assertCurrent(candidate)
    if (!Number.isSafeInteger(Number(sequence)) || Number(sequence) < 1) throw new Error('source_sequence_invalid')
    return {
      mode,
      ownerId: String(ownerId),
      epoch: Number(candidate.epoch),
      fence: String(candidate.fence),
      sequence: Number(sequence),
    }
  }

  async function nextEventSource(candidate = activeLease) {
    const updated = await store.transact((current) => {
      assertMatches(current, candidate)
      if (current.status !== 'active' || Number(current.expiresAt) <= Number(now())) throw new Error('stale_source_fence')
      return { ...current, eventSequence: Number(current.eventSequence ?? 0) + 1 }
    })
    activeLease = updated
    return eventSource(updated.eventSequence, updated)
  }

  function restore(candidate) {
    if (!candidate || candidate.ownerId !== String(ownerId) || candidate.mode !== mode || candidate.status !== 'active') {
      throw new Error('stale_source_fence')
    }
    activeLease = structuredClone(candidate)
    return structuredClone(activeLease)
  }

  function makeLease({ epoch }) {
    return {
      version: 1,
      ownerId: String(ownerId),
      mode,
      epoch,
      fence: String(createFence()),
      status: 'active',
      eventSequence: 0,
      acquiredAt: Number(now()),
      expiresAt: Number(now()) + normalizedLeaseMs(),
    }
  }

  function normalizedLeaseMs() {
    return Math.max(1, Number(leaseMs) || 1)
  }

  return { acquire, acquireOrRecover, renew, stop, takeover, assertCurrent, eventSource, nextEventSource, restore, lease: () => activeLease && structuredClone(activeLease) }
}

function assertMatches(current, expected) {
  if (!current || !expected
    || current.ownerId !== expected.ownerId
    || current.mode !== expected.mode
    || Number(current.epoch) !== Number(expected.epoch)
    || current.fence !== expected.fence) throw new Error('stale_source_fence')
}

async function acquireFileLock(lockPath, { lockRetryMs, lockTimeoutMs, processIdentity, inspectProcessIdentity }) {
  const deadline = Date.now() + Math.max(1, Number(lockTimeoutMs) || 1)
  do {
    try {
      const handle = await open(lockPath, 'wx', 0o600)
      try {
        const identity = normalizeProcessIdentity(await processIdentity())
        const metadata = {
          version: 1,
          lockId: crypto.randomUUID(),
          pid: identity.pid,
          processStartIdentity: identity.processStartIdentity,
          createdAt: Date.now(),
        }
        await handle.writeFile(JSON.stringify(metadata), 'utf8')
        await handle.sync()
        return {
          async close() {
            await handle.close()
            await removeOwnedLock(lockPath, metadata)
          },
        }
      } catch (error) {
        await handle.close().catch(() => {})
        await rm(lockPath, { force: true }).catch(() => {})
        throw error
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      if (await recoverProvenOrphanLock(lockPath, inspectProcessIdentity)) continue
      if (Date.now() >= deadline) throw new Error('source_owner_lock_timeout')
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, Number(lockRetryMs) || 1)))
    }
  } while (true)
}

async function recoverProvenOrphanLock(lockPath, inspectProcessIdentity) {
  let metadata
  try { metadata = normalizeLockMetadata(JSON.parse(await readFile(lockPath, 'utf8'))) } catch { return false }
  let observed
  try { observed = await inspectProcessIdentity(metadata.pid) } catch { return false }
  if (observed !== null && (observed === undefined || String(observed) === metadata.processStartIdentity)) return false
  const quarantine = `${lockPath}.orphan.${metadata.lockId}.${crypto.randomUUID()}`
  try {
    await rename(lockPath, quarantine)
    const moved = normalizeLockMetadata(JSON.parse(await readFile(quarantine, 'utf8')))
    if (moved.lockId !== metadata.lockId) throw new Error('source_owner_lock_changed')
    await rm(quarantine, { force: true })
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return true
    await rename(quarantine, lockPath).catch(() => {})
    return false
  }
}

async function removeOwnedLock(lockPath, metadata) {
  try {
    const current = normalizeLockMetadata(JSON.parse(await readFile(lockPath, 'utf8')))
    if (current.lockId === metadata.lockId) await rm(lockPath, { force: true })
  } catch {}
}

function normalizeLockMetadata(value) {
  if (!value || value.version !== 1 || typeof value.lockId !== 'string' || !value.lockId
    || !Number.isSafeInteger(Number(value.pid)) || Number(value.pid) < 1
    || typeof value.processStartIdentity !== 'string' || !value.processStartIdentity
    || !Number.isFinite(Number(value.createdAt))) throw new Error('source_owner_lock_metadata_invalid')
  return { ...value, pid: Number(value.pid), createdAt: Number(value.createdAt) }
}

function normalizeProcessIdentity(value) {
  if (!value || !Number.isSafeInteger(Number(value.pid)) || Number(value.pid) < 1
    || !String(value.processStartIdentity ?? '')) throw new Error('source_owner_process_identity_invalid')
  return { pid: Number(value.pid), processStartIdentity: String(value.processStartIdentity) }
}

async function defaultProcessIdentity() {
  return { pid: process.pid, processStartIdentity: await defaultInspectProcessIdentity(process.pid) ?? CURRENT_PROCESS_START_IDENTITY }
}

async function defaultInspectProcessIdentity(pid) {
  if (process.platform === 'linux') {
    try {
      const stat = await readFile(`/proc/${Number(pid)}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
      return fields[19] ? `linux-start-${fields[19]}` : undefined
    } catch (error) {
      return error?.code === 'ENOENT' ? null : undefined
    }
  }
  if (Number(pid) === process.pid) return CURRENT_PROCESS_START_IDENTITY
  try { process.kill(Number(pid), 0); return undefined } catch (error) {
    return error?.code === 'ESRCH' ? null : undefined
  }
}
