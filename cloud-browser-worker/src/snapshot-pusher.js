import path from 'node:path'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'

export function createSnapshotPusher({
  targetUrl,
  key,
  getSnapshot,
  fetchImpl = globalThis.fetch,
  queuePath = './data/latest-snapshot.json',
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

  async function tick() {
    if (!targetUrl || !key || typeof getSnapshot !== 'function' || active) return false
    active = true
    try {
      const snapshot = await getSnapshot()
      const timestamp = Number(now())
      const sequence = Math.max(lastSequence + 1, timestamp)
      lastSequence = sequence
      const envelope = { timestamp, sequence, snapshot }
      await saveLatest(envelope)
      if (timestamp < nextAttemptAt) return false

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs)
      try {
        const response = await fetchImpl(targetUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-worker-key': key },
          body: JSON.stringify(envelope),
          signal: controller.signal,
        })
        if (!response?.ok) throw new Error(`push failed with HTTP ${response?.status ?? 'unknown'}`)
        failures = 0
        nextAttemptAt = 0
        await rm(queuePath, { force: true })
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

  async function saveLatest(envelope) {
    await mkdir(path.dirname(queuePath), { recursive: true })
    const temporary = `${queuePath}.tmp`
    await writeFile(temporary, JSON.stringify(envelope), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, queuePath)
  }

  async function restoreSequence() {
    try {
      const queued = JSON.parse(await readFile(queuePath, 'utf8'))
      if (Number.isSafeInteger(queued?.sequence)) lastSequence = Math.max(lastSequence, queued.sequence)
    } catch {}
  }

  function start() {
    if (timer || !targetUrl || !key) return
    void restoreSequence().then(tick)
    timer = setInterval(() => { void tick() }, Math.max(1000, Number(intervalMs) || 5000))
    timer.unref?.()
  }

  function stop() {
    if (timer) clearInterval(timer)
    timer = null
  }

  return { tick, start, stop, isRunning: () => Boolean(timer) }
}
