import crypto from 'node:crypto'
import path from 'node:path'
import { mkdir, open, readFile } from 'node:fs/promises'
import { isExactTenRawResult, isVerifiedFinalRoundAction } from '../../shared/real-card-validator.js'
import { canonicalProductionTableId, PRODUCTION_TABLE_IDS } from './table-policy.js'

export async function createFinalJournal({ journalPath, assertSource = () => true } = {}) {
  const target = String(journalPath ?? '').trim()
  if (!target) throw new Error('final_journal_path_required')
  const finals = new Map()
  const acknowledgements = new Map()
  const cursors = new Map()
  const cursorOrders = new Map()
  const retiredCursorShoes = new Map()
  const closedShoes = new Map()
  let nextFinalOrder = 0
  let journalHeader = null
  let tail = Promise.resolve()

  await restore()

  async function append(event) {
    return serialize(async () => {
      await assertSource(event?.source)
      const normalized = normalizeFinal(event)
      const identity = finalIdentity(normalized)
      const hash = finalHash(normalized)
      const current = finals.get(identity)
      if (current) {
        if (current.hash !== hash) throw new Error('final_identity_payload_conflict')
        return { status: 'duplicate', identity, hash, event: structuredClone(current.event) }
      }
      const record = { version: 1, type: 'final', identity, hash, event: normalized }
      await appendRecord(record)
      finals.set(identity, { hash, event: normalized, order: ++nextFinalOrder })
      return { status: 'appended', identity, hash, event: structuredClone(normalized) }
    })
  }

  async function ack(identityValue, hashValue) {
    return serialize(async () => {
      const identity = String(identityValue ?? '')
      const current = finals.get(identity)
      if (!current || current.hash !== String(hashValue ?? '')) throw new Error('final_ack_mismatch')
      const acknowledgedHash = acknowledgements.get(identity)
      if (acknowledgedHash) {
        if (acknowledgedHash !== current.hash) throw new Error('final_ack_conflict')
        return { status: 'duplicate', identity, hash: current.hash }
      }
      await appendRecord({ version: 1, type: 'ack', identity, hash: current.hash })
      applyAck(identity, current.hash)
      return { status: 'acknowledged', identity, hash: current.hash }
    })
  }

  async function ackMany(claims = []) {
    return serialize(async () => {
      if (!Array.isArray(claims)) throw new Error('final_ack_batch_invalid')
      const unique = new Map()
      for (const claim of claims) {
        const identity = String(claim?.identity ?? '')
        const hash = String(claim?.hash ?? '')
        const prior = unique.get(identity)
        if (prior && prior !== hash) throw new Error('final_ack_conflict')
        unique.set(identity, hash)
      }
      const pending = []
      let duplicates = 0
      for (const [identity, hash] of unique) {
        const current = finals.get(identity)
        if (!current || current.hash !== hash) throw new Error('final_ack_mismatch')
        const acknowledgedHash = acknowledgements.get(identity)
        if (acknowledgedHash) {
          if (acknowledgedHash !== current.hash) throw new Error('final_ack_conflict')
          duplicates += 1
        } else pending.push({ identity, hash: current.hash })
      }
      await appendRecords(pending.map(({ identity, hash }) => ({ version: 1, type: 'ack', identity, hash })))
      for (const { identity, hash } of pending) applyAck(identity, hash)
      return { acknowledged: pending.length, duplicates }
    })
  }

  async function closeShoe({ tableId: tableIdValue, shoe: shoeValue, finalRound: finalRoundValue } = {}) {
    return serialize(async () => {
      const tableId = canonicalProductionTableId(tableIdValue)
      const shoe = Number(shoeValue)
      const finalRound = Number(finalRoundValue)
      if (!PRODUCTION_TABLE_IDS.includes(tableId) || !Number.isSafeInteger(shoe)
        || !Number.isSafeInteger(finalRound) || finalRound < 1) throw new Error('shoe_closed_marker_invalid')
      const key = `${tableId}:${shoe}`
      const marker = { tableId, shoe, finalRound }
      const hash = markerHash(marker)
      const current = closedShoes.get(key)
      if (current) {
        if (current.hash !== hash) throw new Error('shoe_closed_marker_conflict')
        return { status: 'duplicate', ...marker, hash }
      }
      await appendRecord({ version: 1, type: 'shoe_closed', ...marker, hash })
      closedShoes.set(key, { ...marker, hash })
      return { status: 'appended', ...marker, hash }
    })
  }

  async function rebindPending(allocateSource, targetSource = null) {
    if (typeof allocateSource !== 'function') throw new Error('final_rebind_allocator_required')
    return serialize(async () => {
      const rebound = []
      for (const [identity, current] of finals) {
        if (acknowledgements.has(identity) || sameTransportOwner(current.event.source, targetSource)) continue
        const source = normalizeTransportSource(await allocateSource({ identity, hash: current.hash, event: structuredClone(current.event) }))
        if (targetSource && !sameTransportOwner(source, targetSource)) throw new Error('final_rebind_source_mismatch')
        const capturedSource = normalizeTransportSource(current.event.capturedSource ?? current.event.source)
        const event = normalizeFinal({ ...current.event, capturedSource, source })
        if (finalHash(event) !== current.hash) throw new Error('final_rebind_payload_changed')
        await appendRecord({ version: 1, type: 'rebind', identity, hash: current.hash, capturedSource, source })
        finals.set(identity, { hash: current.hash, event, order: current.order })
        rebound.push({ identity, hash: current.hash, event: structuredClone(event) })
      }
      return rebound
    })
  }

  async function writeHeader(value) {
    return serialize(async () => {
      const header = normalizeJournalHeader(value)
      if (journalHeader) {
        if (JSON.stringify(journalHeader) !== JSON.stringify(header)) throw new Error('final_journal_header_conflict')
        return { status: 'duplicate', ...header }
      }
      if (finals.size > 0 || acknowledgements.size > 0 || closedShoes.size > 0) throw new Error('final_journal_header_must_be_first')
      await appendRecord({ version: 1, type: 'header', ...header })
      journalHeader = header
      return { status: 'appended', ...header }
    })
  }

  async function bootstrapFromSnapshotPusherCursor(value) {
    return serialize(async () => {
      const candidates = normalizeSnapshotPusherAckCursors(value)
      const missing = candidates.filter(({ tableId }) => !cursors.has(tableId))
      if (missing.length === 0) return { status: candidates.length === 0 ? 'empty' : 'duplicate', cursors: [] }
      const record = {
        version: 1,
        type: 'cursor_bootstrap',
        origin: 'snapshot-pusher-exact-ack-cursor',
        cursors: missing,
      }
      await appendRecord(record)
      applyCursorBootstrap(record)
      return { status: 'appended', cursors: structuredClone(missing) }
    })
  }

  function pending() {
    return [...finals.entries()]
      .filter(([identity]) => !acknowledgements.has(identity))
      .map(([identity, value]) => ({ identity, hash: value.hash, event: structuredClone(value.event) }))
  }

  function cursor(tableId) {
    const value = cursors.get(canonicalProductionTableId(tableId))
    return value ? structuredClone(value) : null
  }

  function status(identityValue) {
    const identity = String(identityValue ?? '')
    const current = finals.get(identity)
    if (!current) return null
    return {
      identity, hash: current.hash, acknowledged: acknowledgements.get(identity) === current.hash,
      event: structuredClone(current.event),
    }
  }

  async function restore() {
    let text
    try { text = await readFile(target, 'utf8') } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    const lines = text.split(/\r?\n/).filter(Boolean)
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      let record
      try { record = JSON.parse(line) } catch (error) { throw new Error('final_journal_corrupt', { cause: error }) }
      if (record?.type === 'header') {
        if (index !== 0 || journalHeader) throw new Error('final_journal_corrupt')
        journalHeader = normalizeJournalHeader(record)
      } else if (record?.type === 'final') {
        const event = normalizeFinal(record.event)
        const identity = finalIdentity(event)
        const hash = finalHash(event)
        if (record.identity !== identity || record.hash !== hash) throw new Error('final_journal_corrupt')
        const current = finals.get(identity)
        if (current && current.hash !== hash) throw new Error('final_identity_payload_conflict')
        finals.set(identity, { hash, event, order: current?.order ?? ++nextFinalOrder })
      } else if (record?.type === 'ack') {
        const current = finals.get(String(record.identity ?? ''))
        if (!current || current.hash !== record.hash) throw new Error('final_ack_mismatch')
        applyAck(record.identity, record.hash)
      } else if (record?.type === 'shoe_closed') {
        const tableId = canonicalProductionTableId(record.tableId)
        const marker = { tableId, shoe: Number(record.shoe), finalRound: Number(record.finalRound) }
        const hash = markerHash(marker)
        if (!PRODUCTION_TABLE_IDS.includes(tableId) || !Number.isSafeInteger(marker.shoe)
          || !Number.isSafeInteger(marker.finalRound) || marker.finalRound < 1 || record.hash !== hash) {
          throw new Error('final_journal_corrupt')
        }
        const key = `${tableId}:${marker.shoe}`
        const current = closedShoes.get(key)
        if (current && current.hash !== hash) throw new Error('shoe_closed_marker_conflict')
        closedShoes.set(key, { ...marker, hash })
      } else if (record?.type === 'rebind') {
        const identity = String(record.identity ?? '')
        const current = finals.get(identity)
        if (!current || current.hash !== record.hash) throw new Error('final_rebind_mismatch')
        const capturedSource = normalizeTransportSource(record.capturedSource)
        const source = normalizeTransportSource(record.source)
        const event = normalizeFinal({ ...current.event, capturedSource, source })
        if (finalIdentity(event) !== identity || finalHash(event) !== current.hash) throw new Error('final_rebind_mismatch')
        finals.set(identity, { hash: current.hash, event, order: current.order })
      } else if (record?.type === 'cursor_bootstrap') {
        try { applyCursorBootstrap(record) } catch (error) { throw new Error('final_journal_corrupt', { cause: error }) }
      } else {
        throw new Error('final_journal_corrupt')
      }
    }
  }

  function applyAck(identity, hash) {
    acknowledgements.set(identity, hash)
    const final = finals.get(identity)
    const event = final.event
    const tableId = canonicalProductionTableId(event.tableId)
    const current = cursors.get(tableId)
    const candidate = { shoe: event.shoe, round: event.round, identity, hash }
    const candidateOrder = Number(final.order)
    if (!current || identity === current.identity) {
      cursors.set(tableId, candidate)
      cursorOrders.set(tableId, candidateOrder)
      return
    }
    if (Number(event.shoe) === Number(current.shoe)) {
      if (Number(event.round) > Number(current.round)) {
        cursors.set(tableId, candidate)
        cursorOrders.set(tableId, candidateOrder)
      }
      return
    }
    const currentOrder = Number(cursorOrders.get(tableId))
    if (Number.isSafeInteger(currentOrder) && Number.isSafeInteger(candidateOrder) && candidateOrder < currentOrder) return
    if (current.origin === 'snapshot-pusher-exact-ack-cursor' && Number(event.round) !== 1) return
    const retired = retiredCursorShoes.get(tableId) ?? []
    if (retired.includes(Number(event.shoe))) return
    const currentFinal = finals.get(current.identity)
    const sourceOrder = compareFinalSourceChronology(event, currentFinal?.event)
    if (sourceOrder != null && sourceOrder < 0) return
    retired.push(Number(current.shoe))
    if (retired.length > 64) retired.splice(0, retired.length - 64)
    retiredCursorShoes.set(tableId, retired)
    cursors.set(tableId, candidate)
    cursorOrders.set(tableId, candidateOrder)
  }

  function compareFinalSourceChronology(candidateEvent, currentEvent) {
    const candidate = candidateEvent?.capturedSource ?? candidateEvent?.source
    const current = currentEvent?.capturedSource ?? currentEvent?.source
    if (!candidate || !current || candidate.mode !== current.mode || candidate.ownerId !== current.ownerId) return null
    const candidateEpoch = Number(candidate.epoch)
    const currentEpoch = Number(current.epoch)
    const candidateSequence = Number(candidate.sequence)
    const currentSequence = Number(current.sequence)
    if (![candidateEpoch, currentEpoch, candidateSequence, currentSequence].every(Number.isSafeInteger)) return null
    if (candidateEpoch !== currentEpoch) return candidateEpoch < currentEpoch ? -1 : 1
    if (candidateSequence === currentSequence) return 0
    return candidateSequence < currentSequence ? -1 : 1
  }

  function applyCursorBootstrap(record) {
    if (record?.origin !== 'snapshot-pusher-exact-ack-cursor' || !Array.isArray(record.cursors) || record.cursors.length === 0) {
      throw new Error('cursor_bootstrap_invalid')
    }
    const seen = new Set()
    for (const raw of record.cursors) {
      const cursor = normalizeBootstrapCursor(raw)
      if (seen.has(cursor.tableId) || cursors.has(cursor.tableId)) throw new Error('cursor_bootstrap_conflict')
      seen.add(cursor.tableId)
      cursors.set(cursor.tableId, {
        shoe: cursor.shoe,
        round: cursor.round,
        identity: cursor.identity,
        origin: record.origin,
      })
      cursorOrders.set(cursor.tableId, 0)
    }
  }

  async function appendRecord(record) {
    await appendRecords([record])
  }

  async function appendRecords(records) {
    if (!Array.isArray(records) || records.length === 0) return
    await mkdir(path.dirname(target), { recursive: true })
    const handle = await open(target, 'a', 0o600)
    try {
      await handle.writeFile(records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  function serialize(operation) {
    const current = tail.then(operation)
    tail = current.catch(() => {})
    return current
  }

  return { append, ack, ackMany, closeShoe, rebindPending, writeHeader, bootstrapFromSnapshotPusherCursor, pending, cursor, status, header: () => journalHeader && structuredClone(journalHeader) }
}

export function finalIdentity(event = {}) {
  return `${canonicalProductionTableId(event.tableId)}:${Number(event.shoe)}:${Number(event.round)}`
}

export function finalHash(event = {}) {
  const payload = {
    tableId: canonicalProductionTableId(event.tableId),
    shoe: Number(event.shoe),
    round: Number(event.round),
    winner: event.winner,
    rawResult: event.rawResult,
    sourceAction: event.sourceAction,
    final: event.final === true,
  }
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

export function markerHash(marker = {}) {
  return crypto.createHash('sha256').update(JSON.stringify({
    tableId: canonicalProductionTableId(marker.tableId),
    shoe: Number(marker.shoe),
    finalRound: Number(marker.finalRound),
  })).digest('hex')
}

function normalizeFinal(event = {}) {
  const tableId = canonicalProductionTableId(event.tableId)
  const shoe = Number(event.shoe)
  const round = Number(event.round)
  if (!PRODUCTION_TABLE_IDS.includes(tableId)
    || !Number.isSafeInteger(shoe)
    || !Number.isSafeInteger(round) || round < 1
    || event.final !== true
    || !isVerifiedFinalRoundAction(event.sourceAction)
    || !isExactTenRawResult(event.rawResult)
    || !['banker', 'player', 'tie'].includes(event.winner)) throw new Error('final_event_invalid')
  const source = event.source
  if (!source || !['api', 'browser', 'replay', 'backup'].includes(source.mode)
    || !String(source.ownerId ?? '')
    || !Number.isSafeInteger(Number(source.epoch)) || Number(source.epoch) < 1
    || !String(source.fence ?? '')
    || !Number.isSafeInteger(Number(source.sequence)) || Number(source.sequence) < 1) throw new Error('final_source_invalid')
  return structuredClone({ ...event, tableId, shoe, round, rawResult: event.rawResult.map(Number), source: { ...source, epoch: Number(source.epoch), sequence: Number(source.sequence) } })
}

function normalizeTransportSource(source = {}) {
  const normalized = {
    mode: String(source.mode ?? ''), ownerId: String(source.ownerId ?? ''),
    epoch: Number(source.epoch), fence: String(source.fence ?? ''), sequence: Number(source.sequence),
  }
  if (!['api', 'browser', 'replay', 'backup'].includes(normalized.mode) || !normalized.ownerId
    || !Number.isSafeInteger(normalized.epoch) || normalized.epoch < 1 || !normalized.fence
    || !Number.isSafeInteger(normalized.sequence) || normalized.sequence < 1) throw new Error('final_source_invalid')
  return normalized
}

function sameTransportOwner(source, target) {
  if (!source || !target) return false
  return source.mode === target.mode && source.ownerId === target.ownerId
    && Number(source.epoch) === Number(target.epoch) && source.fence === target.fence
}

function normalizeJournalHeader(value = {}) {
  const sessionFingerprint = String(value.sessionFingerprint ?? '')
  const ownerId = String(value.ownerId ?? '')
  if (!/^[a-f0-9]{64}$/.test(sessionFingerprint) || !ownerId.trim()) throw new Error('final_journal_header_invalid')
  return { sessionFingerprint, ownerId }
}

function normalizeSnapshotPusherAckCursors(value = {}) {
  if (Number(value.version) !== 3 || typeof value.initialized !== 'boolean'
    || !Array.isArray(value.observedRoundKeys) || !Array.isArray(value.acknowledgedRoundKeys)) {
    throw new Error('snapshot_pusher_exact_ack_cursor_invalid')
  }
  const observed = new Set(value.observedRoundKeys.map((identity) => normalizeBootstrapCursor({ identity }).identity))
  if (value.acknowledgedRoundKeys.length === 0) {
    if (observed.size > 0) throw new Error('snapshot_pusher_exact_ack_cursor_unproven')
    return []
  }
  const highest = new Map()
  for (const identityValue of value.acknowledgedRoundKeys) {
    const cursor = normalizeBootstrapCursor({ identity: identityValue })
    highest.set(cursor.tableId, cursor)
  }
  return [...highest.values()].sort((left, right) => left.tableId.localeCompare(right.tableId))
}

function normalizeBootstrapCursor(value = {}) {
  const identity = String(value.identity ?? '')
  const match = /^([^:]+):(\d+):(\d+)$/.exec(identity)
  if (!match) throw new Error('snapshot_pusher_exact_ack_cursor_invalid')
  const tableId = canonicalProductionTableId(match[1])
  const shoe = Number(match[2])
  const round = Number(match[3])
  if (!PRODUCTION_TABLE_IDS.includes(tableId) || !Number.isSafeInteger(shoe) || shoe < 1
    || !Number.isSafeInteger(round) || round < 1 || identity !== `${tableId}:${shoe}:${round}`) {
    throw new Error('snapshot_pusher_exact_ack_cursor_invalid')
  }
  return { tableId, shoe, round, identity }
}
