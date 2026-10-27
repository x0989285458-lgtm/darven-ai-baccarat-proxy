import { PRODUCTION_TABLE_IDS } from './table-policy.js'
import { writeFile, rename } from 'node:fs/promises'

export const CAPACITY = 128
export const MAX_SNAPSHOT_BYTES = 65536
export const CADENCE_MS = 1000
const EVENTS = new Set(['socket_open','socket_error','socket_close','socket_open_timeout','auth_timeout','auth_ok','auth_rejected','join_ok','join_protocol_rejected','join_rejected','reconnect_scheduled','refresh_start','refresh_ok','refresh_failed','refresh_retry','tables_requested','catalog_rejected','final_reject_invalid','final_reject_room','final_reject_join','final_reject_shoe','final_reject_retired_shoe','final_received','final_delivered','final_callback_failed','message_failed','stop','journal_append_ok','journal_append_failed','final_skip_ack','final_skip_warmup','final_gap','final_gap_failed','final_reject_cursor'])
const ROLES = new Set(['game','chat'])
const STATES = new Set(['current','stale','stopped','closing'])
const CLOSE_CODES = new Set([1000,1001,1002,1003,1005,1006,1007,1008,1009,1010,1011,1012,1013,1014,1015])
// Never copy input objects, coerce values, stringify unknown data, or retain raw errors.
export function sanitizeDiagnostic(value) {
  try {
    if (!value || typeof value !== 'object') return null
    const input = Object.create(null)
    for (const key of ['event','role','state','generation','delayMs','code','tableId','shoe','round']) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor && Object.hasOwn(descriptor, 'value')) input[key] = descriptor.value
    }
    if (!input || !EVENTS.has(input.event)) return null
    const event = { event: input.event }
    if (ROLES.has(input.role)) event.role = input.role
    if (STATES.has(input.state)) event.state = input.state
    if (Number.isSafeInteger(input.generation) && input.generation >= 0) event.generation = input.generation
    if (Number.isSafeInteger(input.delayMs) && input.delayMs >= 0 && input.delayMs <= 86400000) event.delayMs = input.delayMs
    if (CLOSE_CODES.has(input.code)) event.code = input.code
    if ((event.event.startsWith('final_') || event.event.startsWith('journal_')) && PRODUCTION_TABLE_IDS.includes(input.tableId)) {
      event.tableId = input.tableId
      if (Number.isSafeInteger(input.shoe) && input.shoe >= 0) event.shoe = input.shoe
      if (Number.isSafeInteger(input.round) && input.round >= 0) event.round = input.round
    }
    return event
  } catch { return null }
}
// Observer promises are handled but never awaited; no pending-promise registry.
export function emitDiagnostic(callback, input) {
  try {
    const event = sanitizeDiagnostic(input)
    if (!event) return
    const result = callback(event)
    if (result && typeof result.catch === 'function') result.catch(() => {})
  } catch {}
}
async function atomicSnapshot(path, text) {
  await writeFile(`${path}.tmp`, text, { encoding: 'utf8', mode: 0o600 })
  await rename(`${path}.tmp`, path)
}
// Best effort, NOT zero-loss: overwrite oldest; no exit flush or retry queue.
// Exactly two fixed filenames, <=2*MAX_SNAPSHOT_BYTES; one in-flight snapshot.
export function createDiagnosticSink({ path, writeSnapshot = atomicSnapshot, setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
  const ring = new Array(CAPACITY)
  let head = 0, size = 0, sequence = 0, dirty = false, busy = false, stopped = false, writeFailures = 0
  function record(input) {
    if (stopped) return
    const event = sanitizeDiagnostic(input)
    if (!event) return
    sequence = Math.min(Number.MAX_SAFE_INTEGER, sequence + 1)
    ring[head] = { ...event, sequence, atMs: Date.now() }
    head = (head + 1) % CAPACITY
    size = Math.min(CAPACITY, size + 1)
    dirty = true
  }
  async function tick() {
    if (stopped || busy || !dirty) return
    busy = true
    dirty = false
    try {
      const events = Array.from({length:size}, (_, i) => ring[(head - size + i + CAPACITY) % CAPACITY])
      const text = JSON.stringify({ version:1, writeFailures, events })
      if (Buffer.byteLength(text) > MAX_SNAPSHOT_BYTES) throw new Error('diagnostic_snapshot_bound')
      await writeSnapshot(path, text)
    } catch {
      writeFailures = Math.min(Number.MAX_SAFE_INTEGER, writeFailures + 1)
      dirty = true
    } finally { busy = false }
  }
  const timer = setIntervalFn(tick, CADENCE_MS)
  timer?.unref?.()
  return { record, stop() { stopped = true; clearIntervalFn(timer) }, snapshot: () => ({ size, busy, writeFailures, stopped }) }
}
